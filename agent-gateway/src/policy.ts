import { isAgentChannel, type Offer } from './bank/types.js';
import type { Action, ErrorCode, Mandate, Principal } from './types.js';

// Deterministic, side-effect free. Inputs come from verified credentials and server-side stores;
// nothing an agent, model or bank offer text says can change the outcome.

export type Decision = { allow: true } | { allow: false; code: ErrorCode; reason: string };

const deny = (code: ErrorCode, reason: string): Decision => ({ allow: false, code, reason });
const eur = (cents: number) => `EUR ${(cents / 100).toFixed(2)}`;

export interface MandateCheck {
  action: Action;
  principal: Principal;
  mandate: Mandate | undefined;
  mandateSignatureValid: boolean;
  now: Date;
}

export function checkMandate({ action, principal, mandate, mandateSignatureValid, now }: MandateCheck): Decision {
  if (!mandate) return deny('NO_ACTIVE_MANDATE', 'no mandate issued for this agent');
  if (!mandateSignatureValid) return deny('NO_ACTIVE_MANDATE', `${mandate.mandate_id} bank signature invalid`);
  if (mandate.agent_id !== principal.agent_id || mandate.owner_id !== principal.owner_id) {
    return deny('NO_ACTIVE_MANDATE', `${mandate.mandate_id} is not bound to this agent and owner`);
  }
  if (mandate.status !== 'active') {
    return deny('NO_ACTIVE_MANDATE', `${mandate.mandate_id} ${mandate.status}: ${mandate.status_reason ?? ''}`.trim());
  }
  if (Date.parse(mandate.expires_at) <= now.getTime()) {
    return deny('MANDATE_EXPIRED', `${mandate.mandate_id} expired at ${mandate.expires_at}`);
  }
  if (!mandate.allowed_actions.includes(action)) {
    return deny('SCOPE_DENIED', `action ${action} not allowed by ${mandate.mandate_id}`);
  }
  return { allow: true };
}

/**
 * Product scope check - distribution channel and product_type come from the bank catalog, never
 * from the agent. Unknown, human-only and unclassified products get the same answer, so guessing
 * IDs does not reveal the human-only catalog.
 */
export function checkProduct(mandate: Mandate, productId: string, offer: Offer | undefined): Decision {
  if (!offer || !isAgentChannel(offer)) {
    return deny('SCOPE_DENIED', `product ${productId} is not available in the agent channel`);
  }
  if (!mandate.allowed_products.includes(offer.product_type)) {
    return deny('SCOPE_DENIED', `product type ${offer.product_type} not allowed (allowed: ${mandate.allowed_products.join(', ')})`);
  }
  return { allow: true };
}

export function checkAmountMinimum(offer: Offer, amountCents: number): Decision {
  if (amountCents < offer.min_amount_cents) {
    return deny('INVALID_INPUT', `amount below product minimum ${eur(offer.min_amount_cents)}`);
  }
  return { allow: true };
}

/** Fixed-term products (term_months > 0) can only be simulated with their catalog term. */
export function checkTerm(offer: Offer, requestedTermMonths: number | undefined): Decision {
  if (offer.term_months > 0 && requestedTermMonths !== undefined && requestedTermMonths !== offer.term_months) {
    return deny('INVALID_INPUT', `${offer.product_id} has a fixed term of ${offer.term_months} months, got ${requestedTermMonths}`);
  }
  return { allow: true };
}

/** Execution consumes limits; simulation does not call this. */
export function checkExecutionLimits(mandate: Mandate, amountCents: number): Decision {
  if (amountCents > mandate.per_action_limit_cents) {
    return deny('LIMIT_EXCEEDED', `${eur(amountCents)} exceeds per-action limit ${eur(mandate.per_action_limit_cents)}`);
  }
  const remaining = mandate.aggregate_limit_cents - mandate.consumed_cents;
  if (amountCents > remaining) {
    return deny('LIMIT_EXCEEDED', `${eur(amountCents)} exceeds remaining aggregate limit ${eur(remaining)}`);
  }
  if (amountCents > mandate.human_approval_above_cents) {
    return deny(
      'APPROVAL_REQUIRED',
      `${eur(amountCents)} is above ${eur(mandate.human_approval_above_cents)} - explicit customer approval required`,
    );
  }
  return { allow: true };
}
