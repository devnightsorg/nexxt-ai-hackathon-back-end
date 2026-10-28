import { generateIban, isValidIban } from './iban.util';
import { computeCashflow, computeSnapshot, computeSpending, StatTxn } from './stats.service';

const t = (direction: 'in' | 'out', amount: number, category: string, iso: string): StatTxn => ({
  direction,
  amount,
  category,
  bookedAt: new Date(iso),
});

const now = new Date('2026-10-15T12:00:00Z');
// Window = Jul, Aug, Sep 2026.
const txns: StatTxn[] = [
  t('in', 9000, 'salary', '2026-06-10T09:00:00Z'), // before window
  t('out', 900, 'groceries', '2026-06-12T09:00:00Z'), // before window
  t('in', 3000, 'salary', '2026-07-10T09:00:00Z'),
  t('in', 3000, 'salary', '2026-08-10T09:00:00Z'),
  t('in', 3000, 'salary', '2026-09-10T09:00:00Z'),
  t('out', 600, 'groceries', '2026-07-12T09:00:00Z'),
  t('out', 300, 'groceries', '2026-08-12T09:00:00Z'),
  t('out', 90, 'subscriptions', '2026-09-01T09:00:00Z'),
  t('out', 1000, 'transfer_internal', '2026-08-20T09:00:00Z'),
  t('out', 2000, 'savings', '2026-09-20T09:00:00Z'),
  t('in', 1000, 'transfer_internal', '2026-08-20T09:00:00Z'),
  t('out', 5000, 'travel', '2026-10-02T09:00:00Z'), // current, incomplete month
];

describe('stats helpers', () => {
  it('snapshot averages last 3 complete months only and excludes transfer_internal/savings', () => {
    const s = computeSnapshot([{ type: 'current', balance: 5000 }], txns, now);
    expect(s.avgMonthlyIncome).toBe(3000);
    expect(s.avgMonthlySpending).toBe(330); // (600 + 300 + 90) / 3
    expect(s.savingsRate).toBe(0.89);
    expect(s.subscriptionsMonthly).toBe(30);
    expect(s.topSpendingCategories).toEqual([
      { category: 'groceries', monthlyAvg: 300 },
      { category: 'subscriptions', monthlyAvg: 30 },
    ]);
  });

  it('idleCash = currentBalance − avgMonthlySpending, floored at 0', () => {
    expect(computeSnapshot([{ type: 'current', balance: 5000 }], txns, now).idleCash).toBe(4670);
    expect(computeSnapshot([{ type: 'current', balance: 100 }], txns, now).idleCash).toBe(0);
  });

  it('snapshot splits balances by type and reports credit card debt as positive', () => {
    const s = computeSnapshot(
      [
        { type: 'current', balance: 3200 },
        { type: 'credit_card', balance: -3800 },
        { type: 'savings', balance: 1000 },
        { type: 'term_deposit', balance: 500.55 },
      ],
      [],
      now,
    );
    expect(s.creditCardDebt).toBe(3800);
    expect(s.savingsBalance).toBe(1500.55);
    expect(s.totalBalance).toBe(900.55);
    expect(s.balancesByType).toEqual({ current: 3200, credit_card: -3800, savings: 1000, term_deposit: 500.55 });
    expect(s.savingsRate).toBe(0);
  });

  it('spending sorts categories by amount and excludes internal transfers', () => {
    const s = computeSpending(txns, new Date('2026-07-01T00:00:00Z'), new Date('2026-09-30T23:59:59Z'));
    expect(s.total).toBe(990);
    expect(s.byCategory.map((c) => c.category)).toEqual(['groceries', 'subscriptions']);
    expect(s.byCategory[0]).toEqual({ category: 'groceries', amount: 900, count: 2, share: 0.91 });
  });

  it('cashflow returns N ascending YYYY-MM months ending with the current month', () => {
    const c = computeCashflow(txns, 6, now);
    expect(c.map((m) => m.month)).toEqual(['2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10']);
    expect(c[2]).toEqual({ month: '2026-07', income: 3000, spending: 600, net: 2400 });
    expect(c[5]).toEqual({ month: '2026-10', income: 0, spending: 5000, net: -5000 });
  });
});

describe('iban helpers', () => {
  it('generateIban produces valid RZBR IBANs; isValidIban rejects a 1-digit change', () => {
    const iban = generateIban(42);
    expect(iban).toMatch(/^RO\d{2}RZBR\d{16}$/);
    expect(isValidIban(iban)).toBe(true);
    expect(isValidIban('RO49 AAAA 1B31 0075 9384 0000')).toBe(true);
    expect(isValidIban('RO49AAAA1B31007593840001')).toBe(false);
  });
});
