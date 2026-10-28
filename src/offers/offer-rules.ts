import { AccountType, RiskProfile } from '@prisma/client';
import { RISK_PROFILE_MAX } from '../actions/policy';
import type { FinancialSnapshot } from '../banking/stats.service';
import { formatRon } from '../common/money';
import { Projection, simulate } from '../finance/projection';
import type { GoalDto } from '../goals/dto';
import { CatalogProduct, OPENABLE_CATEGORIES, ProductCategory, termMonthsOf } from '../products/catalog.types';

export type RuleId =
  | 'idle_cash_savings'
  | 'goal_term_deposit'
  | 'emergency_fund'
  | 'home_goal'
  | 'retirement'
  | 'long_term_growth'
  | 'credit_card_debt'
  | 'subscriptions_tip'
  | 'youth_package';

export interface RuleInput {
  user: { age: number | null; riskProfile: RiskProfile; monthlyIncome: number | null };
  snapshot: FinancialSnapshot;
  goals: GoalDto[];
  products: CatalogProduct[];
  ownedAccountTypes: AccountType[];
  interestTaxRate: number;
  now: Date;
}

export interface OfferCandidate {
  ruleId: RuleId;
  kind: 'product' | 'tip';
  productSlug: string | null;
  title: string;
  suggestedAmount: number | null;
  monthlyContribution: number | null;
  termMonths: number | null;
  projection: Projection | null;
  reasoning: string;
  citations: { title: string; sourceUrl: string }[];
  score: number;
  actionable: boolean;
}

/** 400 EUR/an deductibil ≈ 165 RON/lună. */
export const PENSION_DEDUCTIBLE_MONTHLY_RON = 165;
const MAX_OFFERS = 5;
const NULL_RISK_LEVEL = 4;
const YOUTH_RE = /tineri|student|young|youth/i;

export const floor100 = (n: number): number => Math.max(0, Math.floor(n / 100) * 100);
export const floor10 = (n: number): number => Math.max(0, Math.floor(n / 10) * 10);

const ron = (n: number): string => `${formatRon(n)} lei`;
const months = (n: number): string => (n === 1 ? '1 lună' : `${n} luni`);

const rateOf = (p: CatalogProduct): number | null => p.interest_rate_or_return?.value ?? null;

/** R7: only rule-eligible, RON products; for actionable categories also openable by transfer. */
export function isRuleEligible(p: CatalogProduct): boolean {
  if (p.rule_eligible === false) return false;
  if (p.currencies?.length && !p.currencies.includes('RON')) return false;
  if (OPENABLE_CATEGORIES.includes(p.category) && p.openable_via_transfer === false) return false;
  return true;
}

function byRateThenSlug(a: CatalogProduct, b: CatalogProduct): number {
  const ra = rateOf(a);
  const rb = rateOf(b);
  if (ra !== rb) {
    if (ra === null) return 1;
    if (rb === null) return -1;
    return rb - ra;
  }
  return a.slug.localeCompare(b.slug);
}

/** Filter by category / goodFor / maxRisk (+ R7 eligibility), then highest rate (nulls last), then slug. */
export function pickBest(
  products: CatalogProduct[],
  o: { categories: ProductCategory[]; goodFor?: string; maxRisk?: number },
): CatalogProduct | null {
  const list = products
    .filter((p) => o.categories.includes(p.category))
    .filter(isRuleEligible)
    .filter((p) => !o.goodFor || p.good_for?.includes(o.goodFor))
    .filter((p) => o.maxRisk === undefined || (p.risk_level ?? NULL_RISK_LEVEL) <= o.maxRisk)
    .sort(byRateThenSlug);
  return list[0] ?? null;
}

