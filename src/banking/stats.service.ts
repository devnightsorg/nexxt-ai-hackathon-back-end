import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/** Categories that move money between the user's own pots, not real income/spending. */
export const NON_FLOW_CATEGORIES = new Set(['transfer_internal', 'savings']);
const SAVINGS_TYPES = new Set(['savings', 'term_deposit', 'investment', 'pension', 'housing_savings']);
/** Returned when there is no spending to divide by (runway is effectively unlimited). */
export const MAX_RUNWAY_MONTHS = 999;

export interface StatTxn {
  direction: 'in' | 'out';
  amount: number;
  category: string;
  bookedAt: Date;
}

export interface StatAccount {
  type: string;
  balance: number;
}

export interface SpendingCategory {
  category: string;
  amount: number;
  count: number;
  share: number;
}

export interface SpendingStats {
  from: string;
  to: string;
  total: number;
  byCategory: SpendingCategory[];
}

export interface CashflowMonth {
  month: string;
  income: number;
  spending: number;
  net: number;
}

export interface FinancialSnapshot {
  asOf: string;
  totalBalance: number;
  balancesByType: Record<string, number>;
  currentAccountBalance: number;
  savingsBalance: number;
  creditCardDebt: number;
  avgMonthlyIncome: number;
  avgMonthlySpending: number;
  savingsRate: number;
  idleCash: number;
  monthsOfRunway: number;
  topSpendingCategories: { category: string; monthlyAvg: number }[];
  subscriptionsMonthly: number;
}

const r2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;
const cents = (n: number): number => Math.round(n * 100);

export const isSpending = (t: StatTxn): boolean => t.direction === 'out' && !NON_FLOW_CATEGORIES.has(t.category);
export const isIncome = (t: StatTxn): boolean => t.direction === 'in' && !NON_FLOW_CATEGORIES.has(t.category);

function monthStartUtc(year: number, month: number): Date {
  return new Date(Date.UTC(year, month, 1));
}

