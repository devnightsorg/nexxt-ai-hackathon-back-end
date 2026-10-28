import { Injectable, NotFoundException } from '@nestjs/common';
import { Account, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AccountDto, parseDateParam, toAccountDto, toTransactionDto, TransactionDto } from './dto';

export interface TransactionsQuery {
  from?: string;
  to?: string;
  category?: string;
  limit?: number;
  offset?: number;
}

@Injectable()
export class AccountsService {
  constructor(private readonly prisma: PrismaService) {}

  async listForUser(userId: string): Promise<AccountDto[]> {
    const accounts = await this.prisma.account.findMany({
      where: { userId },
      include: { product: { select: { name: true } } },
      orderBy: { openedAt: 'asc' },
    });
    return accounts.map(toAccountDto);
  }

  /** 404 `Contul nu există` when missing or owned by someone else. */
  async getOwned(userId: string, accountId: string): Promise<Account> {
    const account = await this.prisma.account.findFirst({ where: { id: accountId, userId } });
    if (!account) throw new NotFoundException('Contul nu există');
    return account;
  }

  async listTransactions(
    userId: string,
    accountId: string,
    q: TransactionsQuery = {},
  ): Promise<{ items: TransactionDto[]; total: number }> {
    await this.getOwned(userId, accountId);
    const from = parseDateParam(q.from);
    const to = parseDateParam(q.to, true);
    const limit = Math.min(Math.max(Math.trunc(q.limit ?? 50), 1), 200);
    const offset = Math.max(Math.trunc(q.offset ?? 0), 0);

    const where: Prisma.TransactionWhereInput = {
      accountId,
      ...(from || to ? { bookedAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}),
      ...(q.category ? { category: q.category } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.transaction.findMany({
        where,
        orderBy: [{ bookedAt: 'desc' }, { id: 'desc' }],
        skip: offset,
        take: limit,
      }),
      this.prisma.transaction.count({ where }),
    ]);
    return { items: rows.map(toTransactionDto), total };
  }
}
