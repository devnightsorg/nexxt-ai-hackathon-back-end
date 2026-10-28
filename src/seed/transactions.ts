import { FlowSpec, PersonaSpec, TxnCategory } from './personas';
import { mulberry32 } from './rng';

export interface GeneratedTxn {
  direction: 'in' | 'out';
  amount: number;
  category: TxnCategory;
  counterpartyName: string;
  description: string;
  bookedAt: Date;
}

export interface GenerateOptions {
  anchor: Date;
  months: 6;
  seed: number;
}

const toCents = (n: number) => Math.round(n * 100);
const fromCents = (c: number) => c / 100;

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

function drawAmount(rng: () => number, a: number | [number, number]): number {
  if (typeof a === 'number') return a;
  const [min, max] = a;
  return fromCents(toCents(min) + Math.floor(rng() * (toCents(max) - toCents(min) + 1)));
}

function drawInt(rng: () => number, [min, max]: [number, number]): number {
  return min + Math.floor(rng() * (max - min + 1));
}

function flowEvents(flow: FlowSpec, rng: () => number, year: number, month: number, offset: number): GeneratedTxn[] {
  const dim = daysInMonth(year, month);
  if (flow.kind === 'fixed') {
    if (flow.everyOtherMonth && offset % 2 !== 0) return [];
    const day = Math.min(flow.day, dim);
    const hour = flow.direction === 'in' ? 8 : 10;
    return [
      {
        direction: flow.direction,
        amount: drawAmount(rng, flow.amount),
        category: flow.category,
        counterpartyName: flow.counterparty,
        description: flow.description,
        bookedAt: new Date(Date.UTC(year, month, day, hour, 0, 0)),
      },
    ];
  }
  if (flow.probability !== undefined && rng() >= flow.probability) return [];
  const n = drawInt(rng, flow.count);
  const out: GeneratedTxn[] = [];
  for (let i = 0; i < n; i++) {
    const merchant = flow.merchants[Math.floor(rng() * flow.merchants.length)];
    const day = 1 + Math.floor(rng() * dim);
    const hour = 9 + Math.floor(rng() * 13);
    const minute = Math.floor(rng() * 60);
    out.push({
      direction: 'out',
      amount: drawAmount(rng, flow.amount),
      category: flow.category,
      counterpartyName: merchant,
      description: `Plată card ${merchant}`,
      bookedAt: new Date(Date.UTC(year, month, day, hour, minute, 0)),
    });
  }
  return out;
}

/**
 * Current-account transactions for the 6 calendar months ending in the anchor's month
 * (events after the anchor are dropped), sorted by `bookedAt`. Deterministic for a given seed.
 */
export function generateTransactions(p: PersonaSpec, o: GenerateOptions): GeneratedTxn[] {
  const rng = mulberry32(o.seed);
  const months = o.months ?? 6;
  const all: GeneratedTxn[] = [];
  for (let offset = 0; offset < months; offset++) {
    const d = new Date(Date.UTC(o.anchor.getUTCFullYear(), o.anchor.getUTCMonth() - (months - 1) + offset, 1));
    const year = d.getUTCFullYear();
    const month = d.getUTCMonth();
    for (const flow of p.flows) all.push(...flowEvents(flow, rng, year, month, offset));
  }
  // Array.prototype.sort is stable, so same-timestamp events keep generation order.
  return all.filter((t) => t.bookedAt.getTime() <= o.anchor.getTime()).sort((a, b) => a.bookedAt.getTime() - b.bookedAt.getTime());
}

/**
 * Tries seeds `baseSeed`, `baseSeed + 1`, … and returns the first reconciled history whose opening and
 * running balances never go below 0 (or the least negative one after `attempts` tries). Deterministic.
 */
export function generateReconciled(
  p: PersonaSpec,
  targetBalance: number,
  anchor: Date,
  baseSeed: number,
  attempts = 50,
): ReturnType<typeof reconcile> & { seed: number; minBalance: number } {
  let best: (ReturnType<typeof reconcile> & { seed: number; minBalance: number }) | null = null;
  for (let i = 0; i < attempts; i++) {
    const seed = baseSeed + i;
    const r = reconcile(generateTransactions(p, { anchor, months: 6, seed }), targetBalance);
    const minBalance = r.rows.reduce((m, row) => Math.min(m, row.balanceAfter), r.openingBalance);
    if (!best || minBalance > best.minBalance) best = { ...r, seed, minBalance };
    if (minBalance >= 0) break;
  }
  return best!;
}

/** Opening balance = target − net; walks the rows so the final `balanceAfter` equals the target. */
export function reconcile(
  txns: GeneratedTxn[],
  targetBalance: number,
): { openingBalance: number; rows: (GeneratedTxn & { balanceAfter: number })[] } {
  const net = txns.reduce((s, t) => s + (t.direction === 'in' ? toCents(t.amount) : -toCents(t.amount)), 0);
  const opening = toCents(targetBalance) - net;
  let bal = opening;
  const rows = txns.map((t) => {
    bal += t.direction === 'in' ? toCents(t.amount) : -toCents(t.amount);
    return { ...t, balanceAfter: fromCents(bal) };
  });
  return { openingBalance: fromCents(opening), rows };
}
