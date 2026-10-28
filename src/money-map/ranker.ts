import type { RiskProfile } from '@prisma/client';
import type { FinancialSnapshot } from '../banking/stats.service';
import type { GoalDto } from '../goals/dto';
import type { OfferCandidate, RuleId } from '../offers/offer-rules';
import type { CatalogProduct, ProductCategory } from '../products/catalog.types';
import { MONEY_MAP_CONFIG as C, stepLabel, stepWeight } from './config';
import type { LadderResult } from './ladder';
import type { DebtSummary } from './lenders';
import type { LadderStep, MoneyMapAction, SituationAnswers } from './types';

export interface RankInput {
  ladder: LadderResult;
  candidates: OfferCandidate[];
  products: CatalogProduct[];
  goals: GoalDto[];
  answers: SituationAnswers;
  riskProfile: RiskProfile;
  snapshot: FinancialSnapshot;
  debt: DebtSummary;
}

export const CREDIT_CATEGORIES: ProductCategory[] = ['personal_loan', 'mortgage', 'credit_card'];

const lei = (n: number): string => `${Math.round(n).toLocaleString('en-US')} lei`;
const round = (n: number | null): number | null => (n === null || !Number.isFinite(n) ? null : Math.round(n));
const STATUS_RANK = { red: 0, amber: 1, green: 2, grey: 3 } as const;
const CATEGORY_LABELS: Record<string, string> = {
  groceries: 'groceries',
  dining: 'eating out',
  shopping: 'shopping',
  entertainment: 'entertainment',
  transport: 'transport',
  travel: 'travel',
  subscriptions: 'subscriptions',
};

/** Why each offer rule fired, in plain English. */
const RULE_TEXT: Record<RuleId, string> = {
  idle_cash_savings: 'Cash above one month of spending earns more in savings',
  goal_term_deposit: 'A deposit that matures before the goal date locks in a better rate',
  emergency_fund: 'Savings below 3 months of spending; set aside 30% of the monthly surplus',
  home_goal: 'A home goal is best funded with regular monthly saving',
  retirement: 'No private pension yet; 400 EUR/year is tax-deductible',
  long_term_growth: 'Money not needed for years can be invested within your risk profile',
  credit_card_debt: 'Card debt is the most expensive bank debt',
  subscriptions_tip: 'Subscriptions above 150 lei/month are worth reviewing',
  youth_package: 'Account packages for young people have lower fees',
};

interface Draft {
  action: MoneyMapAction;
  score: number;
  ruleScore: number;
}

/** Ladder step an offer rule belongs to (emergency_fund: step 2 until the starter buffer is green, then 5). */
export function stepForRule(ruleId: RuleId, ladder: LadderStep[]): number {
  switch (ruleId) {
    case 'subscriptions_tip':
    case 'youth_package':
      return 1;
    case 'emergency_fund':
      return ladder[1].status === 'green' ? 5 : 2;
    case 'credit_card_debt':
      return 3;
    case 'idle_cash_savings':
      return 5;
    case 'home_goal':
    case 'goal_term_deposit':
      return 6;
    case 'retirement':
    case 'long_term_growth':
      return 7;
  }
}

function monthlyInterest(amount: number | null, product: CatalogProduct | undefined): number | null {
  const rate = product?.interest_rate_or_return?.value ?? null;
  if (amount === null || rate === null) return null;
  return (amount * rate) / 100 / 12;
}

function productRef(p: CatalogProduct): MoneyMapAction['product'] {
  return { slug: p.slug, name: p.name, url: p.source_urls?.[0] ?? null };
}

function actionId(ruleId: string, slug: string | null): string {
  return slug ? `${ruleId}:${slug}` : ruleId;
}