/** Terms (months) a deposit offers, with the rate for each (rates_by_term, else the headline rate). */
function depositTerms(p: CatalogProduct): { months: number; ratePct: number | null }[] {
  if (p.rates_by_term?.length) return p.rates_by_term.map((r) => ({ months: r.months, ratePct: r.ratePct }));
  return termMonthsOf(p).map((m) => ({ months: m, ratePct: rateOf(p) }));
}

/** Among eligible RON term deposits: per product the largest term ≤ monthsLeft, then the highest rate. */
export function pickTermDeposit(
  products: CatalogProduct[],
  monthsLeft: number,
): { product: CatalogProduct; termMonths: number; ratePct: number | null } | null {
  const options: { product: CatalogProduct; termMonths: number; ratePct: number | null }[] = [];
  for (const p of products.filter((x) => x.category === 'term_deposit' && isRuleEligible(x))) {
    const terms = depositTerms(p);
    if (!terms.length) {
      if (monthsLeft >= 6) options.push({ product: p, termMonths: monthsLeft >= 12 ? 12 : 6, ratePct: rateOf(p) });
      continue;
    }
    const fitting = terms.filter((t) => t.months <= monthsLeft).sort((a, b) => b.months - a.months);
    if (fitting.length) options.push({ product: p, termMonths: fitting[0].months, ratePct: fitting[0].ratePct });
  }
  options.sort((a, b) => {
    if (a.ratePct !== b.ratePct) {
      if (a.ratePct === null) return 1;
      if (b.ratePct === null) return -1;
      return b.ratePct - a.ratePct;
    }
    if (a.termMonths !== b.termMonths) return b.termMonths - a.termMonths;
    return a.product.slug.localeCompare(b.product.slug);
  });
  return options[0] ?? null;
}

function citationsOf(p: CatalogProduct): { title: string; sourceUrl: string }[] {
  return (p.source_urls ?? []).map((u) => ({ title: p.name, sourceUrl: u }));
}

function productCandidate(
  i: RuleInput,
  ruleId: RuleId,
  score: number,
  product: CatalogProduct,
  f: {
    title: string;
    reasoning: string;
    suggestedAmount?: number | null;
    monthlyContribution?: number | null;
    termMonths?: number | null;
    goalTarget?: number;
  },
): OfferCandidate {
  const actionable = OPENABLE_CATEGORIES.includes(product.category);
  const suggestedAmount = f.suggestedAmount ?? null;
  const monthlyContribution = f.monthlyContribution ?? null;
  const termMonths = f.termMonths ?? null;
  const projection = actionable
    ? simulate({
        product,
        amount: suggestedAmount ?? 0,
        termMonths: termMonths ?? undefined,
        monthlyContribution: monthlyContribution ?? undefined,
        goalTarget: f.goalTarget,
        interestTaxRate: i.interestTaxRate,
      })
    : null;
  return {
    ruleId,
    kind: 'product',
    productSlug: product.slug,
    title: f.title,
    suggestedAmount,
    monthlyContribution,
    termMonths,
    projection,
    reasoning: f.reasoning,
    citations: citationsOf(product),
    score,
    actionable,
  };
}

function tipCandidate(ruleId: RuleId, score: number, title: string, reasoning: string): OfferCandidate {
  return {
    ruleId,
    kind: 'tip',
    productSlug: null,
    title,
    suggestedAmount: null,
    monthlyContribution: null,
    termMonths: null,
    projection: null,
    reasoning,
    citations: [],
    score,
    actionable: false,
  };
}

const activeGoals = (i: RuleInput): GoalDto[] => i.goals.filter((g) => g.status === 'active');
const incomeOf = (i: RuleInput): number => i.snapshot.avgMonthlyIncome || i.user.monthlyIncome || 0;
const surplusOf = (i: RuleInput): number => Math.max(0, incomeOf(i) - i.snapshot.avgMonthlySpending);

type Rule = (i: RuleInput) => OfferCandidate | null;

