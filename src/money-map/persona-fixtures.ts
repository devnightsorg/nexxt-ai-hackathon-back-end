import { resolve } from 'node:path';
import { computeSnapshot, snapshotWindow } from '../banking/stats.service';
import type { GoalDto } from '../goals/dto';
import { generateOfferCandidates } from '../offers/offer-rules';
import { loadCatalogFrom } from '../products/products.service';
import { PERSONAS, PersonaKey } from '../seed/personas';
import { generateReconciled } from '../seed/transactions';
import { detectDebtPayments } from './lenders';
import type { MoneyMapInput } from './money-map';
import type { SituationAnswers } from './types';

/** Test fixture: a seed persona's money-map input, built the way the seed and the service build it. */
export const ANCHOR = new Date('2026-10-28T12:00:00Z');
const BASE_SEED = 42; // same as SeedService
const CATALOG = loadCatalogFrom(resolve(__dirname, '../../seed/knowledge'));

export function personaInput(key: PersonaKey, answers: SituationAnswers = {}): MoneyMapInput {
  const index = PERSONAS.findIndex((p) => p.key === key);
  const p = PERSONAS[index];
  const txns = p.accounts
    .filter((a) => a.type === 'current')
    .flatMap((a) => generateReconciled(p, a.balance, ANCHOR, BASE_SEED + index * 1000).rows);
  const snapshot = computeSnapshot(
    p.accounts.map((a) => ({ type: a.type, balance: a.balance })),
    txns,
    ANCHOR,
  );
  const goals: GoalDto[] = p.goals.map((g, i) => {
    const monthsLeft = g.monthsFromAnchor;
    return {
      id: `g${i}`,
      name: g.name,
      type: g.type,
      targetAmount: g.targetAmount,
      currency: 'RON',
      targetDate: null,
      linkedAccountId: null,
      priority: 2,
      status: 'active',
      currentAmount: 0,
      progressPct: 0,
      monthsLeft,
      requiredMonthlySaving: monthsLeft === null ? null : Math.round((g.targetAmount / Math.max(1, monthsLeft)) * 100) / 100,
    };
  });
  const { start, end } = snapshotWindow(ANCHOR);
  const user = { age: p.age, riskProfile: p.riskProfile, monthlyIncome: p.monthlyIncome };
  return {
    snapshot,
    goals,
    answers,
    situationComplete: Object.keys(answers).length > 0,
    debt: detectDebtPayments(
      txns.filter((t) => t.bookedAt >= start && t.bookedAt < end).map((t) => ({ ...t, counterpartyName: t.counterpartyName })),
      3,
    ),
    user: { riskProfile: p.riskProfile, monthlyIncome: p.monthlyIncome },
    products: CATALOG,
    candidates: generateOfferCandidates({
      user,
      snapshot,
      goals,
      products: CATALOG,
      ownedAccountTypes: p.accounts.map((a) => a.type),
      ownedProductSlugs: p.accounts.map((a) => a.productSlug),
      interestTaxRate: 0.1,
      now: ANCHOR,
    }),
  };
}
