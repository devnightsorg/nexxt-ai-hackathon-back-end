import { z } from 'zod';
import { config } from '../../config/config';
import { Projection, simulate } from '../../finance/projection';
import { creditPrecheck } from '../../offers/credit-precheck';
import { OPENABLE_CATEGORIES } from '../../products/catalog.types';
import { Recommendation } from '../turn-state';
import { defineTool } from './types';
import { amountSchema } from './schemas';
import { findProduct } from './catalog.tools';

const DEFAULT_PROJECTION_AMOUNT = 1000;

export const getPersonalisedOffers = defineTool({
  name: 'get_personalised_offers',
  description: 'Rule-based personalised offers computed by the bank for this user (with projections and reasoning).',
  scope: 'offers:read',
  schema: z.object({}),
  handler: (ctx) => ctx.deps.offers.list(ctx.principal.userId),
});

export const recommendProduct = defineTool({
  name: 'recommend_product',
  description:
    'The ONLY way to recommend a product: records a structured recommendation of a catalog product (by slug) with a short reason; the bank computes the projection.',
  scope: 'offers:read',
  schema: z.object({
    productSlug: z.string().min(1).max(120),
    why: z.string().min(1).max(600),
    suggestedAmount: amountSchema.optional(),
    termMonths: z.number().int().min(1).max(600).optional(),
    monthlyContribution: z.number().min(0).optional(),
  }),
  handler: async (ctx, args) => {
    const product = await findProduct(ctx.deps, args.productSlug);
    let projection: Projection | null = null;
    if (OPENABLE_CATEGORIES.includes(product.category)) {
      projection = simulate({
        product,
        amount: args.suggestedAmount ?? product.min_amount?.value ?? DEFAULT_PROJECTION_AMOUNT,
        termMonths: args.termMonths,
        monthlyContribution: args.monthlyContribution,
        interestTaxRate: config().INTEREST_TAX_RATE,
      });
    }
    const rec: Recommendation = {
      productSlug: product.slug,
      productName: product.name,
      category: product.category,
      why: args.why,
      suggestedAmount: args.suggestedAmount ?? null,
      termMonths: args.termMonths ?? null,
      monthlyContribution: args.monthlyContribution ?? null,
      projection,
    };
    const existing = ctx.turn.recommendations.findIndex((r) => r.productSlug === rec.productSlug);
    if (existing >= 0) ctx.turn.recommendations[existing] = rec;
    else ctx.turn.recommendations.push(rec);
    return { ok: true, recommendation: rec };
  },
});

export const creditPrecheckTool = defineTool({
  name: 'credit_precheck',
  description: 'Indicative debt-to-income (40%) check: maximum monthly installment and, given a rate and term, an indicative maximum loan. Never a credit decision.',
  scope: 'profile:read',
  schema: z.object({
    annualRatePct: z.number().min(0).max(100).optional(),
    termMonths: z.number().int().min(1).max(420).optional(),
  }),
  handler: async (ctx, args) => {
    const snapshot = await ctx.deps.stats.snapshot(ctx.principal.userId);
    return creditPrecheck(snapshot, args);
  },
});

export const OFFERS_TOOLS = [getPersonalisedOffers, recommendProduct, creditPrecheckTool];
