import {
  BadRequestException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Account, AccountType, Prisma, Transaction } from '@prisma/client';
import { randomInt } from 'node:crypto';
import { generateIban } from './iban.util';

/** Structural subset of `CatalogProduct` (products module) needed to open an account. */
export interface LedgerProduct {
  slug: string;
  name: string;
  category: string;
}

export const CATEGORY_TO_ACCOUNT_TYPE: Readonly<Record<string, AccountType>> = {
  savings_account: 'savings',
  term_deposit: 'term_deposit',
  investment_fund: 'investment',
  private_pension: 'pension',
  housing_savings: 'housing_savings',
};

export interface TransferInput {
  userId: string;
  fromAccountId: string;
  toAccountId?: string;
  toIban?: string;
  counterpartyName?: string;
  amount: Prisma.Decimal;
  description: string;
  category?: string;
}

export interface OpenAccountInput {
  userId: string;
  product: LedgerProduct;
  fromAccountId: string;
  amount: Prisma.Decimal;
  termMonths?: number;
  annualRatePct: number | null;
}

function addMonthsUtc(d: Date, months: number): Date {
  const r = new Date(d);
  r.setUTCMonth(r.getUTCMonth() + months);
  return r;
}

/** The only code that moves money. Always runs inside a caller-provided Prisma transaction. */
@Injectable()
export class LedgerService {
  async transfer(
    tx: Prisma.TransactionClient,
    i: TransferInput,
  ): Promise<{ debit: Transaction; credit: Transaction | null }> {
    const amount = new Prisma.Decimal(i.amount);
    if (amount.lte(0) || amount.decimalPlaces() > 2) {
      throw new BadRequestException('Suma trebuie să fie un număr pozitiv cu maximum 2 zecimale');
    }

    const from = await tx.account.findFirst({ where: { id: i.fromAccountId, userId: i.userId } });
    if (!from) throw new NotFoundException('Contul nu există');

    let target: Account | null = null;
    if (i.toAccountId) {
      target = await tx.account.findFirst({ where: { id: i.toAccountId, userId: i.userId } });
      if (!target) throw new NotFoundException('Contul destinatar nu există');
    } else if (i.toIban) {
      const iban = i.toIban.replace(/\s+/g, '').toUpperCase();
      target = await tx.account.findUnique({ where: { iban } });
    } else {
      throw new BadRequestException('Destinatarul plății lipsește');
    }
    if (target && target.id === from.id) {
      throw new BadRequestException('Contul sursă și contul destinatar trebuie să fie diferite');
    }
    if (target && target.status !== 'active') {
      throw new UnprocessableEntityException('Contul destinatar este închis');
    }

    const own = target !== null && target.userId === i.userId;
    const category = i.category ?? (own ? 'transfer_internal' : 'other');
    const bookedAt = new Date();

    // Conditional debit: atomic check-and-decrement, safe under concurrent payments.
    const debited = await tx.account.updateMany({
      where: { id: from.id, userId: i.userId, status: 'active', balance: { gte: amount } },
      data: { balance: { decrement: amount } },
    });
    if (debited.count === 0) throw new UnprocessableEntityException('Fonduri insuficiente');
    const fromAfter = await tx.account.findUniqueOrThrow({ where: { id: from.id }, select: { balance: true } });

    const debit = await tx.transaction.create({
      data: {
        accountId: from.id,
        direction: 'out',
        amount,
        currency: from.currency,
        category,
        counterpartyName: i.counterpartyName ?? (own ? target!.name : null),
        counterpartyIban: target?.iban ?? i.toIban?.replace(/\s+/g, '').toUpperCase() ?? null,
        description: i.description,
        bookedAt,
        balanceAfter: fromAfter.balance,
      },
    });

    let credit: Transaction | null = null;
    if (target) {
      const credited = await tx.account.update({
        where: { id: target.id },
        data: { balance: { increment: amount } },
        select: { balance: true },
      });
      let senderName = from.name;
      if (!own) {
        const sender = await tx.user.findUnique({ where: { id: i.userId }, select: { fullName: true } });
        senderName = sender?.fullName ?? from.name;
      }
      credit = await tx.transaction.create({
        data: {
          accountId: target.id,
          direction: 'in',
          amount,
          currency: target.currency,
          category: own ? category : 'other',
          counterpartyName: senderName,
          counterpartyIban: from.iban,
          description: i.description,
          bookedAt,
          balanceAfter: credited.balance,
        },
      });
    }
    return { debit, credit };
  }

  async openAccount(tx: Prisma.TransactionClient, i: OpenAccountInput): Promise<Account> {
    const type = CATEGORY_TO_ACCOUNT_TYPE[i.product.category];
    if (!type) throw new BadRequestException('Acest produs nu poate fi deschis online');

    const termMonths = i.termMonths ?? null;
    const maturityDate = termMonths ? addMonthsUtc(new Date(), termMonths).toISOString().slice(0, 10) : null;
    const account = await tx.account.create({
      data: {
        userId: i.userId,
        type,
        productSlug: i.product.slug,
        name: i.product.name,
        iban: await this.newIban(tx),
        balance: new Prisma.Decimal(0),
        terms: { annualRatePct: i.annualRatePct, termMonths, maturityDate },
      },
    });
    await this.transfer(tx, {
      userId: i.userId,
      fromAccountId: i.fromAccountId,
      toAccountId: account.id,
      amount: i.amount,
      description: `Deschidere ${i.product.name}`,
      category: 'savings',
    });
    return tx.account.findUniqueOrThrow({ where: { id: account.id } });
  }

  private async newIban(tx: Prisma.TransactionClient): Promise<string> {
    for (let attempt = 0; attempt < 10; attempt++) {
      const iban = generateIban(randomInt(1_000_000, 2 ** 47));
      const exists = await tx.account.findUnique({ where: { iban }, select: { id: true } });
      if (!exists) return iban;
    }
    throw new Error('Could not allocate a unique IBAN');
  }
}
