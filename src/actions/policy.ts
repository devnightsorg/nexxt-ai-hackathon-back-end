import { UnprocessableEntityException } from '@nestjs/common';
import { AccountType, RiskProfile } from '@prisma/client';
import { Principal } from '../auth/principal';
import { CatalogProduct, OPENABLE_CATEGORIES, termMonthsOf } from '../products/catalog.types';

export type ProposeInput =
  | {
      type: 'transfer';
      fromAccountId: string;
      toAccountId?: string;
      toIban?: string;
      beneficiaryName?: string;
      amount: number;
      reason?: string;
      /** Goal this money is for; on execution it counts toward the goal's progress. */
      goalId?: string;
    }
  | {
      type: 'open_product';
      productSlug: string;
      fromAccountId: string;
      amount: number;
      termMonths?: number;
      reason?: string;
      /** Goal this money is for; the opened account is linked to it (or counted toward it). */
      goalId?: string;
    };

export interface PolicyContext {
  principal: Principal;
  input: ProposeInput;
  amount: number;
  source: { id: string; userId: string; type: AccountType; status: string; balance: number } | null;
  target: { kind: 'own_account'; id: string; status: string } | { kind: 'external_iban'; ibanValid: boolean } | null;
  product: CatalogProduct | null;
  userRiskProfile: RiskProfile;
  usedTodayViaActions: number;
  limits: { maxPerAction: number; dailyLimit: number };
}

export interface PolicyVerdict {
  allowed: boolean;
  riskLevel: 'low' | 'medium' | 'high';
  violations: string[];
  notes: string[];
}

export const ALLOWED_SOURCE_TYPES: readonly AccountType[] = ['current', 'savings'];

/** Highest product `risk_level` (1..7 SRI) each user risk profile may buy. */
export const RISK_PROFILE_MAX: Readonly<Record<RiskProfile, number>> = {
  conservative: 2,
  balanced: 4,
  dynamic: 7,
};

/** Products whose risk level is checked against the user's profile. */
const RISK_CHECKED_CATEGORIES = ['investment_fund', 'private_pension'];
const NULL_RISK_LEVEL = 4;
const HIGH_RISK_AMOUNT = 10_000;
const MEDIUM_RISK_AMOUNT = 2_000;

function isValidAmount(n: unknown): n is number {
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return false;
  const cents = n * 100;
  return Math.abs(cents - Math.round(cents)) < 1e-6;
}

/** True when the catalog product may be opened by a plain RON transfer (ruling R7). */
export function isOpenableProduct(p: CatalogProduct): boolean {
  if (p.openable_via_transfer === false) return false;
  if (!OPENABLE_CATEGORIES.includes(p.category)) return false;
  const currencies = (p.currencies ?? []).map((c) => c.toUpperCase());
  return currencies.length === 0 || currencies.includes('RON');
}

/** Annual rate for the chosen term: `rates_by_term` first, else the headline rate. */
export function annualRateFor(p: CatalogProduct, termMonths?: number): number | null {
  const byTerm = termMonths !== undefined ? p.rates_by_term?.find((r) => r.months === termMonths) : undefined;
  if (byTerm) return byTerm.ratePct;
  return p.interest_rate_or_return?.value ?? null;
}

/** Pure policy engine: every violated rule is reported (not just the first). */
export function evaluatePolicy(ctx: PolicyContext): PolicyVerdict {
  const { principal, input, amount, source, target, product, limits } = ctx;
  const violations: string[] = [];
  const notes: string[] = [];
  const add = (code: string) => {
    if (!violations.includes(code)) violations.push(code);
  };

  const amountOk = isValidAmount(amount);
  if (!amountOk) add('AMOUNT_INVALID');

  // Source account
  if (!source || source.userId !== principal.userId || source.status !== 'active') {
    add('SOURCE_NOT_FOUND');
  } else {
    if (!ALLOWED_SOURCE_TYPES.includes(source.type)) add('SOURCE_TYPE_NOT_ALLOWED');
    if (amountOk && source.balance < amount) add('INSUFFICIENT_FUNDS');
  }

  // Limits
  if (amountOk) {
    if (amount > limits.maxPerAction) add('PER_ACTION_LIMIT');
    if (ctx.usedTodayViaActions + amount > limits.dailyLimit) add('DAILY_LIMIT');
    if (principal.kind === 'api_key' && principal.maxAmountPerAction !== null && principal.maxAmountPerAction < amount) {
      add('API_KEY_LIMIT');
    }
  }

  let external = false;
  if (input.type === 'transfer') {
    if (!target) {
      add('TARGET_NOT_FOUND');
    } else if (target.kind === 'own_account') {
      if (source && target.id === source.id) add('SAME_ACCOUNT');
      else if (target.status !== 'active') add('TARGET_NOT_FOUND');
    } else {
      external = true;
      if (!target.ibanValid) add('IBAN_INVALID');
      if (principal.kind === 'api_key') add('EXTERNAL_TRANSFER_NOT_ALLOWED_FOR_AGENT');
      notes.push('Transfer către un cont extern');
    }
  } else if (!product) {
    add('PRODUCT_NOT_FOUND');
  } else {
    if (!isOpenableProduct(product)) add('PRODUCT_NOT_OPENABLE');
    if (amountOk && product.min_amount && amount < product.min_amount.value) add('BELOW_MIN_AMOUNT');
    const terms = termMonthsOf(product);
    if (terms.length > 0) {
      const tm = input.termMonths;
      const missingForDeposit = tm === undefined && product.category === 'term_deposit';
      if (missingForDeposit || (tm !== undefined && !terms.includes(tm))) add('TERM_NOT_AVAILABLE');
    }
    if (RISK_CHECKED_CATEGORIES.includes(product.category)) {
      const level = product.risk_level ?? NULL_RISK_LEVEL;
      if (level > RISK_PROFILE_MAX[ctx.userRiskProfile]) add('RISK_PROFILE_MISMATCH');
      if (product.risk_level === null) notes.push('Nivelul de risc al produsului nu este publicat; se consideră 4');
    }
  }

  const fund = input.type === 'open_product' && product?.category === 'investment_fund';
  const amt = amountOk ? amount : 0;
  const riskLevel: PolicyVerdict['riskLevel'] =
    external || amt > HIGH_RISK_AMOUNT ? 'high' : amt > MEDIUM_RISK_AMOUNT || fund ? 'medium' : 'low';

  return { allowed: violations.length === 0, riskLevel, violations, notes };
}

export class PolicyDeniedException extends UnprocessableEntityException {
  constructor(public readonly violations: string[]) {
    super({ statusCode: 422, error: 'PolicyDenied', message: 'Acțiunea nu respectă regulile băncii', violations });
  }
}
