import type { FinancialSnapshot } from '../banking/stats.service';
import type { GoalDto } from '../goals/dto';
import type { CatalogProduct } from '../products/catalog.types';
import { floor10, floor100, generateOfferCandidates, pickBest, RuleInput } from './offer-rules';

function product(p: Partial<CatalogProduct> & Pick<CatalogProduct, 'slug' | 'category'>): CatalogProduct {
  return {
    name: p.slug,
    summary: '',
    key_features: [],
    interest_rate_or_return: null,
    fees: [],
    eligibility: [],
    min_amount: null,
    currencies: ['RON'],
    terms: [],
    risk_level: null,
    good_for: [],
    source_urls: [`https://example.ro/${p.slug}`],
    retrieved_at: '2026-10-01',
    ...p,
  };
}

const rate = (value: number) => ({ value, unit: '%/an', conditions: '', as_of: '2026-10-01' });

const PRODUCTS: CatalogProduct[] = [
  product({ slug: 'economii', category: 'savings_account', interest_rate_or_return: rate(2), good_for: ['emergency_fund'] }),
  product({ slug: 'roundup', category: 'savings_account', interest_rate_or_return: rate(10), openable_via_transfer: false }),
  product({
    slug: 'depozit-lei',
    category: 'term_deposit',
    interest_rate_or_return: rate(5.2),
    terms: ['3 months', '12 months'],
    rates_by_term: [
      { months: 3, ratePct: 4.7 },
      { months: 12, ratePct: 5.2 },
    ],
    min_amount: { value: 500, currency: 'RON' },
  }),
  product({
    slug: 'depozit-bonus',
    category: 'term_deposit',
    interest_rate_or_return: rate(5.5),
    terms: ['6 months'],
    rates_by_term: [{ months: 6, ratePct: 5.5 }],
    min_amount: { value: 500, currency: 'RON' },
  }),
  product({ slug: 'depozit-fresh', category: 'term_deposit', interest_rate_or_return: rate(9), terms: ['4 months'], rule_eligible: false }),
  product({ slug: 'fond-moderat', category: 'investment_fund', risk_level: 2, good_for: ['medium_term_growth'] }),
  product({ slug: 'fond-actiuni', category: 'investment_fund', risk_level: 5, good_for: ['long_term_growth'] }),
  product({ slug: 'fond-eur', category: 'investment_fund', risk_level: 3, currencies: ['EUR'], good_for: ['long_term_growth'] }),
  product({ slug: 'pilon-3', category: 'private_pension' }),
  product({ slug: 'refinantare', category: 'personal_loan', interest_rate_or_return: rate(5.55), good_for: ['debt_consolidation'] }),
  product({ slug: 'pachet-tineri', category: 'account_package', good_for: ['student_young_adult'] }),
];

function snapshot(s: Partial<FinancialSnapshot> = {}): FinancialSnapshot {
  return {
    asOf: '2026-10-28',
    totalBalance: 0,
    balancesByType: {},
    currentAccountBalance: 0,
    savingsBalance: 0,
    creditCardDebt: 0,
    avgMonthlyIncome: 0,
    avgMonthlySpending: 0,
    savingsRate: 0,
    idleCash: 0,
    monthsOfRunway: 0,
    topSpendingCategories: [],
    subscriptionsMonthly: 0,
    ...s,
  };
}

function goal(g: Partial<GoalDto> & Pick<GoalDto, 'type'>): GoalDto {
  return {
    id: `g-${g.type}`,
    name: g.type,
    targetAmount: 10_000,
    currency: 'RON',
    targetDate: null,
    linkedAccountId: null,
    priority: 1,
    status: 'active',
    currentAmount: 0,
    progressPct: 0,
    monthsLeft: null,
    requiredMonthlySaving: null,
    ...g,
  };
}

function input(o: Partial<Omit<RuleInput, 'user'>> & { user?: Partial<RuleInput['user']> } = {}): RuleInput {
  return {
    snapshot: snapshot(),
    goals: [],
    products: PRODUCTS,
    ownedAccountTypes: ['current'],
    interestTaxRate: 0.1,
    now: new Date('2026-10-28T00:00:00Z'),
    ...o,
    user: { age: 30, riskProfile: 'balanced', monthlyIncome: null, ...o.user },
  };
}

const ids = (cs: { ruleId: string }[]) => cs.map((c) => c.ruleId);

