import type { RiskProfile } from '@prisma/client';
import type { FinancialSnapshot } from '../banking/stats.service';
import type { GoalDto } from '../goals/dto';
import type { OfferCandidate } from '../offers/offer-rules';
import type { CatalogProduct } from '../products/catalog.types';
import { buildHeadline } from './headline';
import { evaluateLadder } from './ladder';
import type { DebtSummary } from './lenders';
import { rankActions } from './ranker';
import type { MoneyMap, SituationAnswers } from './types';

export interface MoneyMapInput {
  snapshot: FinancialSnapshot;
  goals: GoalDto[];
  answers: SituationAnswers;
  situationComplete: boolean;
  debt: DebtSummary;
  user: { riskProfile: RiskProfile; monthlyIncome: number | null };
  products: CatalogProduct[];
  /** Offer-rule candidates for this user (`generateOfferCandidates`). */
  candidates: OfferCandidate[];
}

/** Pure: ladder → pillars → headline → actions. Code decides every status, product and number. */
export function buildMoneyMap(i: MoneyMapInput): MoneyMap {
  const ladder = evaluateLadder({
    snapshot: i.snapshot,
    goals: i.goals,
    answers: i.answers,
    debt: i.debt,
    declaredIncome: i.user.monthlyIncome,
  });
  return {
    headline: buildHeadline(ladder, i.debt),
    pillars: ladder.pillars,
    ladder: ladder.ladder,
    currentStep: ladder.currentStep,
    situationComplete: i.situationComplete,
    conflicts: ladder.conflicts,
    actions: rankActions({
      ladder,
      candidates: i.candidates,
      products: i.products,
      goals: i.goals,
      answers: i.answers,
      riskProfile: i.user.riskProfile,
      snapshot: i.snapshot,
      debt: i.debt,
    }),
  };
}
