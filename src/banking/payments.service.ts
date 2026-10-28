import { BadRequestException, HttpException, Injectable } from '@nestjs/common';
import { actorFromPrincipal, Principal } from '../auth/principal';
import { parseAmount, toMoney } from '../common/money';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../security/audit/audit.service';
import { toTransactionDto, TransactionDto } from './dto';
import { isValidIban } from './iban.util';
import { LedgerService } from './ledger.service';

export interface CreatePaymentInput {
  fromAccountId: string;
  toAccountId?: string;
  toIban?: string;
  beneficiaryName?: string;
  /** Raw input; validated by `parseAmount`. */
  amount: unknown;
  description?: string;
}

export interface PaymentResult {
  debit: TransactionDto;
  credit: TransactionDto | null;
  fromBalance: number;
}

function maskIban(iban: string): string {
  return iban.length > 8 ? `${iban.slice(0, 4)}…${iban.slice(-4)}` : iban;
}

@Injectable()
export class PaymentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly audit: AuditService,
  ) {}

  async create(p: Principal, dto: CreatePaymentInput): Promise<PaymentResult> {
    const toIban = dto.toIban ? dto.toIban.replace(/\s+/g, '').toUpperCase() : undefined;
    const auditBase = {
      ...actorFromPrincipal(p),
      userId: p.userId,
      resource: `account:${dto.fromAccountId}`,
    };
    const target = dto.toAccountId ? { toAccountId: dto.toAccountId } : { toIban: toIban ? maskIban(toIban) : null };

    let moved: Awaited<ReturnType<LedgerService['transfer']>>;
    try {
      const amount = parseAmount(dto.amount);
      if (!!dto.toAccountId === !!toIban) {
        throw new BadRequestException('Specificați exact unul dintre toAccountId și toIban');
      }
      if (toIban && !isValidIban(toIban)) throw new BadRequestException('IBAN invalid');

      moved = await this.prisma.$transaction((tx) =>
        this.ledger.transfer(tx, {
          userId: p.userId,
          fromAccountId: dto.fromAccountId,
          toAccountId: dto.toAccountId,
          toIban,
          counterpartyName: dto.beneficiaryName,
          amount,
          description: dto.description?.trim() || 'Transfer',
        }),
      );
    } catch (e) {
      // Never let a failing denial audit mask the original error.
      await this.audit
        .record({
          ...auditBase,
          action: 'payment.denied',
          verdict: 'blocked',
          details: {
            ...target,
            amount: typeof dto.amount === 'number' ? dto.amount : String(dto.amount),
            reason: e instanceof Error ? e.message : 'unknown',
            status: e instanceof HttpException ? e.getStatus() : 500,
          },
        })
        .catch(() => undefined);
      throw e;
    }

    const { debit, credit } = moved;
    const result: PaymentResult = {
      debit: toTransactionDto(debit),
      credit: credit ? toTransactionDto(credit) : null,
      fromBalance: toMoney(debit.balanceAfter),
    };
    await this.audit.record({
      ...auditBase,
      action: 'payment.executed',
      verdict: 'allowed',
      details: { ...target, amount: result.debit.amount, debitId: debit.id, internal: credit !== null },
    });
    return result;
  }
}
