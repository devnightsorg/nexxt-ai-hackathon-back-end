import type { FinancialSnapshot } from '../banking/stats.service';
import type { GoalDto } from '../goals/dto';
import { evaluateLadder, LadderInput, worst } from './ladder';
import type { DebtSummary } from './lenders';
import type { SituationAnswers } from './types';

const NO_DEBT: DebtSummary = { payments: [], monthlyTotal: 0, expensiveMonthly: 0 };

function snapshot(s: Partial<FinancialSnapshot> = {}): FinancialSnapshot {
  return {
    asOf: '2026-10-28',
    totalBalance: 0,
    balancesByType: { current: 10000 },
    currentAccountBalance: 10000,
    savingsBalance: 0,
    creditCardDebt: 0,
    avgMonthlyIncome: 10000,
    avgMonthlySpending: 5000,
    savingsRate: 0.5,
    idleCash: 5000,
    monthsOfRunway: 2,
    topSpendingCategories: [],
    subscriptionsMonthly: 0,
    ...s,
  };
}

function goal(g: Partial<GoalDto> = {}): GoalDto {
  return {
    id: 'g1',
    name: 'Trip',
    type: 'vacation',
    targetAmount: 10000,
    currency: 'RON',
    targetDate: null,
    linkedAccountId: null,
    priority: 2,
    status: 'active',
    currentAmount: 0,
    progressPct: 0,
    monthsLeft: 10,
    requiredMonthlySaving: 1000,
    ...g,
  };
}

const run = (o: Partial<LadderInput> & { answers?: SituationAnswers } = {}) =>
  evaluateLadder({ snapshot: snapshot(), goals: [], answers: {}, debt: NO_DEBT, declaredIncome: null, ...o });
const statuses = (r: ReturnType<typeof run>) => r.ladder.map((s) => s.status);
const status = (r: ReturnType<typeof run>, step: number) => r.ladder[step - 1].status;

