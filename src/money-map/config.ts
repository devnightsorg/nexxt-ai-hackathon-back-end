import type { StepKey } from './types';

/** Every money-map threshold in one place (fractions of income, months of spending, RON). */
export const MONEY_MAP_CONFIG = {
  /** Step 1: surplus below this share of income is amber. */
  surplusAmberRatio: 0.05,
  /** Step 2: buffer (months of spending) below this is red. */
  starterBufferMonths: 1,
  /** Step 3: debt-to-income above the cap is red, from the amber floor up to the cap amber. */
  dtiCap: 0.4,
  dtiAmber: 0.3,
  /** Step 5: emergency-fund target in months; the higher one for unstable income or dependents. */
  emergencyFundMonths: 3,
  emergencyFundMonthsHigh: 6,
  /** Debt detection: a lender must be paid in at least this many distinct months of the window. */
  debtMinMonths: 2,
  /** Actions: at most this many overall and per step. */
  maxActions: 3,
  maxActionsPerStep: 2,
} as const;

export const STEP_KEYS: StepKey[] = [
  'cash_flow',
  'starter_buffer',
  'expensive_debt',
  'protection',
  'emergency_fund',
  'goals',
  'long_term',
];

export const STEP_LABELS: Record<StepKey, string> = {
  cash_flow: 'Cash flow',
  starter_buffer: 'Starter buffer',
  expensive_debt: 'Expensive debt',
  protection: 'Protection',
  emergency_fund: 'Emergency fund',
  goals: 'Goals',
  long_term: 'Long-term',
};

/** Ranking weight: 7 for step 1 down to 1 for step 7. */
export const stepWeight = (step: number): number => 8 - step;

export const stepLabel = (step: number): string => `Step ${step} · ${STEP_LABELS[STEP_KEYS[step - 1]]}`;
