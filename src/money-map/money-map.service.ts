import { Injectable } from '@nestjs/common';
import { AccountType, Prisma } from '@prisma/client';
import { AccountsService } from '../banking/accounts.service';
import { snapshotWindow, StatsService } from '../banking/stats.service';
import { toMoney } from '../common/money';
import { config } from '../config/config';
import { GoalsService } from '../goals/goals.service';
import { generateOfferCandidates } from '../offers/offer-rules';
import { PrismaService } from '../prisma/prisma.service';
import { ProductsService } from '../products/products.service';
import { detectDebtPayments } from './lenders';
import { buildMoneyMap } from './money-map';
import type { MoneyMap, SituationAnswers, SituationDto } from './types';

/** Months in the snapshot window (the last 3 complete calendar months). */
const WINDOW_MONTHS = 3;

@Injectable()
export class MoneyMapService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly stats: StatsService,
    private readonly goals: GoalsService,
    private readonly products: ProductsService,
    private readonly accounts: AccountsService,
  ) {}

  async getSituation(userId: string): Promise<SituationDto> {
    const row = await this.prisma.situationProfile.findUnique({ where: { userId } });
    if (!row) return { answers: {}, completedAt: null };
    return { answers: row.answers as SituationAnswers, completedAt: row.completedAt?.toISOString() ?? null };
  }

  /** Replaces the answers and marks onboarding complete. */
  async putSituation(userId: string, answers: SituationAnswers): Promise<SituationDto> {
    // Drop undefined keys so the stored JSON holds only what was answered.
    const clean = JSON.parse(JSON.stringify(answers ?? {})) as SituationAnswers;
    const now = new Date();
    const row = await this.prisma.situationProfile.upsert({
      where: { userId },
      create: { userId, answers: clean as Prisma.InputJsonValue, completedAt: now },
      update: { answers: clean as Prisma.InputJsonValue, completedAt: now },
    });
    return { answers: row.answers as SituationAnswers, completedAt: row.completedAt?.toISOString() ?? null };
  }

  async getMoneyMap(userId: string, now = new Date()): Promise<MoneyMap> {
    const { start, end } = snapshotWindow(now);
    const [user, snapshot, goals, products, accounts, situation, txns] = await Promise.all([
      this.prisma.user.findUniqueOrThrow({ where: { id: userId } }),
      this.stats.snapshot(userId, now),
      this.goals.list(userId),
      this.products.getAll(),
      this.accounts.listForUser(userId),
      this.getSituation(userId),
      this.prisma.transaction.findMany({
        where: { account: { userId }, direction: 'out', bookedAt: { gte: start, lt: end } },
        select: { direction: true, amount: true, category: true, counterpartyName: true, description: true, bookedAt: true },
      }),
    ]);
    const monthlyIncome = user.monthlyIncome === null ? null : toMoney(user.monthlyIncome);
    const active = accounts.filter((a) => a.status === 'active');
    const candidates = generateOfferCandidates({
      user: { age: user.age, riskProfile: user.riskProfile, monthlyIncome },
      snapshot,
      goals,
      products,
      ownedAccountTypes: active.map((a) => a.type as AccountType),
      ownedProductSlugs: active.filter((a) => a.productSlug).map((a) => a.productSlug as string),
      interestTaxRate: config().INTEREST_TAX_RATE,
      now,
    });
    return buildMoneyMap({
      snapshot,
      goals,
      answers: situation.answers,
      situationComplete: situation.completedAt !== null,
      debt: detectDebtPayments(
        txns.map((t) => ({ ...t, amount: t.amount.toNumber() })),
        WINDOW_MONTHS,
      ),
      user: { riskProfile: user.riskProfile, monthlyIncome },
      products,
      candidates,
    });
  }
}
