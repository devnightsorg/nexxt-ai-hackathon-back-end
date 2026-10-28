import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash, randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import * as path from 'path';
import { config } from '../config/config';
import { LlmService } from '../llm/llm.service';
import { PrismaService } from '../prisma/prisma.service';
import { chunkMarkdown } from './chunker';

export interface KbHit {
  chunkId: string;
  documentId: string;
  title: string;
  category: string;
  productSlug: string | null;
  sourceUrls: string[];
  content: string;
  score: number;
}

export interface IngestSummary {
  documents: number;
  chunks: number;
  embedded: number;
  skipped: number;
}

export interface SearchOptions {
  k?: number;
  category?: string;
  productSlug?: string;
}

export interface AddDocumentInput {
  title: string;
  category: string;
  productSlug?: string;
  sourceUrls?: string[];
  content: string;
}

interface HitRow {
  chunkId: string;
  documentId: string;
  title: string;
  category: string;
  productSlug: string | null;
  sourceUrls: string[] | null;
  content: string;
  score: number | string | null;
}

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');
const vectorLiteral = (v: number[]): string => `[${v.join(',')}]`;

function toStringArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string' && x.trim() !== '');
  if (typeof v === 'string' && v.trim()) return [v.trim()];
  return [];
}

async function listMarkdown(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await listMarkdown(full)));
    else if (e.isFile() && e.name.toLowerCase().endsWith('.md')) out.push(full);
  }
  return out.sort();
}

@Injectable()
export class KnowledgeService {
  private readonly logger = new Logger(KnowledgeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly llm: LlmService,
  ) {}

  /** Idempotent ingestion of every markdown file under `dir` (content-hash based). */
  async ingestDirectory(dir = `${config().KNOWLEDGE_DIR}/docs`): Promise<IngestSummary> {
    const summary: IngestSummary = { documents: 0, chunks: 0, embedded: 0, skipped: 0 };
    let files: string[];
    try {
      files = await listMarkdown(dir);
    } catch (err) {
      this.logger.warn(`Knowledge dir ${dir} unreadable: ${(err as Error).message}`);
      return summary;
    }
    const slugs = new Set((await this.prisma.product.findMany({ select: { slug: true } })).map((p) => p.slug));

    for (const file of files) {
      summary.documents++;
      const raw = await fs.readFile(file, 'utf8');
      const contentHash = sha256(raw);
      const sourcePath = path.relative(process.cwd(), file).split(path.sep).join('/');
      const existing = await this.prisma.kbDocument.findUnique({ where: { sourcePath } });

      if (existing && existing.contentHash === contentHash) {
        const pending = await this.unembeddedChunks(existing.id);
        if (pending.length === 0) {
          summary.skipped++;
          continue;
        }
        summary.embedded += await this.embedChunks(pending);
        continue;
      }

      const { meta, chunks } = chunkMarkdown(raw);
      const base = path.basename(file, path.extname(file));
      const metaSlug = typeof meta.product_slug === 'string' && meta.product_slug.trim() ? meta.product_slug.trim() : null;
      const productSlug = metaSlug ?? (slugs.has(base) ? base : null);
      const title =
        (typeof meta.title === 'string' && meta.title.trim()) ||
        chunks[0]?.split('\n')[0].split(' › ')[0] ||
        base;
      const category = (typeof meta.category === 'string' && meta.category.trim()) || (productSlug ? 'product' : 'general');
      const sourceUrls = toStringArray(meta.source_urls ?? meta.sourceUrls ?? meta.source_url ?? meta.sources);

      const docId = existing?.id ?? randomUUID();
      const rows = chunks.map((content, index) => ({ id: randomUUID(), documentId: docId, index, content }));
      await this.prisma.$transaction([
        this.prisma.kbDocument.upsert({
          where: { sourcePath },
          create: { id: docId, sourcePath, title, category, productSlug, sourceUrls, contentHash, content: raw },
          update: { title, category, productSlug, sourceUrls, contentHash, content: raw },
        }),
        this.prisma.kbChunk.deleteMany({ where: { documentId: docId } }),
        this.prisma.kbChunk.createMany({ data: rows }),
      ]);
      summary.chunks += rows.length;
      summary.embedded += await this.embedChunks(rows);
    }
    this.logger.log(
      `Knowledge ingest: ${summary.documents} documents, ${summary.chunks} chunks written, ${summary.embedded} embedded, ${summary.skipped} skipped`,
    );
    return summary;
  }

