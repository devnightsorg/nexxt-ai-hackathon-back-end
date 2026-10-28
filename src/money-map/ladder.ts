import type { FinancialSnapshot } from '../banking/stats.service';
import type { GoalDto } from '../goals/dto';
import { MONEY_MAP_CONFIG as C, STEP_KEYS } from './config';
import type { DebtSummary } from './lenders';
import type { BufferBand, Conflict, LadderStep, Pillar, PillarKey, SituationAnswers, StepStatus, Tri } from './types';

export interface LadderInput {
  snapshot: FinancialSnapshot;
  goals: GoalDto[];
  answers: SituationAnswers;
  debt: DebtSummary;
  /** Declared monthly income (used when transactions show none). */
  declaredIncome: number | null;
}

/** Numbers the ladder was built from; the headline and the actions quote them. */
export interface LadderFacts {
  hasData: boolean;
  income: number;
  spending: number;
  surplus: number;
  surplusRatio: number;
  bufferMonths: number;
  emergencyTargetMonths: number;
  dti: number;
  creditCardDebt: number;
  goalsRequiredMonthly: number;
  hasPension: boolean;
}

export interface LadderResult {
  ladder: LadderStep[];
  pillars: Pillar[];
  currentStep: number;
  conflicts: Conflict[];
  facts: LadderFacts;
}

const r1 = (n: number): number => Math.round(n * 10) / 10;
const r2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;
const lei = (n: number): string => `${Math.round(n).toLocaleString('en-US')} lei`;
const pct = (n: number): string => `${Math.round(n * 100)}%`;
const monthsText = (n: number): string => `${r1(n)} ${r1(n) === 1 ? 'month' : 'months'}`;

const yes = (v: Tri | undefined): boolean => v === true;
const no = (v: Tri | undefined): boolean => v === false;

/** Liquid buffer in months of spending: current account (runway) plus easy-access savings. */
export function bufferMonthsOf(s: FinancialSnapshot): number {
  if (s.avgMonthlySpending <= 0) return s.monthsOfRunway;
  return r2(s.monthsOfRunway + (s.balancesByType.savings ?? 0) / s.avgMonthlySpending);
}

export function bandOf(months: number): Exclude<BufferBand, 'unknown'> {
  if (months < 1) return 'lt1';
  if (months < 3) return '1_3';
  if (months < 6) return '3_6';
  return '6_plus';
}

const BAND_MIN: Record<Exclude<BufferBand, 'unknown'>, number> = { lt1: 0, '1_3': 1, '3_6': 3, '6_plus': 6 };

const SEVERITY: Record<StepStatus, number> = { red: 3, amber: 2, green: 1, grey: 0 };

/** Worst status; grey only when every status is grey. */
export function worst(statuses: StepStatus[]): StepStatus {
  return statuses.reduce<StepStatus>((w, s) => (SEVERITY[s] > SEVERITY[w] ? s : w), 'grey');
}