/** English title + monthly impact for an offer-rule candidate (the rule texts themselves are Romanian). */
function describe(
  c: OfferCandidate,
  step: number,
  p: CatalogProduct | undefined,
  i: RankInput,
): { title: string; impact: number | null; fact: string } {
  const name = p?.name ?? '';
  const goal = c.goalId ? i.goals.find((g) => g.id === c.goalId) : undefined;
  switch (c.ruleId) {
    case 'idle_cash_savings':
      return {
        title: `Move ${lei(c.suggestedAmount ?? 0)} of idle cash into ${name}`,
        impact: monthlyInterest(c.suggestedAmount, p),
        fact: `idle_cash_ron=${Math.round(i.snapshot.idleCash)}`,
      };
    case 'goal_term_deposit':
      return {
        title: `Put ${lei(c.suggestedAmount ?? 0)} in a ${c.termMonths}-month ${name} for "${goal?.name ?? 'your goal'}"`,
        impact: monthlyInterest(c.suggestedAmount, p),
        fact: `deposit_ron=${c.suggestedAmount}`,
      };
    case 'emergency_fund':
      return {
        title:
          step === 2
            ? `Build a 1-month starter buffer: ${lei(c.monthlyContribution ?? 0)}/month into ${name}`
            : `Grow your emergency fund: ${lei(c.monthlyContribution ?? 0)}/month into ${name}`,
        impact: c.monthlyContribution,
        fact: `monthly_contribution_ron=${c.monthlyContribution}`,
      };
    case 'home_goal':
      return {
        title: `Save ${lei(c.monthlyContribution ?? 0)}/month for "${goal?.name ?? 'your home'}" with ${name}`,
        impact: c.monthlyContribution ?? monthlyInterest(c.suggestedAmount, p),
        fact: `monthly_contribution_ron=${c.monthlyContribution}`,
      };
    case 'retirement':
      return {
        title: `Start a private pension (Pillar III): ${lei(c.monthlyContribution ?? 0)}/month into ${name}`,
        impact: c.monthlyContribution,
        fact: `monthly_contribution_ron=${c.monthlyContribution}`,
      };
    case 'long_term_growth':
      return {
        title: `Invest ${lei(c.suggestedAmount ?? 0)} for the long term in ${name}`,
        impact: null,
        fact: `risk_profile=${i.riskProfile}`,
      };
    case 'credit_card_debt':
      return {
        title: p
          ? `Refinance your ${lei(i.snapshot.creditCardDebt)} card balance with ${name}`
          : `Pay down your ${lei(i.snapshot.creditCardDebt)} credit card balance`,
        impact: null,
        fact: `credit_card_debt_ron=${Math.round(i.snapshot.creditCardDebt)}`,
      };
    case 'subscriptions_tip':
      return {
        title: `Cancel half of your subscriptions to save ${lei(i.snapshot.subscriptionsMonthly / 2)}/month`,
        impact: i.snapshot.subscriptionsMonthly / 2,
        fact: `subscriptions_ron_per_month=${Math.round(i.snapshot.subscriptionsMonthly)}`,
      };
    case 'youth_package':
      return {
        title: `Switch to ${name}, the account package for young people`,
        impact: null,
        fact: `product=${c.productSlug}`,
      };
  }
}

function stepFact(s: LadderStep): { rule: string; fact: string } {
  return { rule: `${stepLabel(s.step)} is ${s.status}`, fact: s.reason };
}

/** Deterministic tips/meetings for steps the offer rules do not cover. */
function engineDrafts(i: RankInput, make: MakeDraft): Draft[] {
  const L = i.ladder.ladder;
  const out: Draft[] = [];
  const top = i.snapshot.topSpendingCategories.find((c) => c.category in CATEGORY_LABELS && c.category !== 'subscriptions');
  if (L[0].status === 'red' || L[0].status === 'amber' || i.answers.money_stress === true) {
    const cut = top ? top.monthlyAvg * 0.1 : null;
    out.push(
      make(1, 'cash_flow_review', 'tip', null, {
        title: top
          ? `Trim ${CATEGORY_LABELS[top.category]} by 10% to free ${lei(cut ?? 0)}/month`
          : 'Set a monthly spending plan before payday',
        impact: cut,
        fact: top ? `${top.category}_ron_per_month=${Math.round(top.monthlyAvg)}` : `surplus_ron=${Math.round(i.ladder.facts.surplus)}`,
        rule: 'Spending above income is the first thing to fix',
      }),
    );
  }
  const expensive = i.debt.payments.filter((p) => p.kind !== 'bank');
  if (expensive.length) {
    const first = expensive[0];
    out.push(
      make(3, 'expensive_debt_payoff', 'tip', null, {
        title: `Pay off ${first.lender} first to free ${lei(first.monthlyAvg)}/month`,
        impact: i.debt.expensiveMonthly,
        fact: expensive.map((p) => `${p.lender.toLowerCase().replace(/\s+/g, '_')}_ron_per_month=${p.monthlyAvg}`).join(', '),
        rule: 'Non-bank and buy-now-pay-later credit costs the most; clear it before saving more',
      }),
    );
  } else if (
    L[2].status === 'red' &&
    (i.answers.card_revolving === true || i.snapshot.creditCardDebt > 0) &&
    !i.candidates.some((c) => c.ruleId === 'credit_card_debt')
  ) {
    out.push(
      make(3, 'card_payoff', 'tip', null, {
        title: 'Pay more than the minimum on your credit card every month',
        impact: null,
        fact: `credit_card_debt_ron=${Math.round(i.snapshot.creditCardDebt)}`,
        rule: 'Revolving card balances carry the highest bank interest',
      }),
    );
  }
  if (L[3].status === 'red' || L[3].status === 'amber') {
    out.push(
      make(4, 'protection_meeting', 'meeting', null, {
        title: 'Book a meeting to review life and home insurance',
        impact: null,
        fact: L[3].reason,
        rule: 'Protect your income and home before investing',
      }),
    );
  }
  return out;
}

