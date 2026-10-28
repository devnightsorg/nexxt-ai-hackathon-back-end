import { z } from 'zod';
import { config } from '../../config/config';
import { simulate } from '../../finance/projection';
import { CatalogProduct } from '../../products/catalog.types';
import { addCitation } from '../turn-state';
import { AgentDeps, defineTool, ToolError } from './types';
import { amountSchema } from './schemas';

export async function findProduct(deps: AgentDeps, slug: string): Promise<CatalogProduct> {
  try {
    return await deps.products.get(slug);
  } catch {
    throw new ToolError(`Produsul "${slug}" nu există în catalog`);
  }
}

export const listProducts = defineTool({
  name: 'list_products',
  description: 'Lists Raiffeisen catalog products (optionally by category or goodFor tag) with summary, rate/return and minimum amount.',
  scope: null,
  schema: z.object({ category: z.string().max(60).optional(), goodFor: z.string().max(60).optional() }),
  handler: async (ctx, args) => {
    const products = await ctx.deps.products.list({ category: args.category, goodFor: args.goodFor });
    return products.map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      summary: p.summary,
      interestRateOrReturn: p.interest_rate_or_return,
      minAmount: p.min_amount,
      riskLevel: p.risk_level,
      goodFor: p.good_for,
    }));
  },
});

export const getProduct = defineTool({
  name: 'get_product',
  description: 'Full catalog details of one product by slug (features, rates, fees, eligibility, terms).',
  scope: null,
  schema: z.object({ slug: z.string().min(1).max(120) }),
  handler: (ctx, args) => findProduct(ctx.deps, args.slug),
});

export const searchKnowledgeBase = defineTool({
  name: 'search_knowledge_base',
  description:
    'Searches official Raiffeisen documents (fees, rules, conditions, FAQs). Use it to ground any statement about fees, rules or conditions.',
  scope: null,
  schema: z.object({
    query: z.string().min(1).max(500),
    category: z.string().max(60).optional(),
    productSlug: z.string().max(120).optional(),
  }),
  handler: async (ctx, args) => {
    const hits = await ctx.deps.knowledge.search(args.query, {
      k: 5,
      category: args.category,
      productSlug: args.productSlug,
    });
    for (const h of hits) addCitation(ctx.turn, { title: h.title, sourceUrl: h.sourceUrls[0] ?? null });
    return hits.map((h) => ({
      title: h.title,
      category: h.category,
      productSlug: h.productSlug,
      sourceUrl: h.sourceUrls[0] ?? null,
      content: h.content,
    }));
  },
});

export const simulateProduct = defineTool({
  name: 'simulate_product',
  description:
    'Deterministic projection for a savings/deposit/investment/pension product: interest, tax, final amount and months to reach a goal target.',
  scope: null,
  schema: z.object({
    productSlug: z.string().min(1).max(120),
    amount: amountSchema,
    termMonths: z.number().int().min(1).max(600).optional(),
    monthlyContribution: z.number().min(0).optional(),
    goalTarget: amountSchema.optional(),
  }),
  handler: async (ctx, args) => {
    const product = await findProduct(ctx.deps, args.productSlug);
    return simulate({
      product,
      amount: args.amount,
      termMonths: args.termMonths,
      monthlyContribution: args.monthlyContribution,
      goalTarget: args.goalTarget,
      interestTaxRate: config().INTEREST_TAX_RATE,
    });
  },
});

export const CATALOG_TOOLS = [listProducts, getProduct, searchKnowledgeBase, simulateProduct];