  /** Adds a document through the API (sourcePath `api/<uuid>.md`). */
  async addDocument(i: AddDocumentInput): Promise<{ id: string; chunks: number }> {
    const id = randomUUID();
    const { chunks } = chunkMarkdown(i.content, { title: i.title });
    const rows = chunks.map((content, index) => ({ id: randomUUID(), documentId: id, index, content }));
    await this.prisma.$transaction([
      this.prisma.kbDocument.create({
        data: {
          id,
          sourcePath: `api/${id}.md`,
          title: i.title,
          category: i.category,
          productSlug: i.productSlug ?? null,
          sourceUrls: i.sourceUrls ?? [],
          contentHash: sha256(i.content),
          content: i.content,
        },
      }),
      this.prisma.kbChunk.createMany({ data: rows }),
    ]);
    await this.embedChunks(rows);
    return { id, chunks: rows.length };
  }

  /** Cosine search over embedded chunks; full-text fallback when the query can't be embedded or nothing is embedded. */
  async search(query: string, o: SearchOptions = {}): Promise<KbHit[]> {
    const k = Math.min(Math.max(Math.trunc(o.k ?? 5) || 5, 1), 50);
    const q = (query ?? '').trim();
    if (!q) return [];
    const filters = Prisma.sql`
      AND (${o.category ?? null}::text IS NULL OR d.category = ${o.category ?? null})
      AND (${o.productSlug ?? null}::text IS NULL OR d."productSlug" = ${o.productSlug ?? null})`;

    let vector: number[] | null = null;
    try {
      [vector] = await this.llm.embed([q]);
    } catch (err) {
      this.logger.warn(`Query embedding failed, using full-text search: ${(err as Error).message}`);
    }

    if (vector) {
      const lit = vectorLiteral(vector);
      const rows = await this.prisma.$queryRaw<HitRow[]>`
        SELECT c.id AS "chunkId", c."documentId", d.title, d.category, d."productSlug", d."sourceUrls", c.content,
               1 - (c.embedding <=> ${lit}::vector) AS score
        FROM "KbChunk" c JOIN "KbDocument" d ON d.id = c."documentId"
        WHERE c.embedding IS NOT NULL ${filters}
        ORDER BY c.embedding <=> ${lit}::vector
        LIMIT ${k}`;
      if (rows.length > 0) return rows.map(toHit);
    }

    const plain = await this.prisma.$queryRaw<HitRow[]>`
      SELECT c.id AS "chunkId", c."documentId", d.title, d.category, d."productSlug", d."sourceUrls", c.content,
             ts_rank(to_tsvector('simple', c.content), plainto_tsquery('simple', ${q})) AS score
      FROM "KbChunk" c JOIN "KbDocument" d ON d.id = c."documentId"
      WHERE to_tsvector('simple', c.content) @@ plainto_tsquery('simple', ${q}) ${filters}
      ORDER BY score DESC
      LIMIT ${k}`;
    if (plain.length > 0) return plain.map(toHit);

    // Looser fallback: any word, prefix match (natural-language questions rarely match every word).
    const words = q.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [];
    if (words.length === 0) return [];
    const tsq = [...new Set(words)].map((w) => `${w}:*`).join(' | ');
    const loose = await this.prisma.$queryRaw<HitRow[]>`
      SELECT c.id AS "chunkId", c."documentId", d.title, d.category, d."productSlug", d."sourceUrls", c.content,
             ts_rank(to_tsvector('simple', c.content), to_tsquery('simple', ${tsq})) AS score
      FROM "KbChunk" c JOIN "KbDocument" d ON d.id = c."documentId"
      WHERE to_tsvector('simple', c.content) @@ to_tsquery('simple', ${tsq}) ${filters}
      ORDER BY score DESC
      LIMIT ${k}`;
    return loose.map(toHit);
  }

  private unembeddedChunks(documentId: string): Promise<{ id: string; content: string }[]> {
    return this.prisma.$queryRaw<{ id: string; content: string }[]>`
      SELECT id, content FROM "KbChunk" WHERE "documentId" = ${documentId} AND embedding IS NULL ORDER BY index`;
  }

  /** Embeds and stores vectors; on failure leaves embeddings NULL (retried next ingest). Returns count embedded. */
  private async embedChunks(rows: { id: string; content: string }[]): Promise<number> {
    if (rows.length === 0) return 0;
    let vectors: number[][];
    try {
      vectors = await this.llm.embed(rows.map((r) => r.content));
    } catch (err) {
      this.logger.warn(`Embedding ${rows.length} chunks failed (left NULL): ${(err as Error).message}`);
      return 0;
    }
    for (let i = 0; i < rows.length; i++) {
      await this.prisma.$executeRaw`UPDATE "KbChunk" SET embedding = ${vectorLiteral(vectors[i])}::vector WHERE id = ${rows[i].id}`;
    }
    return rows.length;
  }
}

function toHit(r: HitRow): KbHit {
  return {
    chunkId: r.chunkId,
    documentId: r.documentId,
    title: r.title,
    category: r.category,
    productSlug: r.productSlug,
    sourceUrls: r.sourceUrls ?? [],
    content: r.content,
    score: Math.round(Number(r.score ?? 0) * 10000) / 10000,
  };
}
