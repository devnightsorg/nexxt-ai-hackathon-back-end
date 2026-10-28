import { PERSONAS } from './personas';
import { generateTransactions, reconcile } from './transactions';

const anchor = new Date('2026-10-28T12:00:00Z');
const opts = { anchor, months: 6 as const, seed: 42 };

const currentBalance = (key: string) => PERSONAS.find((p) => p.key === key)!.accounts.find((a) => a.type === 'current')!.balance;

describe('generateTransactions', () => {
  it('is deterministic for same seed', () => {
    const p = PERSONAS[0];
    expect(generateTransactions(p, opts)).toEqual(generateTransactions(p, opts));
    expect(generateTransactions(p, { ...opts, seed: 43 })).not.toEqual(generateTransactions(p, opts));
  });

  it.each(PERSONAS.map((p) => [p.key, p] as const))('%s: 6 months, final balance equals target, running balance never below 0', (key, p) => {
    const txns = generateTransactions(p, opts);
    const months = new Set(txns.map((t) => t.bookedAt.toISOString().slice(0, 7)));
    expect([...months].sort()).toEqual(['2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10']);
    expect(txns.every((t) => t.bookedAt <= anchor)).toBe(true);
    for (let i = 1; i < txns.length; i++) expect(txns[i].bookedAt >= txns[i - 1].bookedAt).toBe(true);

    const { openingBalance, rows } = reconcile(txns, currentBalance(key));
    expect(rows[rows.length - 1].balanceAfter).toBe(currentBalance(key));
    expect(openingBalance).toBeGreaterThanOrEqual(0);
    expect(Math.min(...rows.map((r) => r.balanceAfter))).toBeGreaterThanOrEqual(0);
  });

  it('andrei avg monthly outgoing (excl. transfer_internal/savings) between 8 000 and 10 500', () => {
    const txns = generateTransactions(PERSONAS.find((p) => p.key === 'andrei')!, opts);
    const out = txns
      .filter((t) => t.direction === 'out' && t.category !== 'transfer_internal' && t.category !== 'savings')
      .reduce((s, t) => s + t.amount, 0);
    expect(out / 6).toBeGreaterThanOrEqual(8000);
    expect(out / 6).toBeLessThanOrEqual(10500);
  });

  it('maria subscriptions monthly ≥ 150', () => {
    const txns = generateTransactions(PERSONAS.find((p) => p.key === 'maria')!, opts);
    const subs = txns.filter((t) => t.category === 'subscriptions').reduce((s, t) => s + t.amount, 0);
    expect(subs / 6).toBeGreaterThanOrEqual(150);
  });
});