describe('evaluateLadder', () => {
  it('step 1: red on deficit or reliance on credit, amber under 5% surplus, grey without data or answers', () => {
    expect(status(run({ snapshot: snapshot({ avgMonthlySpending: 10500 }) }), 1)).toBe('red');
    expect(status(run({ answers: { relies_on_credit: true } }), 1)).toBe('red');
    expect(status(run({ snapshot: snapshot({ avgMonthlySpending: 9700 }) }), 1)).toBe('amber');
    expect(status(run(), 1)).toBe('green');
    const empty = snapshot({ avgMonthlyIncome: 0, avgMonthlySpending: 0, monthsOfRunway: 999 });
    expect(status(run({ snapshot: empty }), 1)).toBe('grey');
    expect(status(run({ snapshot: empty, answers: { month_end_surplus: false } }), 1)).toBe('red');
  });

  it('step 2: buffer of current account plus savings; falls back to buffer_band without data', () => {
    expect(status(run({ snapshot: snapshot({ monthsOfRunway: 0.7 }) }), 2)).toBe('red');
    expect(status(run({ snapshot: snapshot({ monthsOfRunway: 0.5, balancesByType: { current: 2500, savings: 5000 } }) }), 2)).toBe('green');
    const empty = snapshot({ avgMonthlyIncome: 0, avgMonthlySpending: 0, monthsOfRunway: 999 });
    expect(status(run({ snapshot: empty }), 2)).toBe('grey');
    expect(status(run({ snapshot: empty, answers: { buffer_band: 'lt1' } }), 2)).toBe('red');
  });

  it('step 3: red on IFN/BNPL, card debt or DTI above the cap; amber from 30%', () => {
    const ifn: DebtSummary = { payments: [{ lender: 'Provident', kind: 'ifn', monthlyAvg: 200, months: 3 }], monthlyTotal: 200, expensiveMonthly: 200 };
    expect(status(run({ debt: ifn }), 3)).toBe('red');
    expect(status(run({ answers: { debt_ifn_bnpl: true } }), 3)).toBe('red');
    expect(status(run({ snapshot: snapshot({ creditCardDebt: 500 }) }), 3)).toBe('red');
    expect(status(run({ answers: { card_revolving: true } }), 3)).toBe('red');
    const bank = (m: number): DebtSummary => ({ payments: [{ lender: 'BCR', kind: 'bank', monthlyAvg: m, months: 3 }], monthlyTotal: m, expensiveMonthly: 0 });
    expect(status(run({ debt: bank(4100) }), 3)).toBe('red');
    expect(status(run({ debt: bank(3500) }), 3)).toBe('amber');
    expect(status(run({ debt: bank(2000) }), 3)).toBe('green');
  });

  it('step 4: red for uninsured dependents or home, amber when unknown, grey without answers', () => {
    expect(status(run(), 4)).toBe('grey');
    expect(status(run({ answers: { dependents: true, ins_life: false } }), 4)).toBe('red');
    expect(status(run({ answers: { owns_home: true, ins_home: false } }), 4)).toBe('red');
    expect(status(run({ answers: { dependents: 'unknown' } }), 4)).toBe('amber');
    expect(status(run({ answers: { dependents: true, ins_life: 'unknown' } }), 4)).toBe('amber');
    expect(status(run({ answers: { dependents: true, ins_life: true, owns_home: false } }), 4)).toBe('green');
  });

  it('step 5: 3-month target, 6 with unstable income or dependents', () => {
    expect(status(run({ snapshot: snapshot({ monthsOfRunway: 0.5 }) }), 5)).toBe('red');
    expect(status(run({ snapshot: snapshot({ monthsOfRunway: 2 }) }), 5)).toBe('amber');
    expect(status(run({ snapshot: snapshot({ monthsOfRunway: 4 }) }), 5)).toBe('green');
    const r = run({ snapshot: snapshot({ monthsOfRunway: 4 }), answers: { income_stable: false } });
    expect(status(r, 5)).toBe('amber');
    expect(r.facts.emergencyTargetMonths).toBe(6);
  });

  it('step 6: grey without goals, amber when the surplus cannot fund them, green on track', () => {
    expect(status(run(), 6)).toBe('grey');
    expect(status(run({ goals: [goal({ requiredMonthlySaving: 6000 })] }), 6)).toBe('amber');
    expect(status(run({ goals: [goal()] }), 6)).toBe('green');
    expect(status(run({ goals: [goal({ monthsLeft: null, requiredMonthlySaving: null })] }), 6)).toBe('amber');
  });

  it('step 7: hidden (grey) unless 1–3 are green; amber without retirement saving', () => {
    expect(status(run({ snapshot: snapshot({ monthsOfRunway: 0.5 }) }), 7)).toBe('grey');
    expect(status(run(), 7)).toBe('amber');
    expect(status(run({ answers: { retirement_saving: true } }), 7)).toBe('green');
    expect(status(run({ snapshot: snapshot({ balancesByType: { current: 10000, pension: 1000 } }) }), 7)).toBe('green');
  });

  it('transactions win over answers and each disagreement is a conflict', () => {
    const ifn: DebtSummary = { payments: [{ lender: 'Mokka', kind: 'bnpl', monthlyAvg: 140, months: 3 }], monthlyTotal: 140, expensiveMonthly: 140 };
    const r = run({
      debt: ifn,
      snapshot: snapshot({ creditCardDebt: 900, monthsOfRunway: 0.5 }),
      answers: { debt_ifn_bnpl: false, card_revolving: false, buffer_band: '3_6', month_end_surplus: false },
    });
    expect(status(r, 3)).toBe('red');
    expect(r.conflicts.map((c) => c.field).sort()).toEqual(['buffer_band', 'card_revolving', 'debt_ifn_bnpl', 'month_end_surplus']);
    expect(r.conflicts.find((c) => c.field === 'debt_ifn_bnpl')?.evidence).toContain('Mokka');
  });

  it('pillars take the worst non-grey step; currentStep is the first red/amber step', () => {
    const r = run({ snapshot: snapshot({ monthsOfRunway: 2 }), goals: [goal()] });
    expect(statuses(r)).toEqual(['green', 'green', 'green', 'grey', 'amber', 'green', 'amber']);
    expect(r.pillars).toEqual([
      expect.objectContaining({ key: 'spend', status: 'green' }),
      expect.objectContaining({ key: 'save', status: 'amber' }),
      expect.objectContaining({ key: 'borrow', status: 'green' }),
      expect.objectContaining({ key: 'plan_protect', status: 'amber' }),
    ]);
    expect(r.currentStep).toBe(5);
    expect(worst(['grey', 'grey'])).toBe('grey');
    expect(worst(['grey', 'green'])).toBe('green');
  });
});
