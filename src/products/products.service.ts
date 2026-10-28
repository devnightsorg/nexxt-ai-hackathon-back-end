import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from '../config/config';
import { PrismaService } from '../prisma/prisma.service';
import { CatalogProduct, validateCatalogItem } from './catalog.types';

/** Reads and validates `${dir}/products.json`; throws listing every invalid item. */
export function loadCatalogFrom(dir: string): CatalogProduct[] {
  const file = resolve(dir, 'products.json');
  const data: unknown = JSON.parse(readFileSync(file, 'utf8'));
  if (!Array.isArray(data)) throw new Error(`${file}: expected a JSON array of products`);
  const problems: string[] = [];
  const seen = new Set<string>();
  data.forEach((item: unknown, i) => {
    const errors = validateCatalogItem(item);
    const slug = (item as { slug?: unknown })?.slug;
    if (typeof slug === 'string') {
      if (seen.has(slug)) errors.push('duplicate slug');
      seen.add(slug);
    }
    if (errors.length) problems.push(`#${i} (${String(slug)}): ${errors.join('; ')}`);
  });
  if (problems.length) throw new Error(`Invalid catalog items in ${file}:\n${problems.join('\n')}`);
  return data as CatalogProduct[];
}

@Injectable()
export class ProductsService {
  constructor(private readonly prisma: PrismaService) {}

  loadCatalog(): CatalogProduct[] {
    return loadCatalogFrom(config().KNOWLEDGE_DIR);
  }

  /** Upserts every catalog item; `details` holds the whole item. Returns the number of products synced. */
  async syncCatalog(): Promise<number> {
    const items = this.loadCatalog();
    for (const p of items) {
      const data = {
        name: p.name,
        category: p.category,
        summary: p.summary,
        details: p as unknown as Prisma.InputJsonValue,
        goodFor: p.good_for,
        riskLevel: p.risk_level,
        sourceUrls: p.source_urls,
      };
      await this.prisma.product.upsert({ where: { slug: p.slug }, create: { slug: p.slug, ...data }, update: data });
    }
    return items.length;
  }

  async list(f: { category?: string; goodFor?: string } = {}): Promise<CatalogProduct[]> {
    const where: Prisma.ProductWhereInput = {};
    if (f.category) where.category = f.category;
    if (f.goodFor) where.goodFor = { has: f.goodFor };
    const rows = await this.prisma.product.findMany({ where, orderBy: [{ category: 'asc' }, { slug: 'asc' }] });
    return rows.map((r) => r.details as unknown as CatalogProduct);
  }

  async get(slug: string): Promise<CatalogProduct> {
    const row = await this.prisma.product.findUnique({ where: { slug } });
    if (!row) throw new NotFoundException('Produsul nu există');
    return row.details as unknown as CatalogProduct;
  }

  getAll(): Promise<CatalogProduct[]> {
    return this.list();
  }
}
