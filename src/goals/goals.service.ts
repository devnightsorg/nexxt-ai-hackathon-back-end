import { Injectable, NotFoundException } from '@nestjs/common';
import { Account, Goal, GoalStatus, GoalType, Prisma } from '@prisma/client';
import { parseAmount, toMoney } from '../common/money';
import { PrismaService } from '../prisma/prisma.service';
import { GoalDto } from './dto';

export interface CreateGoalInput {
  name: string;
  type: GoalType;
  targetAmount: number;
  targetDate?: string;
  linkedAccountId?: string;
  priority?: number;
}

export interface UpdateGoalInput {
  name?: string;
  type?: GoalType;
  targetAmount?: number;
  targetDate?: string | null;
  linkedAccountId?: string | null;
  priority?: number;
  status?: GoalStatus;
  savedAmount?: number;
}

const GOAL_NOT_FOUND = 'Obiectivul nu există';
const ACCOUNT_NOT_FOUND = 'Contul nu există';
const AVG_MONTH_MS = 30.4375 * 24 * 60 * 60 * 1000;

type GoalWithAccount = Goal & { linkedAccount: Account | null };

/** Whole months left until `target` (rounded up, never negative). */
export function monthsUntil(target: Date, now: Date = new Date()): number {
  return Math.max(0, Math.ceil((target.getTime() - now.getTime()) / AVG_MONTH_MS));
}

export function toGoalDto(g: GoalWithAccount, now: Date = new Date()): GoalDto {
  const target = toMoney(g.targetAmount);
  const current = toMoney(g.linkedAccount ? g.linkedAccount.balance : g.savedAmount);
  const monthsLeft = g.targetDate ? monthsUntil(g.targetDate, now) : null;
  return {
    id: g.id,
    name: g.name,
    type: g.type,
    targetAmount: target,
    currency: g.currency,
    targetDate: g.targetDate ? g.targetDate.toISOString().slice(0, 10) : null,
    linkedAccountId: g.linkedAccountId,
    priority: g.priority,
    status: g.status,
    currentAmount: current,
    progressPct: target > 0 ? toMoney(Math.min(100, (current / target) * 100)) : 0,
    monthsLeft,
    requiredMonthlySaving: monthsLeft === null ? null : toMoney(Math.max(0, target - current) / Math.max(1, monthsLeft)),
  };
}

@Injectable()
export class GoalsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(userId: string): Promise<GoalDto[]> {
    const goals = await this.prisma.goal.findMany({
      where: { userId },
      include: { linkedAccount: true },
      orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }],
    });
    return goals.map((g) => toGoalDto(g));
  }

  async create(userId: string, dto: CreateGoalInput): Promise<GoalDto> {
    if (dto.linkedAccountId) await this.assertOwnedAccount(userId, dto.linkedAccountId);
    const goal = await this.prisma.goal.create({
      data: {
        userId,
        name: dto.name,
        type: dto.type,
        targetAmount: parseAmount(dto.targetAmount),
        targetDate: dto.targetDate ? new Date(dto.targetDate) : null,
        linkedAccountId: dto.linkedAccountId ?? null,
        priority: dto.priority ?? 2,
      },
      include: { linkedAccount: true },
    });
    return toGoalDto(goal);
  }

  async update(userId: string, id: string, dto: UpdateGoalInput): Promise<GoalDto> {
    await this.findOwned(userId, id);
    if (dto.linkedAccountId) await this.assertOwnedAccount(userId, dto.linkedAccountId);
    const data: Prisma.GoalUncheckedUpdateInput = {};
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.type !== undefined) data.type = dto.type;
    if (dto.targetAmount !== undefined) data.targetAmount = parseAmount(dto.targetAmount);
    if (dto.targetDate !== undefined) data.targetDate = dto.targetDate === null ? null : new Date(dto.targetDate);
    if (dto.linkedAccountId !== undefined) data.linkedAccountId = dto.linkedAccountId;
    if (dto.priority !== undefined) data.priority = dto.priority;
    if (dto.status !== undefined) data.status = dto.status;
    if (dto.savedAmount !== undefined) data.savedAmount = new Prisma.Decimal(dto.savedAmount);
    const goal = await this.prisma.goal.update({ where: { id }, data, include: { linkedAccount: true } });
    return toGoalDto(goal);
  }

  async remove(userId: string, id: string): Promise<void> {
    await this.findOwned(userId, id);
    await this.prisma.goal.delete({ where: { id } });
  }

  private async findOwned(userId: string, id: string): Promise<Goal> {
    const goal = await this.prisma.goal.findFirst({ where: { id, userId } });
    if (!goal) throw new NotFoundException(GOAL_NOT_FOUND);
    return goal;
  }

  /** Queries Prisma directly (AccountsService lives in the banking module, built separately). */
  private async assertOwnedAccount(userId: string, accountId: string): Promise<void> {
    const account = await this.prisma.account.findFirst({ where: { id: accountId, userId }, select: { id: true } });
    if (!account) throw new NotFoundException(ACCOUNT_NOT_FOUND);
  }
}
