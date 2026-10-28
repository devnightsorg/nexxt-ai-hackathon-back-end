import { BadRequestException } from '@nestjs/common';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Account, Transaction } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsDefined, IsInt, IsOptional, IsString, MaxLength, Max, Min } from 'class-validator';
import { toMoney } from '../common/money';

export interface AccountDto {
  id: string;
  type: string;
  name: string;
  productSlug: string | null;
  productName: string | null;
  iban: string;
  currency: string;
  balance: number;
  status: string;
  terms: unknown;
  openedAt: Date;
}

export interface TransactionDto {
  id: string;
  accountId: string;
  direction: 'in' | 'out';
  amount: number;
  currency: string;
  category: string;
  counterpartyName: string | null;
  counterpartyIban: string | null;
  description: string | null;
  bookedAt: Date;
  balanceAfter: number;
}

export function toAccountDto(a: Account & { product?: { name: string } | null }): AccountDto {
  return {
    id: a.id,
    type: a.type,
    name: a.name,
    productSlug: a.productSlug,
    productName: a.product?.name ?? null,
    iban: a.iban,
    currency: a.currency,
    balance: toMoney(a.balance),
    status: a.status,
    terms: a.terms ?? null,
    openedAt: a.openedAt,
  };
}

export function toTransactionDto(t: Transaction): TransactionDto {
  return {
    id: t.id,
    accountId: t.accountId,
    direction: t.direction,
    amount: toMoney(t.amount),
    currency: t.currency,
    category: t.category,
    counterpartyName: t.counterpartyName,
    counterpartyIban: t.counterpartyIban,
    description: t.description,
    bookedAt: t.bookedAt,
    balanceAfter: toMoney(t.balanceAfter),
  };
}

/** Parses an ISO date query param; a bare `YYYY-MM-DD` used as an upper bound covers the whole day. */
export function parseDateParam(s: string | undefined, endOfDay = false): Date | undefined {
  if (s === undefined || s === '') return undefined;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) throw new BadRequestException('Dată invalidă');
  if (endOfDay && /^\d{4}-\d{2}-\d{2}$/.test(s)) d.setUTCHours(23, 59, 59, 999);
  return d;
}

export class TransactionsQueryDto {
  @ApiPropertyOptional({ example: '2026-09-01' })
  @IsOptional()
  @IsString()
  from?: string;

  @ApiPropertyOptional({ example: '2026-09-30' })
  @IsOptional()
  @IsString()
  to?: string;

  @ApiPropertyOptional({ example: 'groceries' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  category?: string;

  @ApiPropertyOptional({ default: 50, maximum: 200 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number;
}

export class SpendingQueryDto {
  @ApiPropertyOptional({ example: '2026-10-01', description: 'Default: first day of the current month' })
  @IsOptional()
  @IsString()
  from?: string;

  @ApiPropertyOptional({ example: '2026-10-31', description: 'Default: now' })
  @IsOptional()
  @IsString()
  to?: string;
}

export class CashflowQueryDto {
  @ApiPropertyOptional({ default: 6, minimum: 1, maximum: 24 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(24)
  months?: number;
}

export class CreatePaymentDto {
  @ApiProperty()
  @IsString()
  @MaxLength(64)
  fromAccountId!: string;

  @ApiPropertyOptional({ description: 'One of your own accounts (exclusive with toIban)' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  toAccountId?: string;

  @ApiPropertyOptional({ example: 'RO49AAAA1B31007593840000', description: 'Exclusive with toAccountId' })
  @IsOptional()
  @IsString()
  @MaxLength(42)
  toIban?: string;

  @ApiPropertyOptional({ example: 'Ion Popescu' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  beneficiaryName?: string;

  /** Validated by `parseAmount` (JSON number, > 0, max 2 decimals) so the error message stays Romanian. */
  @ApiProperty({ example: 100.5, type: Number })
  @IsDefined()
  amount!: unknown;

  @ApiPropertyOptional({ example: 'Chirie octombrie' })
  @IsOptional()
  @IsString()
  @MaxLength(140)
  description?: string;
}