const idleCashSavings: Rule = (i) => {
  const idle = i.snapshot.idleCash;
  if (idle < 3000) return null;
  const p = pickBest(i.products, { categories: ['savings_account'] });
  if (!p) return null;
  const amount = floor100(idle * 0.5);
  if (amount <= 0) return null;
  const rate = rateOf(p);
  return productCandidate(i, 'idle_cash_savings', 80, p, {
    title: `Pune la lucru banii din contul curent: ${p.name}`,
    suggestedAmount: amount,
    reasoning:
      `Ai aproximativ ${ron(idle)} disponibili peste cheltuielile lunare. ` +
      `Îți propunem să muți ${ron(amount)} (jumătate) în ${p.name}` +
      (rate !== null ? `, cu o dobândă de ${rate}% pe an conform catalogului` : '') +
      ', păstrând restul pentru cheltuieli neprevăzute.',
  });
};

const goalTermDeposit: Rule = (i) => {
  const idle = i.snapshot.idleCash;
  if (idle < 10_000) return null;
  const goal = activeGoals(i)
    .filter((g) => g.monthsLeft !== null && g.monthsLeft >= 6 && g.targetAmount > g.currentAmount)
    .sort((a, b) => (a.monthsLeft ?? 0) - (b.monthsLeft ?? 0))[0];
  if (!goal) return null;
  const pick = pickTermDeposit(i.products, goal.monthsLeft!);
  if (!pick) return null;
  const remaining = goal.targetAmount - goal.currentAmount;
  const amount = floor100(Math.min(idle * 0.5, remaining));
  if (amount <= 0) return null;
  return productCandidate(i, 'goal_term_deposit', 85, pick.product, {
    title: `Depozit pe ${months(pick.termMonths)} pentru „${goal.name}”`,
    suggestedAmount: amount,
    termMonths: pick.termMonths,
    reasoning:
      `Obiectivul „${goal.name}” are nevoie de încă ${ron(remaining)} în ${months(goal.monthsLeft!)}. ` +
      `Un depozit ${pick.product.name} pe ${months(pick.termMonths)}` +
      (pick.ratePct !== null ? ` (${pick.ratePct}% pe an)` : '') +
      ` cu ${ron(amount)} se termină înainte de termenul obiectivului.`,
  });
};

const emergencyFund: Rule = (i) => {
  const s = i.snapshot;
  const target = 3 * s.avgMonthlySpending;
  if (!(s.savingsBalance < target) || !(incomeOf(i) > s.avgMonthlySpending)) return null;
  const p =
    pickBest(i.products, { categories: ['savings_account'], goodFor: 'emergency_fund' }) ??
    pickBest(i.products, { categories: ['savings_account'] });
  if (!p) return null;
  const monthly = floor10(surplusOf(i) * 0.3);
  if (monthly <= 0) return null;
  return productCandidate(i, 'emergency_fund', 70, p, {
    title: `Construiește-ți fondul de urgență cu ${p.name}`,
    monthlyContribution: monthly,
    goalTarget: target,
    reasoning:
      `Economiile tale (${ron(s.savingsBalance)}) acoperă mai puțin de 3 luni de cheltuieli (${ron(target)}). ` +
      `Cu ${ron(monthly)} pe lună (30% din surplusul lunar) în ${p.name} îți construiești treptat o rezervă.`,
  });
};