describe('offer rules', () => {
  it('floor helpers round down', () => {
    expect(floor100(14_599)).toBe(14_500);
    expect(floor10(437.9)).toBe(430);
  });

  it('pickBest skips non-eligible products and picks the highest rate', () => {
    expect(pickBest(PRODUCTS, { categories: ['savings_account'] })?.slug).toBe('economii');
    expect(pickBest(PRODUCTS, { categories: ['housing_savings'] })).toBeNull();
  });

  it('andrei-like (idle 29 000, dynamic, vacation goal in 8 months) → goal_term_deposit with termMonths ≤ 8 and idle_cash_savings', () => {
    const out = generateOfferCandidates(
      input({
        user: { age: 31, riskProfile: 'dynamic' },
        snapshot: snapshot({ idleCash: 29_000, avgMonthlyIncome: 9000, avgMonthlySpending: 5000, savingsBalance: 20_000 }),
        goals: [goal({ type: 'vacation', targetAmount: 12_000, currentAmount: 2000, monthsLeft: 8 })],
      }),
    );
    const gtd = out.find((c) => c.ruleId === 'goal_term_deposit')!;
    expect(gtd).toBeDefined();
    expect(gtd.productSlug).toBe('depozit-bonus');
    expect(gtd.termMonths).toBeLessThanOrEqual(8);
    expect(gtd.suggestedAmount).toBe(10_000);
    expect(gtd.projection?.available).toBe(true);
    const idle = out.find((c) => c.ruleId === 'idle_cash_savings')!;
    expect(idle.productSlug).toBe('economii');
    expect(idle.suggestedAmount).toBe(14_500);
  });

  it('maria-like (debt 3 800, subs 201, home goal) → home_goal, credit_card_debt, subscriptions_tip; no long_term_growth', () => {
    const out = generateOfferCandidates(
      input({
        user: { age: 34, riskProfile: 'conservative' },
        snapshot: snapshot({
          idleCash: 800,
          creditCardDebt: 3800,
          subscriptionsMonthly: 201,
          avgMonthlyIncome: 4800,
          avgMonthlySpending: 4200,
          savingsBalance: 15_000,
        }),
        goals: [goal({ type: 'home', targetAmount: 60_000, currentAmount: 5000, monthsLeft: 36, requiredMonthlySaving: 1527.78 })],
      }),
    );
    expect(ids(out)).toEqual(expect.arrayContaining(['home_goal', 'credit_card_debt', 'subscriptions_tip']));
    expect(ids(out)).not.toContain('long_term_growth');
    const home = out.find((c) => c.ruleId === 'home_goal')!;
    expect(home.monthlyContribution).toBe(1520);
    expect(home.reasoning).toMatch(/avans/);
    const debt = out.find((c) => c.ruleId === 'credit_card_debt')!;
    expect(debt.productSlug).toBe('refinantare');
    expect(debt.actionable).toBe(false);
    expect(out.find((c) => c.ruleId === 'subscriptions_tip')!.reasoning).toContain('1.206,00');
  });

  it('ion-like (age 52, no pension) → retirement with monthlyContribution 165', () => {
    const out = generateOfferCandidates(input({ user: { age: 52, riskProfile: 'conservative' } }));
    const r = out.find((c) => c.ruleId === 'retirement')!;
    expect(r.monthlyContribution).toBe(165);
    expect(r.productSlug).toBe('pilon-3');
    expect(r.projection?.available).toBe(false);
    expect(
      ids(generateOfferCandidates(input({ user: { age: 52, riskProfile: 'conservative' }, ownedAccountTypes: ['pension'] }))),
    ).not.toContain('retirement');
  });

  it('conservative never gets long_term_growth; fund risk 5 excluded for balanced', () => {
    const snap = snapshot({ idleCash: 20_000 });
    expect(ids(generateOfferCandidates(input({ user: { riskProfile: 'conservative' }, snapshot: snap })))).not.toContain(
      'long_term_growth',
    );
    const balanced = generateOfferCandidates(input({ user: { riskProfile: 'balanced' }, snapshot: snap }));
    expect(balanced.find((c) => c.ruleId === 'long_term_growth')?.productSlug).toBe('fond-moderat');
    const dynamic = generateOfferCandidates(input({ user: { riskProfile: 'dynamic' }, snapshot: snap }));
    expect(dynamic.find((c) => c.ruleId === 'long_term_growth')?.productSlug).toBe('fond-actiuni');
  });

  it('no matching product → rule silently produces nothing', () => {
    const out = generateOfferCandidates(
      input({ products: [], snapshot: snapshot({ idleCash: 50_000, creditCardDebt: 5000, subscriptionsMonthly: 300 }) }),
    );
    expect(ids(out).sort()).toEqual(['credit_card_debt', 'subscriptions_tip']);
    expect(out.every((c) => c.kind === 'tip')).toBe(true);
  });

  it('returns ≤ 5 sorted by score; actionable only for openable categories', () => {
    const out = generateOfferCandidates(
      input({
        user: { age: 24, riskProfile: 'dynamic' },
        snapshot: snapshot({
          idleCash: 40_000,
          creditCardDebt: 2000,
          subscriptionsMonthly: 200,
          avgMonthlyIncome: 6000,
          avgMonthlySpending: 4000,
        }),
        goals: [goal({ type: 'retirement' }), goal({ type: 'car', monthsLeft: 10, targetAmount: 30_000 })],
      }),
    );
    expect(out.length).toBeLessThanOrEqual(5);
    for (let k = 1; k < out.length; k++) expect(out[k - 1].score).toBeGreaterThanOrEqual(out[k].score);
    expect(new Set(ids(out)).size).toBe(out.length);
    for (const c of out) {
      if (c.productSlug === 'refinantare' || c.productSlug === 'pachet-tineri' || c.kind === 'tip') expect(c.actionable).toBe(false);
      else expect(c.actionable).toBe(true);
    }
  });
});
