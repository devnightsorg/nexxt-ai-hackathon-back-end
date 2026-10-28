import type { CatalogProduct } from '../../products/catalog.types';
import { newTurnState } from '../turn-state';
import { listProducts, simulateProduct } from './catalog.tools';
import { recommendProduct } from './offers.tools';
import type { AgentToolContext } from './types';
import { ToolError } from './types';

const base = {
  summary: '',
  key_features: [],
  fees: [],
  eligibility: [],
  min_amount: null,
  currencies: ['RON'],
  terms: [],
  risk_level: null,
  good_for: [],
  source_urls: ['https://example.ro'],
  retrieved_at: '2026-10-01',
};
const rate = (value: number) => ({ value, unit: '%/an', conditions: '', as_of: '2026-10-01' });
const savingBox = { ...base, slug: 'savingbox', name: 'SavingBox', category: 'savings_account', interest_rate_or_return: rate(10), openable_via_transfer: false } as CatalogProduct;
const superAcces = { ...base, slug: 'super-acces', name: 'Super Acces', category: 'savings_account', interest_rate_or_return: rate(2) } as CatalogProduct;
const catalog = [savingBox, superAcces];

const ctx = {
  principal: { userId: 'u1' },
  turn: newTurnState(),
  deps: {
    products: {
      get: async (slug: string) => catalog.find((p) => p.slug === slug)!,
      list: async () => catalog,
    },
  },
} as unknown as AgentToolContext;

describe('catalog tools and openability', () => {
  it('list_products flags products the customer cannot be moved into', async () => {
    const out = (await listProducts.handler(ctx, {})) as { slug: string; openable: boolean; note?: string }[];
    expect(out.find((p) => p.slug === 'savingbox')).toMatchObject({ openable: false, note: expect.stringContaining('openable: false') });
    expect(out.find((p) => p.slug === 'super-acces')).toMatchObject({ openable: true });
    expect(out.find((p) => p.slug === 'super-acces')?.note).toBeUndefined();
  });

  it('simulate_product and recommend_product refuse non-openable savings products', async () => {
    await expect(simulateProduct.handler(ctx, { productSlug: 'savingbox', amount: 1000, monthlyContribution: 500 })).rejects.toBeInstanceOf(ToolError);
    await expect(recommendProduct.handler(ctx, { productSlug: 'savingbox', why: 'x' })).rejects.toBeInstanceOf(ToolError);
    await expect(simulateProduct.handler(ctx, { productSlug: 'super-acces', amount: 1000 })).resolves.toBeDefined();
  });
});