const homeGoal: Rule = (i) => {
  const goal = activeGoals(i).find((g) => g.type === 'home');
  if (!goal) return null;
  const monthly =
    goal.requiredMonthlySaving !== null && goal.requiredMonthlySaving > 0
      ? floor10(goal.requiredMonthlySaving)
      : floor10(surplusOf(i) * 0.3);
  const remaining = Math.max(0, goal.targetAmount - goal.currentAmount);
  const tail =
    ' Banii adunați pot acoperi avansul pentru locuință; înainte de un credit ipotecar îți putem face o pre-verificare a gradului de îndatorare.';

  const housing = pickBest(i.products, { categories: ['housing_savings'] });
  if (housing) {
    return productCandidate(i, 'home_goal', 90, housing, {
      title: `Economisește pentru „${goal.name}” cu ${housing.name}`,
      monthlyContribution: monthly > 0 ? monthly : null,
      goalTarget: goal.targetAmount,
      reasoning: `Pentru „${goal.name}” mai ai de strâns ${ron(remaining)}. Îți propunem ${ron(monthly)} pe lună în ${housing.name}.${tail}`,
    });
  }

  // R6: no housing savings in the catalog → best RON term deposit fitting the goal horizon, else savings.
  const deposit = goal.monthsLeft !== null ? pickTermDeposit(i.products, goal.monthsLeft) : null;
  const depositAmount = floor100(Math.min(i.snapshot.idleCash * 0.5, remaining));
  if (deposit && depositAmount >= (deposit.product.min_amount?.value ?? 0) && depositAmount > 0) {
    return productCandidate(i, 'home_goal', 90, deposit.product, {
      title: `Depozit pe ${months(deposit.termMonths)} pentru avansul locuinței`,
      suggestedAmount: depositAmount,
      monthlyContribution: monthly > 0 ? monthly : null,
      termMonths: deposit.termMonths,
      reasoning:
        `Pentru „${goal.name}” mai ai de strâns ${ron(remaining)}. ` +
        `Poți plasa ${ron(depositAmount)} într-un ${deposit.product.name} pe ${months(deposit.termMonths)}` +
        (deposit.ratePct !== null ? ` (${deposit.ratePct}% pe an)` : '') +
        ` și economisi în continuare ${ron(monthly)} pe lună.${tail}`,
    });
  }
  const savings = pickBest(i.products, { categories: ['savings_account'] });
  if (!savings || monthly <= 0) return null;
  return productCandidate(i, 'home_goal', 90, savings, {
    title: `Economisește lunar pentru avansul locuinței`,
    monthlyContribution: monthly,
    goalTarget: remaining,
    reasoning: `Pentru „${goal.name}” mai ai de strâns ${ron(remaining)}. Îți propunem ${ron(monthly)} pe lună în ${savings.name}.${tail}`,
  });
};

const retirement: Rule = (i) => {
  const hasGoal = activeGoals(i).some((g) => g.type === 'retirement');
  if (!hasGoal && !(i.user.age !== null && i.user.age >= 40)) return null;
  if (i.ownedAccountTypes.includes('pension')) return null;
  const p = pickBest(i.products, { categories: ['private_pension'] });
  if (!p) return null;
  return productCandidate(i, 'retirement', hasGoal ? 85 : 75, p, {
    title: `Pensie privată (Pilonul III): ${p.name}`,
    monthlyContribution: PENSION_DEDUCTIBLE_MONTHLY_RON,
    reasoning:
      `Nu ai încă o pensie privată. Cu ${ron(PENSION_DEDUCTIBLE_MONTHLY_RON)} pe lună în ${p.name} ` +
      'folosești integral plafonul deductibil fiscal (400 EUR pe an) și îți completezi pensia de stat.',
  });
};

const longTermGrowth: Rule = (i) => {
  if (i.user.riskProfile === 'conservative') return null;
  const idle = i.snapshot.idleCash;
  if (idle < 5000) return null;
  const maxRisk = RISK_PROFILE_MAX[i.user.riskProfile];
  const growth = (p: CatalogProduct): number =>
    p.good_for?.some((g) => g === 'long_term_growth' || g === 'medium_term_growth') ? 1 : 0;
  // R9: prefer growth-oriented funds, then the highest allowed risk level, then slug.
  const p = i.products
    .filter((x) => x.category === 'investment_fund' && isRuleEligible(x))
    .filter((x) => (x.risk_level ?? NULL_RISK_LEVEL) <= maxRisk)
    .sort(
      (a, b) =>
        growth(b) - growth(a) ||
        (b.risk_level ?? NULL_RISK_LEVEL) - (a.risk_level ?? NULL_RISK_LEVEL) ||
        a.slug.localeCompare(b.slug),
    )[0];
  if (!p) return null;
  const amount = floor100(idle * 0.3);
  if (amount <= 0) return null;
  return productCandidate(i, 'long_term_growth', 60, p, {
    title: `Investiție pe termen lung: ${p.name}`,
    suggestedAmount: amount,
    reasoning:
      `Profilul tău de risc permite investiții cu risc până la ${maxRisk}. ` +
      `Poți investi ${ron(amount)} (30% din banii disponibili) în ${p.name} (risc ${p.risk_level ?? 'nespecificat'}). ` +
      'Randamentele nu sunt garantate.',
  });
};

