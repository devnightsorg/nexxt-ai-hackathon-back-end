import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { toTransactionDto } from '../../banking/dto';
import { defineTool } from './types';
import { isoDateSchema, parseDate } from './schemas';

const DAY_MS = 24 * 60 * 60 * 1000;

export const getFinancialSnapshot = defineTool({
  name: 'get_financial_snapshot',
  description:
    'Overview of the user finances computed by the bank: total balance, balances by account type, average monthly income and spending, savings rate, idle cash, months of runway, top spending categories, subscriptions.',
  scope: 'accounts:read',
  schema: z.object({}),
  handler: (ctx) => ctx.deps.stats.snapshot(ctx.principal.userId),
});

export const getAccounts = defineTool({
  name: 'get_accounts',
  description:
    'Lists the user accounts (id, type, name, product, IBAN, ibanLast4, balance in RON, status). Use the account id in propose_* tools; when citing an account to the user use its name or exactly its ibanLast4.',
  scope: 'accounts:read',
  schema: z.object({}),
  handler: async (ctx) => {
    const accounts = await ctx.deps.accounts.listForUser(ctx.principal.userId);
    return accounts.map((a) => ({
      id: a.id,
      type: a.type,
      name: a.name,
      productSlug: a.productSlug,
      productName: a.productName,
      iban: a.iban,
      ibanLast4: a.iban.replace(/\s+/g, '').slice(-4),
      currency: a.currency,
      balance: a.balance,
      status: a.status,
    }));
  },
});

export const getTransactions = defineTool({
  name: 'get_transactions',
  description: 'Recent transactions across all user accounts, newest first. Optional ISO date range, category filter and limit (max 50).',
  scope: 'transactions:read',
  schema: z.object({
    from: isoDateSchema.optional(),
    to: isoDateSchema.optional(),
    category: z.string().max(60).optional(),
    limit: z.number().int().min(1).max(50).optional(),
  }),
  handler: async (ctx, args) => {
    const from = parseDate(args.from);
    const to = parseDate(args.to, true);
    const accounts = await ctx.deps.prisma.account.findMany({
      where: { userId: ctx.principal.userId },
      select: { id: true },
    });
    const where: Prisma.TransactionWhereInput = {
      accountId: { in: accounts.map((a) => a.id) },
      ...(from || to ? { bookedAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}),
      ...(args.category ? { category: args.category } : {}),
    };
    const rows = await ctx.deps.prisma.transaction.findMany({
      where,
      orderBy: [{ bookedAt: 'desc' }, { id: 'desc' }],
      take: args.limit ?? 20,
    });
    return { items: rows.map(toTransactionDto), count: rows.length };
  },
});

export const getSpendingStats = defineTool({
  name: 'get_spending_stats',
  description: 'Spending totals by category for an ISO date range (default: last 30 days).',
  scope: 'transactions:read',
  schema: z.object({ from: isoDateSchema.optional(), to: isoDateSchema.optional() }),
  handler: (ctx, args) => {
    const to = parseDate(args.to, true) ?? new Date();
    const from = parseDate(args.from) ?? new Date(to.getTime() - 30 * DAY_MS);
    return ctx.deps.stats.spending(ctx.principal.userId, from, to);
  },
});

export const BANKING_TOOLS = [getFinancialSnapshot, getAccounts, getTransactions, getSpendingStats];
