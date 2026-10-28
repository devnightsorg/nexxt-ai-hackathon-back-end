import { detectDebtPayments, matchLender } from './lenders';

const out = (counterpartyName: string, amount: number, month: number, o: { category?: string; description?: string } = {}) => ({
  direction: 'out' as const,
  amount,
  category: o.category ?? 'other',
  counterpartyName,
  description: o.description ?? null,
  bookedAt: new Date(Date.UTC(2026, month, 10)),
});

describe('lenders', () => {
  it('matches IFN and BNPL by name; banks only for loan instalments', () => {
    expect(matchLender({ counterpartyName: 'Provident Financial', description: null })?.kind).toBe('ifn');
    expect(matchLender({ counterpartyName: 'IUTE Credit Romania', description: null })?.kind).toBe('ifn');
    expect(matchLender({ counterpartyName: 'Mokka', description: null })?.kind).toBe('bnpl');
    expect(matchLender({ counterpartyName: 'TBI Pay', description: null })?.kind).toBe('bnpl');
    expect(matchLender({ counterpartyName: 'BCR', description: 'Rată credit ipotecar' })?.kind).toBe('bank');
    expect(matchLender({ counterpartyName: 'BCR', description: 'Transfer' })).toBeNull();
    expect(matchLender({ counterpartyName: 'Kaufland', description: null })).toBeNull();
  });

  it('averages recurring payments over the window and skips one-offs and own-account transfers', () => {
    const d = detectDebtPayments(
      [
        out('Provident', 210, 6),
        out('Provident', 210, 7),
        out('Provident', 210, 8),
        out('Mokka', 140, 7),
        out('Mokka', 140, 8),
        out('Klarna', 99, 8), // one month only
        out('Card de credit Raiffeisen', 500, 7, { category: 'transfer_internal', description: 'Rambursare card de credit' }),
        out('Card de credit Raiffeisen', 500, 8, { category: 'transfer_internal', description: 'Rambursare card de credit' }),
        { ...out('Provident', 1000, 8), direction: 'in' as const },
      ],
      3,
    );
    expect(d.payments.map((p) => [p.lender, p.monthlyAvg])).toEqual([
      ['Provident', 210],
      ['Mokka', 93.33],
    ]);
    expect(d.monthlyTotal).toBe(303.33);
    expect(d.expensiveMonthly).toBe(303.33);
  });
});
