import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ActionProposal, ActionStatus, Prisma } from '@prisma/client';
import { actorFromPrincipal, Principal } from '../auth/principal';
import { formatRon, toMoney } from '../common/money';
import { config } from '../config/config';
import { isValidIban } from '../banking/iban.util';
import { LedgerService } from '../banking/ledger.service';
import { PrismaService } from '../prisma/prisma.service';
import { CatalogProduct } from '../products/catalog.types';
import { ProductsService } from '../products/products.service';
import { AuditService } from '../security/audit/audit.service';
import { annualRateFor, evaluatePolicy, PolicyContext, PolicyDeniedException, PolicyVerdict, ProposeInput } from './policy';

export interface ProposalDto {
  id: string;
  type: 'transfer' | 'open_product';
  status: ActionStatus;
  /** Agent conversation the proposal was made in (null for REST/offer/MCP proposals). */
  conversationId: string | null;
  /** Offer whose acceptance created the proposal. */
  offerId: string | null;
  payload: Record<string, unknown>;
  summary: string;
  policyVerdict: PolicyVerdict;
  expiresAt: Date;
  createdAt: Date;
  decidedAt: Date | null;
  result: unknown;
}

const NOT_CONFIRMABLE = 'Propunerea nu mai poate fi confirmată';
const ACTION_STATUSES: ActionStatus[] = ['pending', 'rejected', 'executed', 'failed', 'expired'];

function maskIban(iban: string): string {
  return iban.length > 8 ? `${iban.slice(0, 4)}…${iban.slice(-4)}` : iban;
}

function monthsLabel(n: number): string {
  return n === 1 ? '1 lună' : `${n} luni`;
}

function startOfTodayUtc(): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

function payloadAmount(payload: Prisma.JsonValue): number {
  const a = (payload as { amount?: unknown } | null)?.amount;
  return typeof a === 'number' && Number.isFinite(a) ? a : 0;
}

export function toProposalDto(row: ActionProposal): ProposalDto {
  const { summary, ...payload } = (row.payload ?? {}) as Record<string, unknown>;
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    conversationId: row.conversationId,
    offerId: row.offerId,
    payload,
    summary: typeof summary === 'string' ? summary : '',
    policyVerdict: row.policyVerdict as unknown as PolicyVerdict,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
    decidedAt: row.decidedAt,
    result: row.result ?? null,
  };
}

export type GoalContribution =
  | { goalId: string; via: 'linked_account'; accountId: string }
  | { goalId: string; via: 'saved_amount'; amount: number };

/**
 * Counts executed money toward a goal (same transaction as the ledger booking):
 * money landing in the goal's linked account is already counted by its balance; a newly opened account
 * becomes the goal's linked account when it has none; anything else is added to `savedAmount`.
 * A goal deleted in the meantime is skipped.
 */
export async function applyGoalContribution(
  tx: Prisma.TransactionClient,
  userId: string,
  goalId: string,
  amount: Prisma.Decimal,
  target: { accountId: string | null; opened: boolean },
): Promise<GoalContribution | null> {
  const goal = await tx.goal.findFirst({ where: { id: goalId, userId }, select: { id: true, linkedAccountId: true } });
  if (!goal) return null;
  if (target.accountId && goal.linkedAccountId === target.accountId) {
    return { goalId: goal.id, via: 'linked_account', accountId: target.accountId };
  }
  if (target.opened && target.accountId && !goal.linkedAccountId) {
    await tx.goal.update({ where: { id: goal.id }, data: { linkedAccountId: target.accountId } });
    return { goalId: goal.id, via: 'linked_account', accountId: target.accountId };
  }
  await tx.goal.update({ where: { id: goal.id }, data: { savedAmount: { increment: amount } } });
  return { goalId: goal.id, via: 'saved_amount', amount: toMoney(amount) };
}

interface ResolvedContext {
  ctx: PolicyContext;
  names: { source: string | null; target: string | null; product: string | null };
}

export interface ProposeMeta {
  proposedVia: string;
  conversationId?: string;
  offerId?: string;
}

export interface ListProposalsFilter {
  status?: string;
  conversationId?: string;
}

