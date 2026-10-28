import { CatalogProduct } from '../products/catalog.types';
import { simulate } from './projection';

function product(over: Partial<CatalogProduct>): CatalogProduct {
  return {
    slug: 'p',
    name: 'P',
    category: 'savings_account',
    summary: '',
    key_features: [],
    interest_rate_or_return: { value: 5, unit: '% p.a.', conditions: '', as_of: '2026-10-28' },
    fees: [],
    eligibility: [],
    min_amount: null,
    currencies: ['RON'],
    terms: [],
    risk_level: null,
    good_for: [],
    source_urls: ['https://example.test'],
    retrieved_at: '2026-10-28',
    ...over,
  };
}

const rate = (value: number | null) => ({ value, unit: '% p.a.', conditions: '', as_of: '2026-10-28' });

describe('simulate', () => {
  it('term deposit 10 000 at 6% for 6 months, tax 10% → gross 300, tax 30, net 270, final 10 270', () => {
    const p = product({ category: 'term_deposit', interest_rate_or_return: rate(6), terms: ['6 months'] });
    const r = simulate({ product: p, amount: 10000, interestTaxRate: 0.1 });
    expect(r).toMatchObject({ available: true, termMonths: 6, grossInterest: 300, tax: 30, netInterest: 270, finalAmount: 10270 });
  });

  it('term deposit uses rates_by_term for the chosen term', () => {
    const p = product({
      category: 'term_deposit',
      interest_rate_or_return: rate(5.2),
      terms: ['3 months', '12 months'],
      rates_by_term: [
        { months: 3, ratePct: 4.7 },
        { months: 12, ratePct: 5.2 },
      ],
    });
    const r = simulate({ product: p, amount: 10000, interestTaxRate: 0.1 });
    expect(r).toMatchObject({ available: true, termMonths: 3, annualRatePct: 4.7, grossInterest: 117.5 });
  });

  it('savings 1 000 + 100/month at 12% for 12 months → finalAmount matches monthly compounding to the cent', () => {
    const p = product({ interest_rate_or_return: rate(12) });
    const r = simulate({ product: p, amount: 1000, monthlyContribution: 100, termMonths: 12, interestTaxRate: 0.1 });
    const f = 1.01 ** 12;
    const fv = 1000 * f + (100 * (f - 1)) / 0.01;
    const gross = Math.round((fv - 2200) * 100) / 100;
    const tax = Math.round(gross * 0.1 * 100) / 100;
    expect(r).toMatchObject({ available: true, grossInterest: gross, tax });
    if (!r.available) throw new Error('unavailable');
    expect(r.finalAmount).toBeCloseTo(2200 + gross - tax, 2);
  });

  it('null rate → available:false', () => {
    const r = simulate({ product: product({ interest_rate_or_return: null }), amount: 100, interestTaxRate: 0.1 });
    expect(r).toEqual({ available: false, productSlug: 'p', reason: 'Dobânda/randamentul nu este disponibil în catalog' });
  });

  it('investment_fund tax 0 and assumption mentions negarantat', () => {
    const p = product({ category: 'investment_fund', interest_rate_or_return: rate(7) });
    const r = simulate({ product: p, amount: 1000, interestTaxRate: 0.1 });
    if (!r.available) throw new Error('unavailable');
    expect(r.taxRate).toBe(0);
    expect(r.tax).toBe(0);
    expect(r.assumptions.join(' ')).toContain('negarantat');
  });

  it('goalReachMonths: 0 + 1 000/month at 0% to 5 000 → 5; unreachable → null', () => {
    const p = product({ interest_rate_or_return: rate(0) });
    const ok = simulate({ product: p, amount: 0, monthlyContribution: 1000, goalTarget: 5000, interestTaxRate: 0.1 });
    expect(ok).toMatchObject({ goalReachMonths: 5 });
    const never = simulate({ product: p, amount: 100, goalTarget: 5000, interestTaxRate: 0.1 });
    expect(never).toMatchObject({ goalReachMonths: null });
  });
});
