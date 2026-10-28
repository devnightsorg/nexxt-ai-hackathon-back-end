import { Prisma } from '@prisma/client';
import { EMBEDDING_DIM, LlmService, LlmUnavailableError } from '../llm/llm.service';
import { PrismaService } from '../prisma/prisma.service';
import { KnowledgeService } from './knowledge.service';

/** Flattens a tagged-template $queryRaw call into SQL text + bound values (nested Prisma.sql fragments included). */
function rendered(call: unknown[]): { sql: string; values: unknown[] } {
  const [strings, ...values] = call as [TemplateStringsArray, ...unknown[]];
  const q = Prisma.sql(strings, ...values);
  return { sql: q.text, values: q.values };
}

const row = {
  chunkId: 'c1',
  documentId: 'd1',
  title: 'Depozit',
  category: 'product',
  productSlug: 'depozit',
  sourceUrls: null,
  content: 'Dobândă 5%',
  score: 0.91234,
};

describe('KnowledgeService.search', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  function setup(embed: jest.Mock, queryRaw: jest.Mock) {
    const prisma = { $queryRaw: queryRaw } as unknown as PrismaService;
    const llm = { embed } as unknown as LlmService;
    return new KnowledgeService(prisma, llm);
  }

  it('vector query only covers documents embedded with the current EMBEDDING_MODEL', async () => {
    process.env.EMBEDDING_MODEL = 'Qwen/Qwen3-Embedding-4B';
    const embed = jest.fn().mockResolvedValue([new Array(EMBEDDING_DIM).fill(0.01)]);
    const queryRaw = jest.fn().mockResolvedValue([row]);
    const hits = await setup(embed, queryRaw).search('dobândă depozit', { k: 3 });

    expect(hits).toEqual([{ ...row, sourceUrls: [], score: 0.9123 }]);
    expect(queryRaw).toHaveBeenCalledTimes(1);
    const { sql, values } = rendered(queryRaw.mock.calls[0]);
    expect(sql).toContain('<=>');
    expect(sql).toMatch(/d\."embeddingModel" = \$\d+/);
    expect(values).toContain('Qwen/Qwen3-Embedding-4B');
  });

  it('no current-model vectors → falls back to full-text', async () => {
    const embed = jest.fn().mockResolvedValue([new Array(EMBEDDING_DIM).fill(0.01)]);
    const queryRaw = jest.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([row]);
    const hits = await setup(embed, queryRaw).search('dobândă');
    expect(hits).toHaveLength(1);
    expect(queryRaw).toHaveBeenCalledTimes(2);
    expect(rendered(queryRaw.mock.calls[1]).sql).toContain('plainto_tsquery');
  });

  it('query embedding unavailable → full-text only', async () => {
    const embed = jest.fn().mockRejectedValue(new LlmUnavailableError('down'));
    const queryRaw = jest.fn().mockResolvedValue([row]);
    await setup(embed, queryRaw).search('dobândă');
    expect(queryRaw).toHaveBeenCalledTimes(1);
    expect(rendered(queryRaw.mock.calls[0]).sql).not.toContain('<=>');
  });
});