@Injectable()
export class ActionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly products: ProductsService,
    private readonly audit: AuditService,
  ) {}

  async propose(p: Principal, i: ProposeInput, meta: ProposeMeta): Promise<ProposalDto> {
    this.requireScope(p, 'actions:propose');
    const input = this.normalize(i);
    const goalName = input.goalId ? await this.goalName(p.userId, input.goalId) : null;
    const { ctx, names } = await this.buildContext(p, input);
    const verdict = evaluatePolicy(ctx);
    const auditBase = { ...actorFromPrincipal(p), userId: p.userId };

    if (!verdict.allowed) {
      await this.audit.record({
        ...auditBase,
        action: 'policy.denied',
        verdict: 'blocked',
        details: { type: input.type, amount: ctx.amount, violations: verdict.violations, proposedVia: meta.proposedVia },
      });
      throw new PolicyDeniedException(verdict.violations);
    }

    const summary = this.summarize(input, names) + (goalName ? `, pentru „${goalName}”` : '');
    const expiresAt = new Date(Date.now() + config().ACTION_TTL_MINUTES * 60_000);
    const row = await this.prisma.actionProposal.create({
      data: {
        userId: p.userId,
        conversationId: meta.conversationId ?? null,
        offerId: meta.offerId ?? null,
        type: input.type,
        payload: { ...input, summary } as unknown as Prisma.InputJsonValue,
        policyVerdict: verdict as unknown as Prisma.InputJsonValue,
        status: 'pending',
        proposedVia: meta.proposedVia,
        expiresAt,
      },
    });
    await this.audit.record({
      ...auditBase,
      action: 'action.proposed',
      resource: `action:${row.id}`,
      details: {
        type: input.type,
        amount: ctx.amount,
        riskLevel: verdict.riskLevel,
        proposedVia: meta.proposedVia,
        ...(input.goalId ? { goalId: input.goalId } : {}),
        ...(meta.offerId ? { offerId: meta.offerId } : {}),
      },
    });
    return toProposalDto(row);
  }

  async list(p: Principal, f: ListProposalsFilter = {}): Promise<ProposalDto[]> {
    const { status, conversationId } = f;
    if (status !== undefined && !ACTION_STATUSES.includes(status as ActionStatus)) {
      throw new BadRequestException('Status invalid');
    }
    await this.prisma.actionProposal.updateMany({
      where: { userId: p.userId, status: 'pending', expiresAt: { lte: new Date() } },
      data: { status: 'expired' },
    });
    const rows = await this.prisma.actionProposal.findMany({
      where: {
        userId: p.userId,
        ...(status ? { status: status as ActionStatus } : {}),
        ...(conversationId ? { conversationId } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return rows.map(toProposalDto);
  }

  async get(p: Principal, id: string): Promise<ProposalDto> {
    return toProposalDto(await this.findOwn(p, id));
  }

  async confirm(p: Principal, id: string): Promise<ProposalDto> {
    if (p.kind !== 'user' && !p.scopes.includes('actions:confirm')) {
      throw new ForbiddenException('Cheia API nu are dreptul de a confirma acțiuni');
    }
    await this.findOwn(p, id);
    const now = new Date();
    const confirmedBy = p.kind === 'api_key' ? `api_key:${p.apiKeyId ?? ''}` : `user:${p.userId}`;
    const claimed = await this.prisma.actionProposal.updateMany({
      where: { id, userId: p.userId, status: 'pending', expiresAt: { gt: now } },
      data: { status: 'executed', decidedAt: now, confirmedBy },
    });
    if (claimed.count === 0) {
      await this.expireIfStale(id);
      throw new ConflictException(NOT_CONFIRMABLE);
    }

    const row = await this.prisma.actionProposal.findUniqueOrThrow({ where: { id } });
    const input = row.payload as unknown as ProposeInput;
    const auditBase = { ...actorFromPrincipal(p), userId: p.userId, resource: `action:${id}` };

    const fail = async (result: Record<string, unknown>) => {
      await this.prisma.actionProposal.update({
        where: { id },
        data: { status: 'failed', result: result as Prisma.InputJsonValue },
      });
      await this.audit.record({ ...auditBase, action: 'action.failed', verdict: 'blocked', details: result }).catch(() => undefined);
    };

    const { ctx } = await this.buildContext(p, input, id);
    const verdict = evaluatePolicy(ctx);
    if (!verdict.allowed) {
      await fail({ violations: verdict.violations });
      throw new PolicyDeniedException(verdict.violations);
    }

    await this.audit.record({ ...auditBase, action: 'action.confirmed', details: { type: input.type, confirmedBy } });

    let result: Record<string, unknown>;
    try {
      result = await this.execute(p, input, ctx.product);
    } catch (e) {
      await fail({
        error: e instanceof Error ? e.message : 'unknown',
        status: e instanceof HttpException ? e.getStatus() : 500,
      });
      throw e;
    }

    const done = await this.prisma.actionProposal.update({
      where: { id },
      data: { result: result as Prisma.InputJsonValue },
    });
    await this.audit.record({ ...auditBase, action: 'action.executed', details: { type: input.type, amount: ctx.amount, ...result } });
    return toProposalDto(done);
  }

  async reject(p: Principal, id: string): Promise<ProposalDto> {
    this.requireScope(p, 'actions:propose');
    await this.findOwn(p, id);
    const claimed = await this.prisma.actionProposal.updateMany({
      where: { id, userId: p.userId, status: 'pending', expiresAt: { gt: new Date() } },
      data: { status: 'rejected', decidedAt: new Date() },
    });
    if (claimed.count === 0) {
      await this.expireIfStale(id);
      throw new ConflictException('Propunerea nu mai poate fi respinsă');
    }
    await this.audit.record({
      ...actorFromPrincipal(p),
      userId: p.userId,
      resource: `action:${id}`,
      action: 'action.rejected',
    });
    return toProposalDto(await this.prisma.actionProposal.findUniqueOrThrow({ where: { id } }));
  }

  // ---------------------------------------------------------------------------

  private requireScope(p: Principal, scope: 'actions:propose' | 'actions:confirm'): void {
    if (p.kind !== 'user' && !p.scopes.includes(scope)) throw new ForbiddenException(`Lipsește permisiunea ${scope}`);
  }

  /** Own proposal or 404; a pending proposal past `expiresAt` is stored and reported as `expired`. */
  private async findOwn(p: Principal, id: string): Promise<ActionProposal> {
    const row = await this.prisma.actionProposal.findFirst({ where: { id, userId: p.userId } });
    if (!row) throw new NotFoundException('Propunerea nu există');
    if (row.status === 'pending' && row.expiresAt <= new Date()) {
      return this.prisma.actionProposal.update({ where: { id }, data: { status: 'expired' } });
    }
    return row;
  }

  private async expireIfStale(id: string): Promise<void> {
    await this.prisma.actionProposal.updateMany({
      where: { id, status: 'pending', expiresAt: { lte: new Date() } },
      data: { status: 'expired' },
    });
  }

  private normalize(i: ProposeInput): ProposeInput {
    if (!i || (i.type !== 'transfer' && i.type !== 'open_product')) {
      throw new BadRequestException('Tipul acțiunii trebuie să fie transfer sau open_product');
    }
    if (typeof i.fromAccountId !== 'string' || !i.fromAccountId) {
      throw new BadRequestException('Contul sursă lipsește');
    }
    const reason = typeof i.reason === 'string' && i.reason.trim() ? i.reason.trim().slice(0, 300) : undefined;
    const goal = typeof i.goalId === 'string' && i.goalId.trim() ? { goalId: i.goalId.trim() } : {};
    if (i.type === 'transfer') {
      const toIban = i.toIban ? i.toIban.replace(/\s+/g, '').toUpperCase() : undefined;
      if (i.toAccountId && toIban) throw new BadRequestException('Specificați exact unul dintre toAccountId și toIban');
      return {
        type: 'transfer',
        fromAccountId: i.fromAccountId,
        ...(i.toAccountId ? { toAccountId: i.toAccountId } : {}),
        ...(toIban ? { toIban } : {}),
        ...(i.beneficiaryName ? { beneficiaryName: i.beneficiaryName.trim().slice(0, 120) } : {}),
        amount: i.amount,
        ...(reason ? { reason } : {}),
        ...goal,
      };
    }
    if (typeof i.productSlug !== 'string' || !i.productSlug) throw new BadRequestException('Produsul lipsește');
    if (i.termMonths !== undefined && (!Number.isInteger(i.termMonths) || i.termMonths <= 0)) {
      throw new BadRequestException('Termen invalid');
    }
    return {
      type: 'open_product',
      productSlug: i.productSlug,
      fromAccountId: i.fromAccountId,
      amount: i.amount,
      ...(i.termMonths !== undefined ? { termMonths: i.termMonths } : {}),
      ...(reason ? { reason } : {}),
      ...goal,
    };
  }

  /** Name of one of the user's goals, or 404 (a proposal never points at someone else's goal). */
  private async goalName(userId: string, goalId: string): Promise<string> {
    const goal = await this.prisma.goal.findFirst({ where: { id: goalId, userId }, select: { name: true } });
    if (!goal) throw new NotFoundException('Obiectivul nu există');
    return goal.name;
  }

  private async buildContext(p: Principal, input: ProposeInput, excludeProposalId?: string): Promise<ResolvedContext> {
    const amount = typeof input.amount === 'number' ? input.amount : Number.NaN;
    const cfg = config();

    const [user, sourceRow, usedRows] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: p.userId }, select: { riskProfile: true } }),
      this.prisma.account.findFirst({ where: { id: input.fromAccountId, userId: p.userId } }),
      this.prisma.actionProposal.findMany({
        where: {
          userId: p.userId,
          status: 'executed',
          decidedAt: { gte: startOfTodayUtc() },
          ...(excludeProposalId ? { id: { not: excludeProposalId } } : {}),
        },
        select: { payload: true },
      }),
    ]);

    const source = sourceRow
      ? {
          id: sourceRow.id,
          userId: sourceRow.userId,
          type: sourceRow.type,
          status: sourceRow.status,
          balance: toMoney(sourceRow.balance),
        }
      : null;

    let target: PolicyContext['target'] = null;
    let product: CatalogProduct | null = null;
    let targetName: string | null = null;
    if (input.type === 'transfer') {
      if (input.toAccountId) {
        const t = await this.prisma.account.findFirst({ where: { id: input.toAccountId, userId: p.userId } });
        if (t) {
          target = { kind: 'own_account', id: t.id, status: t.status };
          targetName = t.name;
        }
      } else if (input.toIban) {
        const own = await this.prisma.account.findFirst({ where: { iban: input.toIban, userId: p.userId } });
        if (own) {
          target = { kind: 'own_account', id: own.id, status: own.status };
          targetName = own.name;
        } else {
          target = { kind: 'external_iban', ibanValid: isValidIban(input.toIban) };
          targetName = input.beneficiaryName ?? maskIban(input.toIban);
        }
      }
    } else {
      product = await this.products.get(input.productSlug).catch(() => null);
    }

    const ctx: PolicyContext = {
      principal: p,
      input,
      amount,
      source,
      target,
      product,
      userRiskProfile: user?.riskProfile ?? 'conservative',
      usedTodayViaActions: usedRows.reduce((s, r) => s + payloadAmount(r.payload), 0),
      limits: { maxPerAction: cfg.POLICY_MAX_PER_ACTION, dailyLimit: cfg.POLICY_DAILY_LIMIT },
    };
    return { ctx, names: { source: sourceRow?.name ?? null, target: targetName, product: product?.name ?? null } };
  }

  private summarize(input: ProposeInput, names: ResolvedContext['names']): string {
    const amount = `${formatRon(input.amount)} RON`;
    const from = names.source ?? 'cont';
    if (input.type === 'transfer') {
      const to = names.target ?? 'destinatar';
      return input.toAccountId ? `Transfer ${amount} din ${from} în ${to}` : `Transfer ${amount} din ${from} către ${to}`;
    }
    const term = input.termMonths ? `, pe ${monthsLabel(input.termMonths)}` : '';
    return `Deschidere ${names.product ?? input.productSlug} cu ${amount} din ${from}${term}`;
  }

  private async execute(p: Principal, input: ProposeInput, product: CatalogProduct | null): Promise<Record<string, unknown>> {
    const amount = new Prisma.Decimal(input.amount);
    if (input.type === 'transfer') {
      return this.prisma.$transaction(async (tx) => {
        const { debit, credit } = await this.ledger.transfer(tx, {
          userId: p.userId,
          fromAccountId: input.fromAccountId,
          toAccountId: input.toAccountId,
          toIban: input.toIban,
          counterpartyName: input.beneficiaryName,
          amount,
          description: input.reason || 'Transfer',
        });
        const ownTarget = credit
          ? await tx.account.findFirst({ where: { id: credit.accountId, userId: p.userId }, select: { id: true } })
          : null;
        const goal = input.goalId
          ? await applyGoalContribution(tx, p.userId, input.goalId, amount, { accountId: ownTarget?.id ?? null, opened: false })
          : null;
        return { debitTransactionId: debit.id, creditTransactionId: credit?.id ?? null, ...(goal ? { goal } : {}) };
      });
    }
    if (!product) throw new NotFoundException('Produsul nu există');
    const termMonths = product.category === 'term_deposit' ? input.termMonths : undefined;
    return this.prisma.$transaction(async (tx) => {
      const account = await this.ledger.openAccount(tx, {
        userId: p.userId,
        product: { slug: product.slug, name: product.name, category: product.category },
        fromAccountId: input.fromAccountId,
        amount,
        termMonths,
        annualRatePct: annualRateFor(product, input.termMonths),
      });
      const goal = input.goalId
        ? await applyGoalContribution(tx, p.userId, input.goalId, amount, { accountId: account.id, opened: true })
        : null;
      return { accountId: account.id, accountType: account.type, balance: toMoney(account.balance), ...(goal ? { goal } : {}) };
    });
  }
}
