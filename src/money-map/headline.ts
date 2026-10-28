import { PENSION_DEDUCTIBLE_MONTHLY_RON } from '../offers/offer-rules';
import type { LadderResult } from './ladder';
import type { DebtSummary } from './lenders';

const lei = (n: number): string => `${Math.round(n).toLocaleString('en-US')} lei`;
const r1 = (n: number): number => Math.round(n * 10) / 10;
const pct = (n: number): number => Math.round(n * 100);

/** One templated sentence (no LLM) about the current step, with the facts it quotes. */
export function buildHeadline(r: LadderResult, debt: DebtSummary): { text: string; facts: string[] } {
  const f = r.facts;
  const step = r.ladder[r.currentStep - 1];
  const facts = [
    `income_ron=${Math.round(f.income)}`,
    `surplus_ron=${Math.round(f.surplus)}`,
    `buffer_months=${r1(f.bufferMonths)}`,
    `dti_pct=${pct(f.dti)}`,
  ];
  const t = (text: string, ...extra: string[]) => ({ text, facts: [...facts, ...extra] });

  if (!f.hasData && r.ladder.every((s) => s.status === 'grey' || s.step === 7)) {
    const open = r.ladder.filter((s) => s.status === 'grey' && s.step < 7).length;
    return t(`Answer a few questions to light up the ${open} steps of your money map.`, `grey_steps=${open}`);
  }
  if (step.status === 'grey') {
    return r.currentStep === 1
      ? t('Tell us about your monthly cash flow to unlock step 1 of your money map.')
      : t(`Steps 1 to ${r.currentStep - 1} look good — tell us more to check step ${r.currentStep}.`);
  }

  switch (step.key) {
    case 'cash_flow':
      return f.surplus < 0
        ? t(`You spend ${lei(-f.surplus)} more than you earn each month — fixing that comes first.`)
        : t(`You keep ${lei(Math.max(0, f.surplus))} a month (${pct(f.surplusRatio)}% of income) — aim for at least 5%.`);
    case 'starter_buffer':
      return t(`Your cash covers ${r1(f.bufferMonths)} months of spending — build a 1-month buffer first.`);
    case 'expensive_debt': {
      const expensive = debt.payments.filter((p) => p.kind !== 'bank');
      if (expensive.length) {
        return t(
          `You pay ${lei(debt.expensiveMonthly)} a month to ${expensive.map((p) => p.lender).join(' and ')} — clear that expensive debt next.`,
          `expensive_debt_ron_per_month=${debt.expensiveMonthly}`,
        );
      }
      if (f.creditCardDebt > 0) {
        return t(
          `You carry ${lei(f.creditCardDebt)} on your credit card — paying it down is your next step.`,
          `credit_card_debt_ron=${Math.round(f.creditCardDebt)}`,
        );
      }
      return t(`Loan payments take ${pct(f.dti)}% of your income — keep them under 40%.`);
    }
    case 'protection':
      return t(`Protection is your next step (4 of 7): ${step.reason.charAt(0).toLowerCase()}${step.reason.slice(1)}`);
    case 'emergency_fund':
      return t(
        `Your emergency fund covers ${r1(f.bufferMonths)} of ${f.emergencyTargetMonths} months — keep building it.`,
        `emergency_target_months=${f.emergencyTargetMonths}`,
      );
    case 'goals':
      return t(
        `Your goals need ${lei(f.goalsRequiredMonthly)} a month — let's put a plan behind them.`,
        `goals_required_ron_per_month=${Math.round(f.goalsRequiredMonthly)}`,
      );
    case 'long_term':
      return step.status === 'green'
        ? t(`All 7 steps are green — you keep ${pct(f.surplusRatio)}% of your income each month.`)
        : t(
            `Your foundations are solid — ${lei(PENSION_DEDUCTIBLE_MONTHLY_RON)} a month into a private pension is tax-deductible.`,
            `pension_deductible_ron_per_month=${PENSION_DEDUCTIBLE_MONTHLY_RON}`,
          );
  }
}
