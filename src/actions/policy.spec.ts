import { SCOPES, Principal } from '../auth/principal';
import { CatalogProduct } from '../products/catalog.types';
import { annualRateFor, evaluatePolicy, PolicyContext, PolicyDeniedException, ProposeInput } from './policy';

const user: Principal = { userId: 'u1', role: 'customer', kind: 'user', scopes: [...SCOPES], maxAmountPerAction: null };
const apiKey = (max: number | null = 5000): Principal => ({
  userId: 'u1',
  role: 'customer',
  kind: 'api_key',
  apiKeyId: 'k1',
  scopes: ['actions:propose', 'actions:confirm'],
  maxAmountPerAction: max,
});

function product(over: Partial<CatalogProduct> = {}): CatalogProduct {
  return {
    slug: 'depozit-termen-lei',
    name: 'Depozit la termen',
    category: 'term_deposit',
    summary: 's',
    key_features: [],
    interest_rate_or_return: { value: 5.2, unit: '% p.a.', conditions: '', as_of: '2026-10-01' },
    fees: [],
    eligibility: [],
    min_amount: { value: 500, currency: 'RON' },
    currencies: ['RON'],
    terms: ['3 months', '6 months', '12 months'],
    risk_level: null,
    good_for: [],
    source_urls: ['https://example.ro'],
    retrieved_at: '2026-10-01',
    openable_via_transfer: true,
    rates_by_term: [{ months: 6, ratePct: 5.5 }],
    ...over,
  };
}

const fund = (risk: number | null, over: Partial<CatalogProduct> = {}) =>
  product({
    slug: 'fond',
    name: 'Fond',
    category: 'investment_fund',
    min_amount: null,
    terms: ['Recommended holding: 2 years'],
    risk_level: risk,
    rates_by_term: [],
    interest_rate_or_return: null,
    ...over,
  });

function transferCtx(over: Partial<PolicyContext> = {}, input: Partial<ProposeInput> = {}): PolicyContext {
  const amount = over.amount ?? 500;
  return {
    principal: user,
    input: { type: 'transfer', fromAccountId: 'a1', toAccountId: 'a2', amount, ...input } as ProposeInput,
    amount,
    source: { id: 'a1', userId: 'u1', type: 'current', status: 'active', balance: 20_000 },
    target: { kind: 'own_account', id: 'a2', status: 'active' },
    product: null,
    userRiskProfile: 'balanced',
    usedTodayViaActions: 0,
    limits: { maxPerAction: 50_000, dailyLimit: 100_000 },
    ...over,
  };
}

function openCtx(over: Partial<PolicyContext> = {}, term: number | null = 6): PolicyContext {
  const termMonths = term ?? undefined;
  const amount = over.amount ?? 1000;
  return transferCtx({
    input: { type: 'open_product', productSlug: 'depozit-termen-lei', fromAccountId: 'a1', amount, termMonths },
    target: null,
    product: product(),
    ...over,
    amount,
  });
}

const violations = (ctx: PolicyContext) => evaluatePolicy(ctx).violations;