const creditCardDebt: Rule = (i) => {
  const debt = i.snapshot.creditCardDebt;
  if (debt < 1000) return null;
  const p = pickBest(i.products, { categories: ['personal_loan'], goodFor: 'debt_consolidation' });
  if (p) {
    const rate = rateOf(p);
    return productCandidate(i, 'credit_card_debt', 88, p, {
      title: `Refinanțează datoria de pe card cu ${p.name}`,
      reasoning:
        `Ai o datorie de ${ron(debt)} pe cardul de credit. ` +
        `Un credit de consolidare precum ${p.name}` +
        (rate !== null ? ` (dobândă de la ${rate}% pe an conform catalogului)` : '') +
        ' poate avea un cost mai mic decât dobânda cardului. Îți putem face o pre-verificare a eligibilității.',
    });
  }
  return tipCandidate(
    'credit_card_debt',
    88,
    'Redu datoria de pe cardul de credit',
    `Ai o datorie de ${ron(debt)} pe cardul de credit. Rambursarea ei cât mai rapidă reduce dobânzile plătite.`,
  );
};

const subscriptionsTip: Rule = (i) => {
  const subs = i.snapshot.subscriptionsMonthly;
  if (subs < 150) return null;
  const yearly = (subs * 12) / 2;
  return tipCandidate(
    'subscriptions_tip',
    50,
    'Revizuiește-ți abonamentele',
    `Plătești în medie ${ron(subs)} pe lună pe abonamente. Dacă renunți la jumătate dintre ele, economisești circa ${ron(yearly)} pe an.`,
  );
};

const youthPackage: Rule = (i) => {
  if (i.user.age === null || i.user.age > 26) return null;
  const p = i.products
    .filter((x) => (x.category === 'account_package' || x.category === 'current_account') && isRuleEligible(x))
    .filter((x) => YOUTH_RE.test(x.name) || (x.good_for ?? []).some((g) => YOUTH_RE.test(g)))
    .sort(byRateThenSlug)[0];
  if (!p) return null;
  return productCandidate(i, 'youth_package', 65, p, {
    title: `Pachet pentru tineri: ${p.name}`,
    reasoning: `La ${i.user.age} ani poți folosi ${p.name}, un pachet de cont curent potrivit pentru tineri.`,
  });
};

const RULES: Rule[] = [
  idleCashSavings,
  goalTermDeposit,
  emergencyFund,
  homeGoal,
  retirement,
  longTermGrowth,
  creditCardDebt,
  subscriptionsTip,
  youthPackage,
];

/** Runs every rule; sorted by score desc, at most one candidate per rule, at most 5. */
export function generateOfferCandidates(i: RuleInput): OfferCandidate[] {
  const out: OfferCandidate[] = [];
  const seen = new Set<RuleId>();
  for (const rule of RULES) {
    const c = rule(i);
    if (c && !seen.has(c.ruleId)) {
      seen.add(c.ruleId);
      out.push(c);
    }
  }
  return out.sort((a, b) => b.score - a.score || a.ruleId.localeCompare(b.ruleId)).slice(0, MAX_OFFERS);
}
