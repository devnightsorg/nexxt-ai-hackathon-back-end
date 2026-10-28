import { describe, expect, it } from 'vitest';
import { MOCK_OFFERS, simpleInterestCents } from '../src/bank/mock.js';
import { checkExecutionLimits, checkMandate, checkProduct, checkTerm } from '../src/policy.js';
import type { Mandate, Principal } from '../src/types.js';

const now = new Date('2026-10-28T10:00:00Z');
const principal: Principal = { agent_id: 'agent-001', owner_id: 'customer-001', operator_id: 'op', request_id: 'r' };
const mandate: Mandate = {
  mandate_id: 'mandate-001',
  agent_id: 'agent-001',
  owner_id: 'customer-001',
  allowed_actions: ['get_offers', 'simulate_deposit', 'execute_deposit_mock'],
  allowed_products: ['term_deposit'],
  currency: 'EUR',
  per_action_limit_cents: 200_000,
  aggregate_limit_cents: 500_000,
  human_approval_above_cents: 150_000,
  issued_at: '2026-10-28T09:00:00.000Z',
  expires_at: '2026-11-04T09:00:00.000Z',
  customer_approval: { approved_by: 'customer-001', approved_at: '2026-10-28T09:00:00.000Z', method: 'simulated' },
  bank_signature: 'x',
  status: 'active',
  consumed_cents: 0,
};
const base = { action: 'execute_deposit_mock' as const, principal, mandate, mandateSignatureValid: true, now };
const offer = (id: string) => MOCK_OFFERS.find((o) => o.product_id === id);

describe('checkMandate', () => {
  it('allows an active, bound, unexpired mandate', () => {
    expect(checkMandate(base)).toEqual({ allow: true });
  });
  it.each([
    ['no mandate', { mandate: undefined }, 'NO_ACTIVE_MANDATE'],
    ['bad signature', { mandateSignatureValid: false }, 'NO_ACTIVE_MANDATE'],
    ['other owner', { principal: { ...principal, owner_id: 'customer-002' } }, 'NO_ACTIVE_MANDATE'],
    ['revoked', { mandate: { ...mandate, status: 'revoked' as const } }, 'NO_ACTIVE_MANDATE'],
    ['expired', { now: new Date('2026-11-05T00:00:00Z') }, 'MANDATE_EXPIRED'],
    ['action not allowed', { mandate: { ...mandate, allowed_actions: ['get_offers' as const] } }, 'SCOPE_DENIED'],
  ])('%s -> %s', (_name, override, code) => {
    expect(checkMandate({ ...base, ...override })).toMatchObject({ allow: false, code });
  });
});

describe('checkProduct', () => {
  it('product type comes from the bank catalog', () => {
    expect(checkProduct(mandate, 'td-3m', offer('td-3m')).allow).toBe(true);
    expect(checkProduct(mandate, 'ins-life', offer('ins-life'))).toMatchObject({ allow: false, code: 'SCOPE_DENIED' });
    expect(checkProduct(mandate, 'nope', undefined)).toMatchObject({ allow: false, code: 'SCOPE_DENIED' });
  });

  it('distribution channel: human_only and unclassified are never agent-eligible', () => {
    expect(checkProduct(mandate, 'td-6m-branch', offer('td-6m-branch'))).toMatchObject({ allow: false, code: 'SCOPE_DENIED' });
    expect(checkProduct(mandate, 'td-3m-agent', offer('td-3m-agent')).allow).toBe(true);
    const unclassified = { ...offer('td-3m')!, distribution_channel: undefined };
    expect(checkProduct(mandate, 'td-3m', unclassified)).toMatchObject({ allow: false, code: 'SCOPE_DENIED' });
  });
});

describe('checkTerm', () => {
  it('fixed-term products only accept their catalog term', () => {
    expect(checkTerm(offer('td-3m')!, 12)).toMatchObject({ allow: false, code: 'INVALID_INPUT' });
    expect(checkTerm(offer('td-3m')!, 3)).toEqual({ allow: true });
    expect(checkTerm(offer('td-3m')!, undefined)).toEqual({ allow: true });
    expect(checkTerm(offer('sav-flex')!, 7)).toEqual({ allow: true });
  });
});

describe('checkExecutionLimits', () => {
  it('per-action, aggregate and approval thresholds', () => {
    expect(checkExecutionLimits(mandate, 150_000)).toEqual({ allow: true });
    expect(checkExecutionLimits(mandate, 150_001)).toMatchObject({ code: 'APPROVAL_REQUIRED' });
    expect(checkExecutionLimits(mandate, 200_001)).toMatchObject({ code: 'LIMIT_EXCEEDED' });
    expect(checkExecutionLimits({ ...mandate, consumed_cents: 400_000 }, 100_000)).toEqual({ allow: true });
    expect(checkExecutionLimits({ ...mandate, consumed_cents: 400_001 }, 100_000)).toMatchObject({ code: 'LIMIT_EXCEEDED' });
  });
});

describe('money', () => {
  it('interest is integer cents, rounded down', () => {
    expect(simpleInterestCents(100_000, 450, 3)).toBe(1125);
    expect(simpleInterestCents(333, 450, 3)).toBe(3);
  });
});