describe('evaluatePolicy', () => {
  it('valid own transfer 500 → allowed, riskLevel low, no violations', () => {
    expect(evaluatePolicy(transferCtx())).toEqual({ allowed: true, riskLevel: 'low', violations: [], notes: [] });
  });

  it.each([-5, 0, 10.555, Number.NaN, Number.POSITIVE_INFINITY])('amount %p → AMOUNT_INVALID', (amount) => {
    const v = evaluatePolicy(transferCtx({ amount }));
    expect(v.allowed).toBe(false);
    expect(v.violations).toContain('AMOUNT_INVALID');
  });

  it('amount with 2 decimals (0.1 + 0.2 style) is valid', () => {
    expect(violations(transferCtx({ amount: 10.55 }))).toEqual([]);
    expect(violations(transferCtx({ amount: 0.3 }))).toEqual([]);
  });

  it('missing source → SOURCE_NOT_FOUND', () => {
    expect(violations(transferCtx({ source: null }))).toContain('SOURCE_NOT_FOUND');
  });

  it('source owned by another user → SOURCE_NOT_FOUND', () => {
    expect(
      violations(transferCtx({ source: { id: 'a1', userId: 'u2', type: 'current', status: 'active', balance: 9999 } })),
    ).toContain('SOURCE_NOT_FOUND');
  });

  it('term deposit as source → SOURCE_TYPE_NOT_ALLOWED; savings is allowed', () => {
    const src = { id: 'a1', userId: 'u1', status: 'active', balance: 20_000 };
    expect(violations(transferCtx({ source: { ...src, type: 'term_deposit' } }))).toEqual(['SOURCE_TYPE_NOT_ALLOWED']);
    expect(violations(transferCtx({ source: { ...src, type: 'savings' } }))).toEqual([]);
  });

  it('balance below amount → INSUFFICIENT_FUNDS', () => {
    expect(
      violations(transferCtx({ amount: 600, source: { id: 'a1', userId: 'u1', type: 'current', status: 'active', balance: 500 } })),
    ).toEqual(['INSUFFICIENT_FUNDS']);
  });

  it('amount above per-action limit → PER_ACTION_LIMIT', () => {
    expect(
      violations(
        transferCtx({
          amount: 60_000,
          source: { id: 'a1', userId: 'u1', type: 'current', status: 'active', balance: 100_000 },
        }),
      ),
    ).toEqual(['PER_ACTION_LIMIT']);
  });

  it('used 95 000 today + 10 000 → DAILY_LIMIT', () => {
    expect(violations(transferCtx({ amount: 10_000, usedTodayViaActions: 95_000 }))).toEqual(['DAILY_LIMIT']);
    expect(violations(transferCtx({ amount: 5_000, usedTodayViaActions: 95_000 }))).toEqual([]);
  });

  it('api_key with maxAmountPerAction 5000 proposing 6000 → API_KEY_LIMIT', () => {
    expect(violations(transferCtx({ principal: apiKey(5000), amount: 6000 }))).toEqual(['API_KEY_LIMIT']);
    expect(violations(transferCtx({ principal: apiKey(5000), amount: 5000 }))).toEqual([]);
    expect(violations(transferCtx({ principal: apiKey(null), amount: 6000 }))).toEqual([]);
  });

  it('user principals are never subject to API_KEY_LIMIT', () => {
    expect(violations(transferCtx({ principal: { ...user, maxAmountPerAction: 1 }, amount: 6000 }))).toEqual([]);
  });

  it('transfer without resolvable target → TARGET_NOT_FOUND', () => {
    expect(violations(transferCtx({ target: null }))).toEqual(['TARGET_NOT_FOUND']);
  });

  it('closed own target → TARGET_NOT_FOUND', () => {
    expect(violations(transferCtx({ target: { kind: 'own_account', id: 'a2', status: 'closed' } }))).toEqual(['TARGET_NOT_FOUND']);
  });

  it('target equals source → SAME_ACCOUNT', () => {
    expect(violations(transferCtx({ target: { kind: 'own_account', id: 'a1', status: 'active' } }))).toEqual(['SAME_ACCOUNT']);
  });

  it('external invalid IBAN → IBAN_INVALID, risk high', () => {
    const v = evaluatePolicy(transferCtx({ target: { kind: 'external_iban', ibanValid: false } }));
    expect(v.violations).toEqual(['IBAN_INVALID']);
    expect(v.riskLevel).toBe('high');
  });

  it('valid external IBAN by user → allowed but high risk', () => {
    const v = evaluatePolicy(transferCtx({ target: { kind: 'external_iban', ibanValid: true } }));
    expect(v.allowed).toBe(true);
    expect(v.riskLevel).toBe('high');
    expect(v.notes.length).toBeGreaterThan(0);
  });

  it('api_key + external IBAN → EXTERNAL_TRANSFER_NOT_ALLOWED_FOR_AGENT', () => {
    expect(
      violations(transferCtx({ principal: apiKey(), target: { kind: 'external_iban', ibanValid: true } })),
    ).toEqual(['EXTERNAL_TRANSFER_NOT_ALLOWED_FOR_AGENT']);
  });

  it('valid term deposit open → allowed', () => {
    expect(evaluatePolicy(openCtx())).toMatchObject({ allowed: true, riskLevel: 'low', violations: [] });
  });

  it('unknown product → PRODUCT_NOT_FOUND', () => {
    expect(violations(openCtx({ product: null }))).toEqual(['PRODUCT_NOT_FOUND']);
  });

  it('openable_via_transfer false → PRODUCT_NOT_OPENABLE', () => {
    expect(violations(openCtx({ product: product({ openable_via_transfer: false }) }))).toEqual(['PRODUCT_NOT_OPENABLE']);
  });

  it('non-openable category (personal_loan) → PRODUCT_NOT_OPENABLE', () => {
    expect(violations(openCtx({ product: product({ category: 'personal_loan', terms: [], min_amount: null }) }))).toEqual([
      'PRODUCT_NOT_OPENABLE',
    ]);
  });

  it('EUR-only product → PRODUCT_NOT_OPENABLE; empty currencies is fine', () => {
    expect(violations(openCtx({ product: product({ currencies: ['EUR'] }) }))).toEqual(['PRODUCT_NOT_OPENABLE']);
    expect(violations(openCtx({ product: product({ currencies: [] }) }))).toEqual([]);
    expect(violations(openCtx({ product: product({ currencies: ['RON', 'EUR'] }) }))).toEqual([]);
  });

  it('amount below min_amount → BELOW_MIN_AMOUNT', () => {
    expect(violations(openCtx({ amount: 100 }))).toEqual(['BELOW_MIN_AMOUNT']);
  });

  it('term not listed → TERM_NOT_AVAILABLE; missing term for a deposit too', () => {
    expect(violations(openCtx({}, 5))).toEqual(['TERM_NOT_AVAILABLE']);
    expect(violations(openCtx({}, null))).toEqual(['TERM_NOT_AVAILABLE']);
    expect(violations(openCtx({}, 12))).toEqual([]);
  });

  it('fund without termMonths is fine even though its terms parse to months', () => {
    expect(violations(openCtx({ product: fund(2), userRiskProfile: 'conservative' }, null))).toEqual([]);
  });

  it('conservative user + fund risk_level 4 → RISK_PROFILE_MISMATCH; dynamic → allowed, medium', () => {
    expect(violations(openCtx({ product: fund(4), userRiskProfile: 'conservative' }, null))).toEqual([
      'RISK_PROFILE_MISMATCH',
    ]);
    const ok = evaluatePolicy(openCtx({ product: fund(4), userRiskProfile: 'dynamic' }, null));
    expect(ok.allowed).toBe(true);
    expect(ok.riskLevel).toBe('medium');
  });

  it('balanced max 4: fund risk 5 → mismatch; null risk_level counts as 4', () => {
    expect(violations(openCtx({ product: fund(5), userRiskProfile: 'balanced' }, null))).toEqual(['RISK_PROFILE_MISMATCH']);
    expect(violations(openCtx({ product: fund(null), userRiskProfile: 'balanced' }, null))).toEqual([]);
    expect(violations(openCtx({ product: fund(null), userRiskProfile: 'conservative' }, null))).toEqual([
      'RISK_PROFILE_MISMATCH',
    ]);
  });

  it('private pension is risk-checked too', () => {
    const pension = product({ category: 'private_pension', terms: [], min_amount: null, risk_level: 3 });
    expect(violations(openCtx({ product: pension, userRiskProfile: 'conservative' }, null))).toEqual([
      'RISK_PROFILE_MISMATCH',
    ]);
  });

  it('risk levels: >10 000 high, >2 000 medium, else low', () => {
    expect(evaluatePolicy(transferCtx({ amount: 10_001 })).riskLevel).toBe('high');
    expect(evaluatePolicy(transferCtx({ amount: 10_000 })).riskLevel).toBe('medium');
    expect(evaluatePolicy(transferCtx({ amount: 2_001 })).riskLevel).toBe('medium');
    expect(evaluatePolicy(transferCtx({ amount: 2_000 })).riskLevel).toBe('low');
  });

  it('reports every violation at once', () => {
    const v = violations(
      transferCtx({
        principal: apiKey(100),
        amount: 600,
        source: { id: 'a1', userId: 'u1', type: 'investment', status: 'active', balance: 10 },
        target: { kind: 'external_iban', ibanValid: false },
      }),
    );
    expect(v).toEqual(
      expect.arrayContaining([
        'SOURCE_TYPE_NOT_ALLOWED',
        'INSUFFICIENT_FUNDS',
        'API_KEY_LIMIT',
        'IBAN_INVALID',
        'EXTERNAL_TRANSFER_NOT_ALLOWED_FOR_AGENT',
      ]),
    );
  });
});

describe('annualRateFor', () => {
  it('uses rates_by_term for the chosen term, else the headline rate', () => {
    expect(annualRateFor(product(), 6)).toBe(5.5);
    expect(annualRateFor(product(), 12)).toBe(5.2);
    expect(annualRateFor(fund(2))).toBeNull();
  });
});

describe('PolicyDeniedException', () => {
  it('has the 422 PolicyDenied body', () => {
    const e = new PolicyDeniedException(['DAILY_LIMIT']);
    expect(e.getStatus()).toBe(422);
    expect(e.getResponse()).toEqual({
      statusCode: 422,
      error: 'PolicyDenied',
      message: 'Acțiunea nu respectă regulile băncii',
      violations: ['DAILY_LIMIT'],
    });
  });
});
