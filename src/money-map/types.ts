export type Tri = boolean | 'unknown';
export type BufferBand = 'lt1' | '1_3' | '3_6' | '6_plus' | 'unknown';

export const TRI_FIELDS = [
  'dependents',
  'has_children',
  'income_stable',
  'owns_home',
  'has_mortgage',
  'renting',
  'money_stress',
  'month_end_surplus',
  'relies_on_credit',
  'debt_ifn_bnpl',
  'card_revolving',
  'debt_bank_loan',
  'ins_life',
  'ins_home',
  'retirement_saving',
] as const;

export type TriField = (typeof TRI_FIELDS)[number];
export const BUFFER_BANDS: readonly BufferBand[] = ['lt1', '1_3', '3_6', '6_plus', 'unknown'];

/** Onboarding answers; every field optional. */
export type SituationAnswers = Partial<Record<TriField, Tri>> & { buffer_band?: BufferBand };

export type StepStatus = 'green' | 'amber' | 'red' | 'grey';
export type StepKey =
  | 'cash_flow'
  | 'starter_buffer'
  | 'expensive_debt'
  | 'protection'
  | 'emergency_fund'
  | 'goals'
  | 'long_term';
export type PillarKey = 'spend' | 'save' | 'borrow' | 'plan_protect';

export interface LadderStep {
  step: number;
  key: StepKey;
  status: StepStatus;
  reason: string;
}

export interface Pillar {
  key: PillarKey;
  status: StepStatus;
  reason: string;
}

export interface Conflict {
  field: keyof SituationAnswers;
  answer: Tri | BufferBand;
  evidence: string;
}

export interface MoneyMapAction {
  id: string;
  step: number;
  stepLabel: string;
  ruleId: string;
  kind: 'product' | 'tip' | 'meeting';
  title: string;
  impactRonPerMonth: number | null;
  product: { slug: string; name: string; url: string | null } | null;
  reasoning: { rule: string; fact: string }[];
}

export interface MoneyMap {
  headline: { text: string; facts: string[] };
  pillars: Pillar[];
  ladder: LadderStep[];
  currentStep: number;
  situationComplete: boolean;
  conflicts: Conflict[];
  actions: MoneyMapAction[];
}

export interface SituationDto {
  answers: SituationAnswers;
  completedAt: string | null;
}