type MakeDraft = (
  step: number,
  ruleId: string,
  kind: MoneyMapAction['kind'],
  product: CatalogProduct | null,
  f: { title: string; impact: number | null; fact: string; rule: string; ruleScore?: number },
) => Draft;

/** Up to 3 actions: red steps (lowest first), then amber, then the rest; score = impact × step weight. */
export function rankActions(i: RankInput): MoneyMapAction[] {
  const L = i.ladder.ladder;
  const bySlug = new Map(i.products.map((p) => [p.slug, p]));
  const step1Red = L[0].status === 'red';

  const make: MakeDraft = (step, ruleId, kind, product, f) => {
    const impact = round(f.impact);
    return {
      action: {
        id: actionId(ruleId, product?.slug ?? null),
        step,
        stepLabel: stepLabel(step),
        ruleId,
        kind,
        title: f.title,
        impactRonPerMonth: impact,
        product: product ? productRef(product) : null,
        reasoning: [stepFact(L[step - 1]), { rule: f.rule, fact: f.fact }],
      },
      score: Math.max(impact ?? 0, 1) * stepWeight(step),
      ruleScore: f.ruleScore ?? 0,
    };
  };

  const drafts: Draft[] = [];
  for (const c of i.candidates) {
    const step = stepForRule(c.ruleId, L);
    // Long-term actions stay hidden until steps 1–3 are green.
    if (step === 7 && L[6].status === 'grey') continue;
    let p = c.productSlug ? bySlug.get(c.productSlug) : undefined;
    let kind: MoneyMapAction['kind'] = c.kind;
    const isCredit = p !== undefined && CREDIT_CATEGORIES.includes(p.category);
    // Guardrails: no credit while cash flow is red; no credit card while revolving one.
    if (isCredit && (step1Red || (p!.category === 'credit_card' && i.answers.card_revolving === true))) {
      if (c.ruleId !== 'credit_card_debt') continue;
      p = undefined;
      kind = 'tip';
    }
    const d = describe(c, step, p, i);
    if (c.ruleId === 'long_term_growth' && i.riskProfile === 'conservative') {
      drafts.push(
        make(step, 'long_term_meeting', 'meeting', null, {
          title: 'Book a meeting with an advisor about long-term investing',
          impact: null,
          fact: 'risk_profile=conservative',
          rule: 'Investment products are only named for balanced or dynamic risk profiles',
          ruleScore: c.score,
        }),
      );
      continue;
    }
    drafts.push(
      make(step, c.ruleId, kind, kind === 'product' ? (p ?? null) : null, {
        title: d.title,
        impact: d.impact,
        fact: d.fact,
        rule: RULE_TEXT[c.ruleId],
        ruleScore: c.score,
      }),
    );
  }
  drafts.push(...engineDrafts(i, make));

  drafts.sort(
    (a, b) =>
      STATUS_RANK[L[a.action.step - 1].status] - STATUS_RANK[L[b.action.step - 1].status] ||
      a.action.step - b.action.step ||
      b.score - a.score ||
      b.ruleScore - a.ruleScore ||
      a.action.id.localeCompare(b.action.id),
  );
  if (i.answers.money_stress === true) {
    const k = drafts.findIndex((d) => d.action.step === 1);
    if (k > 0) drafts.unshift(...drafts.splice(k, 1));
  }

  const out: MoneyMapAction[] = [];
  const perStep = new Map<number, number>();
  for (const d of drafts) {
    if (out.length >= C.maxActions) break;
    const n = perStep.get(d.action.step) ?? 0;
    if (n >= C.maxActionsPerStep || out.some((x) => x.id === d.action.id)) continue;
    perStep.set(d.action.step, n + 1);
    out.push(d.action);
  }
  return out;
}