export function evaluateLadder(i: LadderInput): LadderResult {
  const s = i.snapshot;
  const a = i.answers;
  const conflicts: Conflict[] = [];
  const hasData = s.avgMonthlyIncome > 0 || s.avgMonthlySpending > 0;
  const income = s.avgMonthlyIncome > 0 ? s.avgMonthlyIncome : (i.declaredIncome ?? 0);
  const spending = s.avgMonthlySpending;
  const surplus = r2(income - spending);
  const surplusRatio = income > 0 ? surplus / income : surplus >= 0 ? 0 : -1;
  const bufferMonths = hasData ? bufferMonthsOf(s) : 0;
  const dti = income > 0 ? i.debt.monthlyTotal / income : 0;
  const hasDependents = yes(a.dependents) || yes(a.has_children);
  const emergencyTargetMonths =
    no(a.income_stable) || hasDependents ? C.emergencyFundMonthsHigh : C.emergencyFundMonths;
  const hasPension = 'pension' in s.balancesByType;
  const activeGoals = i.goals.filter((g) => g.status === 'active');
  const goalsRequiredMonthly = r2(activeGoals.reduce((t, g) => t + (g.requiredMonthlySaving ?? 0), 0));

  const step = (n: number, status: StepStatus, reason: string): LadderStep => ({
    step: n,
    key: STEP_KEYS[n - 1],
    status,
    reason,
  });

  // 1 · Cash flow
  let s1: LadderStep;
  if (hasData) {
    if (a.month_end_surplus === true && surplus < 0) {
      conflicts.push({
        field: 'month_end_surplus',
        answer: true,
        evidence: `Spending averaged ${lei(spending)}/month against ${lei(income)} income over the last 3 months.`,
      });
    } else if (a.month_end_surplus === false && surplusRatio >= C.surplusAmberRatio) {
      conflicts.push({
        field: 'month_end_surplus',
        answer: false,
        evidence: `On average ${lei(surplus)} was left each month over the last 3 months.`,
      });
    }
    if (surplus < 0) s1 = step(1, 'red', `You spend ${lei(-surplus)} more than you earn each month.`);
    else if (yes(a.relies_on_credit)) s1 = step(1, 'red', 'You told us you rely on credit to get to the end of the month.');
    else if (surplusRatio < C.surplusAmberRatio)
      s1 = step(1, 'amber', `Only ${lei(surplus)} (${pct(surplusRatio)} of income) is left at month end.`);
    else s1 = step(1, 'green', `You keep ${lei(surplus)} (${pct(surplusRatio)} of income) each month.`);
  } else if (no(a.month_end_surplus) || yes(a.relies_on_credit)) {
    s1 = step(1, 'red', 'You told us the money does not last until the end of the month.');
  } else if (yes(a.month_end_surplus)) {
    s1 = step(1, 'green', 'You told us you have money left at the end of the month.');
  } else {
    s1 = step(1, 'grey', 'No transactions or answers about your monthly cash flow yet.');
  }

  // 2 · Starter buffer
  let s2: LadderStep;
  const band = a.buffer_band;
  if (hasData) {
    const actual = bandOf(bufferMonths);
    if (band && band !== 'unknown' && band !== actual) {
      conflicts.push({
        field: 'buffer_band',
        answer: band,
        evidence: `Your current account and savings cover ${monthsText(bufferMonths)} of spending.`,
      });
    }
    s2 =
      bufferMonths < C.starterBufferMonths
        ? step(2, 'red', `Your cash covers ${monthsText(bufferMonths)} of spending, below the 1-month starter buffer.`)
        : step(2, 'green', `Your cash covers ${monthsText(bufferMonths)} of spending.`);
  } else if (!band || band === 'unknown') {
    s2 = step(2, 'grey', 'We do not know your savings buffer yet.');
  } else {
    s2 =
      band === 'lt1'
        ? step(2, 'red', 'You told us your savings cover less than a month of spending.')
        : step(2, 'green', 'You told us your savings cover at least a month of spending.');
  }

  // 3 · Expensive debt
  const expensive = i.debt.payments.filter((p) => p.kind !== 'bank');
  const bankLoans = i.debt.payments.filter((p) => p.kind === 'bank');
  if (no(a.debt_ifn_bnpl) && expensive.length) {
    conflicts.push({
      field: 'debt_ifn_bnpl',
      answer: false,
      evidence: `Monthly payments to ${expensive.map((p) => `${p.lender} (${lei(p.monthlyAvg)})`).join(', ')}.`,
    });
  }
  if (no(a.card_revolving) && s.creditCardDebt > 0) {
    conflicts.push({
      field: 'card_revolving',
      answer: false,
      evidence: `Your credit card carries a ${lei(s.creditCardDebt)} balance.`,
    });
  }
  if (no(a.debt_bank_loan) && bankLoans.length) {
    conflicts.push({
      field: 'debt_bank_loan',
      answer: false,
      evidence: `Monthly loan instalments to ${bankLoans.map((p) => p.lender).join(', ')}.`,
    });
  }
  let s3: LadderStep;
  if (expensive.length) {
    s3 = step(
      3,
      'red',
      `You pay ${lei(i.debt.expensiveMonthly)}/month to ${expensive.map((p) => p.lender).join(' and ')} (non-bank or buy-now-pay-later credit).`,
    );
  } else if (yes(a.debt_ifn_bnpl)) {
    s3 = step(3, 'red', 'You told us you have non-bank (IFN) or buy-now-pay-later debt.');
  } else if (s.creditCardDebt > 0) {
    s3 = step(3, 'red', `You carry ${lei(s.creditCardDebt)} on your credit card.`);
  } else if (yes(a.card_revolving)) {
    s3 = step(3, 'red', 'You told us you carry a balance on your credit card from month to month.');
  } else if (dti > C.dtiCap) {
    s3 = step(3, 'red', `Loan payments take ${pct(dti)} of your income, above the ${pct(C.dtiCap)} cap.`);
  } else if (dti >= C.dtiAmber) {
    s3 = step(3, 'amber', `Loan payments take ${pct(dti)} of your income, close to the ${pct(C.dtiCap)} cap.`);
  } else if (
    !hasData &&
    a.debt_ifn_bnpl === undefined &&
    a.card_revolving === undefined &&
    a.debt_bank_loan === undefined
  ) {
    s3 = step(3, 'grey', 'We do not know about your debts yet.');
  } else {
    s3 = step(
      3,
      'green',
      i.debt.monthlyTotal > 0
        ? `Loan payments take ${pct(dti)} of your income and there is no expensive debt.`
        : 'No expensive debt found.',
    );
  }

  // 4 · Protection
  let s4: LadderStep;
  const protectionAnswers = [a.dependents, a.has_children, a.owns_home, a.ins_life, a.ins_home];
  const needsLife = hasDependents;
  const needsHome = yes(a.owns_home);
  if (protectionAnswers.every((v) => v === undefined)) {
    s4 = step(4, 'grey', 'Tell us about your family and home to check your protection.');
  } else if (needsLife && no(a.ins_life)) {
    s4 = step(4, 'red', 'People depend on your income but you have no life insurance.');
  } else if (needsHome && no(a.ins_home)) {
    s4 = step(4, 'red', 'You own your home but it is not insured.');
  } else if (
    a.dependents === 'unknown' ||
    a.owns_home === 'unknown' ||
    (needsLife && a.ins_life !== true) ||
    (needsHome && a.ins_home !== true)
  ) {
    s4 = step(4, 'amber', 'Some of your protection answers are still unknown.');
  } else {
    s4 = step(4, 'green', needsLife || needsHome ? 'Your family and home are insured.' : 'No protection gaps found.');
  }

  // 5 · Emergency fund
  let s5: LadderStep;
  const fundReason = (m: number) => `Your buffer covers ${monthsText(m)} of the ${emergencyTargetMonths}-month target.`;
  if (hasData) {
    s5 =
      bufferMonths < 1
        ? step(5, 'red', fundReason(bufferMonths))
        : bufferMonths < emergencyTargetMonths
          ? step(5, 'amber', fundReason(bufferMonths))
          : step(5, 'green', `Your buffer covers ${monthsText(bufferMonths)}, above the ${emergencyTargetMonths}-month target.`);
  } else if (!band || band === 'unknown') {
    s5 = step(5, 'grey', 'We do not know your emergency fund yet.');
  } else {
    const min = BAND_MIN[band];
    s5 =
      min < 1
        ? step(5, 'red', `You told us your savings cover less than a month; the target is ${emergencyTargetMonths} months.`)
        : min < emergencyTargetMonths
          ? step(5, 'amber', `You told us your savings cover ${min}+ months; the target is ${emergencyTargetMonths} months.`)
          : step(5, 'green', `You told us your savings cover ${min}+ months, at or above the ${emergencyTargetMonths}-month target.`);
  }

  // 6 · Goals
  let s6: LadderStep;
  if (!activeGoals.length) {
    s6 = step(6, 'grey', 'You have no active goal yet.');
  } else {
    const overdue = activeGoals.filter((g) => g.monthsLeft === 0 && g.currentAmount < g.targetAmount);
    const unfundedOpen = activeGoals.filter((g) => g.monthsLeft === null && g.currentAmount <= 0);
    if (goalsRequiredMonthly > Math.max(0, surplus)) {
      s6 = step(
        6,
        'amber',
        `Your goals need ${lei(goalsRequiredMonthly)}/month but only ${lei(Math.max(0, surplus))} is left each month.`,
      );
    } else if (overdue.length) {
      s6 = step(6, 'amber', `"${overdue[0].name}" reached its date before it was fully funded.`);
    } else if (unfundedOpen.length) {
      s6 = step(6, 'amber', `Nothing is set aside yet for "${unfundedOpen[0].name}".`);
    } else {
      s6 = step(
        6,
        'green',
        goalsRequiredMonthly > 0
          ? `Your goals need ${lei(goalsRequiredMonthly)}/month and your surplus covers it.`
          : 'Your goals are on track.',
      );
    }
  }

  // 7 · Long-term (only once 1–3 are green)
  let s7: LadderStep;
  const foundationGreen = [s1, s2, s3].every((x) => x.status === 'green');
  if (no(a.retirement_saving) && hasPension) {
    conflicts.push({ field: 'retirement_saving', answer: false, evidence: 'You hold a private pension account.' });
  }
  if (!foundationGreen) {
    s7 = step(7, 'grey', 'Unlocks once cash flow, starter buffer and expensive debt are green.');
  } else if (hasPension || yes(a.retirement_saving)) {
    s7 = step(7, 'green', 'You are already saving for retirement.');
  } else {
    s7 = step(7, 'amber', 'You are not saving for retirement yet.');
  }

  const ladder = [s1, s2, s3, s4, s5, s6, s7];
  const pillar = (key: PillarKey, steps: LadderStep[]): Pillar => {
    const status = worst(steps.map((x) => x.status));
    const from = steps.find((x) => x.status === status) ?? steps[0];
    return { key, status, reason: from.reason };
  };
  const pillars = [
    pillar('spend', [s1]),
    pillar('save', [s2, s5]),
    pillar('borrow', [s3]),
    pillar('plan_protect', [s4, s6, s7]),
  ];

  // The first step that needs work; else the first one we cannot judge yet (1–6); else the top.
  const firstOpen = ladder.find((x) => x.status === 'red' || x.status === 'amber');
  const firstGrey = ladder.slice(0, 6).find((x) => x.status === 'grey');
  const currentStep = (firstOpen ?? firstGrey)?.step ?? 7;

  return {
    ladder,
    pillars,
    currentStep,
    conflicts,
    facts: {
      hasData,
      income: r2(income),
      spending: r2(spending),
      surplus,
      surplusRatio: r2(surplusRatio),
      bufferMonths: r2(bufferMonths),
      emergencyTargetMonths,
      dti: r2(dti),
      creditCardDebt: s.creditCardDebt,
      goalsRequiredMonthly,
      hasPension,
    },
  };
}