function monthKey(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** Spending (outgoing, non-transfer) in [from, to], by category sorted by amount desc. */
export function computeSpending(txns: StatTxn[], from: Date, to: Date): SpendingStats {
  const byCat = new Map<string, { cents: number; count: number }>();
  let totalCents = 0;
  for (const t of txns) {
    if (!isSpending(t) || t.bookedAt < from || t.bookedAt > to) continue;
    const c = cents(t.amount);
    totalCents += c;
    const e = byCat.get(t.category) ?? { cents: 0, count: 0 };
    e.cents += c;
    e.count += 1;
    byCat.set(t.category, e);
  }
  const byCategory = [...byCat.entries()]
    .map(([category, e]) => ({
      category,
      amount: e.cents / 100,
      count: e.count,
      share: totalCents === 0 ? 0 : r2(e.cents / totalCents),
    }))
    .sort((a, b) => b.amount - a.amount);
  return { from: from.toISOString(), to: to.toISOString(), total: totalCents / 100, byCategory };
}

/** The last `months` calendar months ending with the month of `now`, ascending. */
export function computeCashflow(txns: StatTxn[], months: number, now: Date): CashflowMonth[] {
  const buckets = new Map<string, { income: number; spending: number }>();
  const keys: string[] = [];
  for (let k = months - 1; k >= 0; k--) {
    const key = monthKey(monthStartUtc(now.getUTCFullYear(), now.getUTCMonth() - k));
    keys.push(key);
    buckets.set(key, { income: 0, spending: 0 });
  }
  for (const t of txns) {
    const b = buckets.get(monthKey(t.bookedAt));
    if (!b) continue;
    if (isIncome(t)) b.income += cents(t.amount);
    else if (isSpending(t)) b.spending += cents(t.amount);
  }
  return keys.map((month) => {
    const b = buckets.get(month)!;
    return { month, income: b.income / 100, spending: b.spending / 100, net: (b.income - b.spending) / 100 };
  });
}

/** Window of the last 3 complete calendar months before `now`: [start, end). */
export function snapshotWindow(now: Date): { start: Date; end: Date } {
  return {
    start: monthStartUtc(now.getUTCFullYear(), now.getUTCMonth() - 3),
    end: monthStartUtc(now.getUTCFullYear(), now.getUTCMonth()),
  };
}

export function computeSnapshot(accounts: StatAccount[], txns: StatTxn[], now: Date): FinancialSnapshot {
  const balancesByType: Record<string, number> = {};
  let totalBalance = 0;
  let currentAccountBalance = 0;
  let savingsBalance = 0;
  let creditCardDebt = 0;
  for (const a of accounts) {
    balancesByType[a.type] = r2((balancesByType[a.type] ?? 0) + a.balance);
    totalBalance += a.balance;
    if (a.type === 'current') currentAccountBalance += a.balance;
    if (SAVINGS_TYPES.has(a.type)) savingsBalance += a.balance;
    if (a.type === 'credit_card' && a.balance < 0) creditCardDebt += -a.balance;
  }

  const { start, end } = snapshotWindow(now);
  let incomeCents = 0;
  let spendingCents = 0;
  let subsCents = 0;
  const byCat = new Map<string, number>();
  for (const t of txns) {
    if (t.bookedAt < start || t.bookedAt >= end) continue;
    if (isIncome(t)) incomeCents += cents(t.amount);
    else if (isSpending(t)) {
      const c = cents(t.amount);
      spendingCents += c;
      byCat.set(t.category, (byCat.get(t.category) ?? 0) + c);
      if (t.category === 'subscriptions') subsCents += c;
    }
  }
  const avgMonthlyIncome = incomeCents / 100 / 3;
  const avgMonthlySpending = spendingCents / 100 / 3;

  return {
    asOf: now.toISOString(),
    totalBalance: r2(totalBalance),
    balancesByType,
    currentAccountBalance: r2(currentAccountBalance),
    savingsBalance: r2(savingsBalance),
    creditCardDebt: r2(creditCardDebt),
    avgMonthlyIncome: r2(avgMonthlyIncome),
    avgMonthlySpending: r2(avgMonthlySpending),
    savingsRate: avgMonthlyIncome === 0 ? 0 : r2((avgMonthlyIncome - avgMonthlySpending) / avgMonthlyIncome),
    idleCash: r2(Math.max(0, currentAccountBalance - avgMonthlySpending)),
    monthsOfRunway:
      avgMonthlySpending === 0 ? MAX_RUNWAY_MONTHS : r2(Math.max(0, currentAccountBalance) / avgMonthlySpending),
    topSpendingCategories: [...byCat.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([category, c]) => ({ category, monthlyAvg: r2(c / 100 / 3) })),
    subscriptionsMonthly: r2(subsCents / 100 / 3),
  };
}

@Injectable()
export class StatsService {
  constructor(private readonly prisma: PrismaService) {}

  async spending(userId: string, from: Date, to: Date): Promise<SpendingStats> {
    return computeSpending(await this.loadTxns(userId, from, to), from, to);
  }

  async cashflow(userId: string, months = 6, now = new Date()): Promise<CashflowMonth[]> {
    const n = Math.min(Math.max(Math.trunc(months), 1), 24);
    const start = monthStartUtc(now.getUTCFullYear(), now.getUTCMonth() - (n - 1));
    const end = monthStartUtc(now.getUTCFullYear(), now.getUTCMonth() + 1);
    return computeCashflow(await this.loadTxns(userId, start, end), n, now);
  }

  async snapshot(userId: string, now = new Date()): Promise<FinancialSnapshot> {
    const { start, end } = snapshotWindow(now);
    const [accounts, txns] = await Promise.all([
      this.prisma.account.findMany({ where: { userId, status: 'active' }, select: { type: true, balance: true } }),
      this.loadTxns(userId, start, end),
    ]);
    return computeSnapshot(
      accounts.map((a) => ({ type: a.type, balance: a.balance.toNumber() })),
      txns,
      now,
    );
  }

  private async loadTxns(userId: string, from: Date, to: Date): Promise<StatTxn[]> {
    const rows = await this.prisma.transaction.findMany({
      where: { account: { userId }, bookedAt: { gte: from, lte: to } },
      select: { direction: true, amount: true, category: true, bookedAt: true },
    });
    return rows.map((r) => ({ ...r, amount: r.amount.toNumber() }));
  }
}
