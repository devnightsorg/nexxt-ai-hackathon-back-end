import type { FinancialSnapshot } from '../banking/stats.service';
import { creditPrecheck } from './credit-precheck';

const snap = (avgMonthlyIncome: number, creditCardDebt: number) =>
  ({ avgMonthlyIncome, creditCardDebt }) as unknown as FinancialSnapshot;

describe('creditPrecheck', () => {
  it('income 4 800, debt 3 800 → maxMonthlyInstallment 1 730', () => {
    const r = creditPrecheck(snap(4800, 3800));
    expect(r.dtiLimit).toBe(0.4);
    expect(r.existingDebtPayments).toBe(190);
    expect(r.maxMonthlyInstallment).toBe(1730);
    expect(r.indicativeMaxLoan).toBeNull();
    expect(r.indicative).toBe(true);
  });

  it('computes an annuity present value when rate and term are given', () => {
    const r = creditPrecheck(snap(5000, 0), { annualRatePct: 0, termMonths: 60 });
    expect(r.indicativeMaxLoan).toBe(120_000);
    const withRate = creditPrecheck(snap(5000, 0), { annualRatePct: 6, termMonths: 60 });
    expect(withRate.indicativeMaxLoan).toBeGreaterThan(100_000);
    expect(withRate.indicativeMaxLoan).toBeLessThan(120_000);
  });

  it('never goes negative', () => {
    expect(creditPrecheck(snap(1000, 20_000)).maxMonthlyInstallment).toBe(0);
  });
});
