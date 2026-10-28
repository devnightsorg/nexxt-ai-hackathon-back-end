import type { FinancialSnapshot } from '../banking/stats.service';
import type { OfferCandidate, RuleId } from '../offers/offer-rules';
import type { CatalogProduct } from '../products/catalog.types';
import { evaluateLadder } from './ladder';
import type { DebtSummary } from './lenders';
import { rankActions, RankInput, stepForRule } from './ranker';
import type { SituationAnswers } from './types';

const NO_DEBT: DebtSummary = { payments: [], monthlyTotal: 0, expensiveMonthly: 0 };

function snapshot(s: Partial<FinancialSnapshot> = {}): FinancialSnapshot {
  return {
    asOf: '2026-10-28',
    totalBalance: 0,
    balancesByType: { current: 10000 },
    currentAccountBalance: 10000,
    savingsBalance: 0,
    creditCardDebt: 0,
    avgMonthlyIncome: 10000,
    avgMonthlySpending: 5000,
    savingsRate: 0.5,
    idleCash: 5000,
    monthsOfRunway: 2,
    topSpendingCategories: [{ category: 'dining', monthlyAvg: 1200 }],
    subscriptionsMonthly: 300,
    ...s,
  };
}

const product = (slug: string, category: CatalogProduct['category']): CatalogProduct => ({
  slug,
  name: slug,
  category,
  summary: '',
  key_features: [],
  interest_rate_or_return: { value: 6, unit: '%', conditions: '', as_of: '' },
  fees: [],
  eligibility: [],
  min_amount: null,
  currencies: ['RON'],
  terms: [],
  risk_level: null,
  good_for: [],
  source_urls: [`https://example.ro/${slug}`],
  retrieved_at: '',
});

const PRODUCTS = [
  product('economii', 'savings_account'),
  product('refinantare', 'personal_loan'),
  product('card', 'credit_card'),
  product('fond', 'investment_fund'),
  product('pilon-3', 'private_pension'),
];

function cand(ruleId: RuleId, slug: string | null, c: Partial<OfferCandidate> = {}): OfferCandidate {
  return {
    ruleId,
    kind: slug ? 'product' : 'tip',
    productSlug: slug,
    title: ruleId,
    suggestedAmount: null,
    monthlyContribution: null,
    termMonths: null,
    projection: null,
    reasoning: '',
    citations: [],
    score: 50,
    actionable: true,
    goalId: null,
    ...c,
  };
}

function input(o: {
  snapshot?: FinancialSnapshot;
  answers?: SituationAnswers;
  candidates: OfferCandidate[];
  riskProfile?: RankInput['riskProfile'];
  debt?: DebtSummary;
}): RankInput {
  const s = o.snapshot ?? snapshot();
  const answers = o.answers ?? {};
  const debt = o.debt ?? NO_DEBT;
  return {
    ladder: evaluateLadder({ snapshot: s, goals: [], answers, debt, declaredIncome: null }),
    candidates: o.candidates,
    products: PRODUCTS,
    goals: [],
    answers,
    riskProfile: o.riskProfile ?? 'balanced',
    snapshot: s,
    debt,
  };
}

describe('rankActions', () => {
  it('maps rule ids to ladder steps', () => {
    const L = evaluateLadder({ snapshot: snapshot({ monthsOfRunway: 0.5 }), goals: [], answers: {}, debt: NO_DEBT, declaredIncome: null }).ladder;
    expect(stepForRule('emergency_fund', L)).toBe(2);
    expect(stepForRule('credit_card_debt', L)).toBe(3);
    expect(stepForRule('home_goal', L)).toBe(6);
    const green = evaluateLadder({ snapshot: snapshot(), goals: [], answers: {}, debt: NO_DEBT, declaredIncome: null }).ladder;
    expect(stepForRule('emergency_fund', green)).toBe(5);
  });

  it('orders red steps first (lowest step up), then amber; at most 3 and at most 2 per step', () => {
    const actions = rankActions(
      input({
        snapshot: snapshot({ monthsOfRunway: 0.5, creditCardDebt: 2000 }),
        candidates: [
          cand('subscriptions_tip', null),
          cand('emergency_fund', 'economii', { monthlyContribution: 400 }),
          cand('credit_card_debt', 'refinantare'),
          cand('idle_cash_savings', 'economii', { suggestedAmount: 3000 }),
        ],
      }),
    );
    // Steps 2, 3 and 5 are red; step 1 (green) comes last and is cut.
    expect(actions.map((a) => [a.step, a.ruleId])).toEqual([
      [2, 'emergency_fund'],
      [3, 'credit_card_debt'],
      [5, 'idle_cash_savings'],
    ]);
    expect(actions[0]).toMatchObject({
      id: 'emergency_fund:economii',
      stepLabel: 'Step 2 · Starter buffer',
      kind: 'product',
      impactRonPerMonth: 400,
      product: { slug: 'economii', name: 'economii', url: 'https://example.ro/economii' },
    });
    expect(actions[0].reasoning[0].rule).toBe('Step 2 · Starter buffer is red');
  });

  it('never names a credit product while step 1 is red', () => {
    const actions = rankActions(
      input({
        snapshot: snapshot({ avgMonthlySpending: 11000, creditCardDebt: 2000 }),
        candidates: [cand('credit_card_debt', 'refinantare')],
      }),
    );
    expect(actions[0]).toMatchObject({ step: 1, ruleId: 'cash_flow_review', kind: 'tip', product: null });
    const card = actions.find((a) => a.ruleId === 'credit_card_debt');
    expect(card).toMatchObject({ kind: 'tip', product: null });
  });

  it('puts a step-1 action first under money stress', () => {
    const actions = rankActions(
      input({
        snapshot: snapshot({ monthsOfRunway: 0.5 }),
        answers: { money_stress: true },
        candidates: [cand('emergency_fund', 'economii', { monthlyContribution: 400 })],
      }),
    );
    expect(actions[0].step).toBe(1);
  });

  it('replaces the investment product with a meeting for conservative profiles', () => {
    const c = [cand('long_term_growth', 'fond', { suggestedAmount: 5000 })];
    const conservative = rankActions(input({ candidates: c, riskProfile: 'conservative' }));
    expect(conservative.find((a) => a.step === 7)).toMatchObject({ kind: 'meeting', product: null, ruleId: 'long_term_meeting' });
    const balanced = rankActions(input({ candidates: c, riskProfile: 'balanced' }));
    expect(balanced.find((a) => a.step === 7)).toMatchObject({ kind: 'product', product: { slug: 'fond' } });
  });

  it('hides step-7 actions while steps 1–3 are not all green', () => {
    const actions = rankActions(
      input({ snapshot: snapshot({ monthsOfRunway: 0.5 }), candidates: [cand('retirement', 'pilon-3', { monthlyContribution: 165 })] }),
    );
    expect(actions.some((a) => a.step === 7)).toBe(false);
  });

  it('suggests paying off IFN/BNPL debt with its monthly cost as impact', () => {
    const debt: DebtSummary = {
      payments: [
        { lender: 'Provident', kind: 'ifn', monthlyAvg: 210, months: 3 },
        { lender: 'Mokka', kind: 'bnpl', monthlyAvg: 140, months: 3 },
      ],
      monthlyTotal: 350,
      expensiveMonthly: 350,
    };
    const [first] = rankActions(input({ debt, candidates: [] }));
    expect(first).toMatchObject({ step: 3, ruleId: 'expensive_debt_payoff', impactRonPerMonth: 350, product: null });
  });
});
