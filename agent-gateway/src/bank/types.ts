import { z } from 'zod';
import { PRODUCT_TYPES } from '../types.js';

// Contract documented in docs/BANK_ADAPTER_CONTRACT.md. All money in integer euro cents.

/** Bank-controlled distribution eligibility - not a product type, not a permission. */
export const DISTRIBUTION_CHANNELS = ['human_only', 'agent_only', 'both'] as const;
export type DistributionChannel = (typeof DISTRIBUTION_CHANNELS)[number];

export const offerSchema = z.object({
  product_id: z.string().min(1).max(64),
  product_type: z.enum(PRODUCT_TYPES),
  title: z.string().max(200),
  rate_bps: z.number().int().min(0),
  term_months: z.number().int().min(0),
  min_amount_cents: z.number().int().min(0),
  description: z.string().max(2000),
  // Missing or unknown values parse as undefined ("unclassified") instead of breaking the whole
  // catalog. Unclassified offers are never shown to or executable by external agents (fail closed).
  distribution_channel: z.enum(DISTRIBUTION_CHANNELS).optional().catch(undefined),
});
export type Offer = z.infer<typeof offerSchema>;

export function isAgentChannel(offer: Offer): boolean {
  return offer.distribution_channel === 'agent_only' || offer.distribution_channel === 'both';
}

export const simulationSchema = z.object({
  product_id: z.string(),
  amount_cents: z.number().int(),
  term_months: z.number().int(),
  rate_bps: z.number().int(),
  expected_interest_cents: z.number().int(),
  maturity_date: z.string(),
});
export type Simulation = z.infer<typeof simulationSchema>;

export const executionSchema = z.object({
  deposit_id: z.string().min(1),
  status: z.string().min(1),
});
export type Execution = z.infer<typeof executionSchema>;

export interface SimulateRequest {
  product_id: string;
  amount_cents: number;
  term_months: number;
}

export interface ExecuteRequest {
  product_id: string;
  amount_cents: number;
  idempotency_key: string;
  agent_id: string;
  owner_id: string;
  mandate_id: string;
}

export interface BankAdapter {
  readonly kind: 'mock' | 'http';
  listOffers(): Promise<Offer[]>;
  simulateDeposit(req: SimulateRequest): Promise<Simulation>;
  /** Called only after the gateway policy allowed it. MOCK - no real money moves. */
  executeDeposit(req: ExecuteRequest): Promise<Execution>;
}
