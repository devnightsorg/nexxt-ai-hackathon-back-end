export const ACTIONS = ['get_offers', 'simulate_deposit', 'execute_deposit_mock'] as const;
export type Action = (typeof ACTIONS)[number];

export const PRODUCT_TYPES = ['term_deposit', 'savings', 'insurance'] as const;
export type ProductType = (typeof PRODUCT_TYPES)[number];

export type ErrorCode =
  | 'UNAUTHENTICATED'
  | 'INVALID_PASSPORT'
  | 'UNKNOWN_AGENT'
  | 'AGENT_NOT_APPROVED'
  | 'AGENT_REVOKED'
  | 'REPLAY_DETECTED'
  | 'NO_ACTIVE_MANDATE'
  | 'MANDATE_EXPIRED'
  | 'SCOPE_DENIED'
  | 'LIMIT_EXCEEDED'
  | 'APPROVAL_REQUIRED'
  | 'IDEMPOTENCY_CONFLICT'
  | 'INVALID_INPUT'
  | 'BANK_ERROR';

/** Signed by the demo bank issuer. Proves a registered identity, NOT authority to move money. */
export interface Passport {
  agent_id: string;
  owner_id: string;
  operator_id: string;
  public_key: string;
  issuer: string;
  issued_at: string;
  expires_at: string;
  status: 'active';
  issuer_signature: string;
}

export interface AgentRecord {
  agent_id: string;
  owner_id: string;
  operator_id: string;
  public_key: string;
  status: 'pending' | 'active' | 'revoked';
  created_at: string;
  updated_at: string;
  status_reason?: string;
}

/** Bank-issued, customer-approved authority. All money in integer euro cents. */
export interface Mandate {
  mandate_id: string;
  agent_id: string;
  owner_id: string;
  allowed_actions: Action[];
  allowed_products: ProductType[];
  currency: 'EUR';
  per_action_limit_cents: number;
  aggregate_limit_cents: number;
  human_approval_above_cents: number;
  issued_at: string;
  expires_at: string;
  customer_approval: { approved_by: string; approved_at: string; method: 'simulated' };
  bank_signature: string;
  // mutable state below - not covered by bank_signature
  status: 'active' | 'revoked' | 'superseded';
  consumed_cents: number;
  status_changed_at?: string;
  status_reason?: string;
}

/** Identity derived only from verified credentials - never from tool arguments. */
export interface Principal {
  agent_id: string;
  owner_id: string;
  operator_id: string;
  request_id: string;
}

export interface ToolResult {
  status: 'ok' | 'denied' | 'error';
  data?: unknown;
  error_code?: ErrorCode;
  reason?: string;
  audit_id?: string;
}
