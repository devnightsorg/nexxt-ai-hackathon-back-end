import { MONEY_MAP_CONFIG } from './config';

export type LenderKind = 'bank' | 'ifn' | 'bnpl';

export interface Lender {
  name: string;
  kind: LenderKind;
  /** Matched against the counterparty name (case-insensitive). */
  pattern: RegExp;
}

/** Known Romanian lenders: banks (instalments), non-bank lenders (IFN) and buy-now-pay-later providers. */
export const LENDERS: Lender[] = [
  { name: 'Provident', kind: 'ifn', pattern: /provident/i },
  { name: 'IUTE Credit', kind: 'ifn', pattern: /iute\s*credit/i },
  { name: 'Credius', kind: 'ifn', pattern: /credius/i },
  { name: 'Viva Credit', kind: 'ifn', pattern: /viva\s*credit/i },
  { name: 'Ferratum', kind: 'ifn', pattern: /ferratum/i },
  { name: 'Mokka', kind: 'bnpl', pattern: /mokka/i },
  { name: 'TBI Pay', kind: 'bnpl', pattern: /tbi\s*(pay|bank)/i },
  { name: 'Klarna', kind: 'bnpl', pattern: /klarna/i },
  { name: 'PayPo', kind: 'bnpl', pattern: /paypo/i },
  { name: 'BCR', kind: 'bank', pattern: /\bbcr\b/i },
  { name: 'BRD', kind: 'bank', pattern: /\bbrd\b/i },
  { name: 'Banca Transilvania', kind: 'bank', pattern: /banca transilvania|\bbt\b/i },
  { name: 'ING Bank', kind: 'bank', pattern: /\bing\b/i },
  { name: 'Raiffeisen Bank', kind: 'bank', pattern: /raiffeisen/i },
  { name: 'UniCredit', kind: 'bank', pattern: /unicredit/i },
  { name: 'CEC Bank', kind: 'bank', pattern: /\bcec\b/i },
];

/** A bank counterparty only counts as a debt payment when the booking looks like a loan instalment. */
const LOAN_TEXT_RE = /\brat[aă]\b|credit|loan|[iî]mprumut|instal/i;

export interface DebtTxn {
  direction: 'in' | 'out';
  amount: number;
  category: string;
  counterpartyName: string | null;
  description: string | null;
  bookedAt: Date;
}

export interface DebtPayment {
  lender: string;
  kind: LenderKind;
  monthlyAvg: number;
  months: number;
}

export interface DebtSummary {
  payments: DebtPayment[];
  /** Average monthly payments to every detected lender. */
  monthlyTotal: number;
  /** Average monthly payments to IFNs and BNPL providers. */
  expensiveMonthly: number;
}

const r2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

export function matchLender(t: Pick<DebtTxn, 'counterpartyName' | 'description'>): Lender | null {
  const name = t.counterpartyName ?? '';
  const lender = LENDERS.find((l) => l.pattern.test(name));
  if (!lender) return null;
  if (lender.kind === 'bank' && !LOAN_TEXT_RE.test(`${name} ${t.description ?? ''}`)) return null;
  return lender;
}

/**
 * Recurring outgoing payments to known lenders over `windowMonths` months: a lender must be paid in at least
 * `debtMinMonths` distinct months. Own-account moves (`transfer_internal`, e.g. paying one's own card) are skipped.
 */
export function detectDebtPayments(txns: DebtTxn[], windowMonths: number): DebtSummary {
  const byLender = new Map<string, { lender: Lender; cents: number; months: Set<string> }>();
  for (const t of txns) {
    if (t.direction !== 'out' || t.category === 'transfer_internal') continue;
    const lender = matchLender(t);
    if (!lender) continue;
    const e = byLender.get(lender.name) ?? { lender, cents: 0, months: new Set<string>() };
    e.cents += Math.round(t.amount * 100);
    e.months.add(`${t.bookedAt.getUTCFullYear()}-${t.bookedAt.getUTCMonth()}`);
    byLender.set(lender.name, e);
  }
  const payments = [...byLender.values()]
    .filter((e) => e.months.size >= MONEY_MAP_CONFIG.debtMinMonths)
    .map((e) => ({
      lender: e.lender.name,
      kind: e.lender.kind,
      monthlyAvg: r2(e.cents / 100 / Math.max(1, windowMonths)),
      months: e.months.size,
    }))
    .sort((a, b) => b.monthlyAvg - a.monthlyAvg || a.lender.localeCompare(b.lender));
  const sum = (list: DebtPayment[]) => r2(list.reduce((s, p) => s + p.monthlyAvg, 0));
  return {
    payments,
    monthlyTotal: sum(payments),
    expensiveMonthly: sum(payments.filter((p) => p.kind !== 'bank')),
  };
}
