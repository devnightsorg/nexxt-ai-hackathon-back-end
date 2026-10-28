export type ProductCategory =
  | 'current_account'
  | 'account_package'
  | 'savings_account'
  | 'term_deposit'
  | 'investment_fund'
  | 'private_pension'
  | 'personal_loan'
  | 'mortgage'
  | 'credit_card'
  | 'debit_card'
  | 'insurance'
  | 'housing_savings'
  | 'digital_service';

export const PRODUCT_CATEGORIES: readonly ProductCategory[] = [
  'current_account',
  'account_package',
  'savings_account',
  'term_deposit',
  'investment_fund',
  'private_pension',
  'personal_loan',
  'mortgage',
  'credit_card',
  'debit_card',
  'insurance',
  'housing_savings',
  'digital_service',
];

export interface CatalogProduct {
  slug: string;
  name: string;
  category: ProductCategory;
  summary: string;
  key_features: string[];
  interest_rate_or_return: { value: number | null; unit: string; conditions: string; as_of: string } | null;
  fees: { name: string; value: string | number | null; notes?: string }[];
  eligibility: string[];
  min_amount: { value: number; currency: string } | null;
  currencies: string[];
  terms: string[];
  risk_level: number | null;
  good_for: string[];
  source_urls: string[];
  retrieved_at: string;
  /** False when the product cannot be funded by a plain transfer (e.g. card round-ups only). */
  openable_via_transfer?: boolean;
  /** False when proactive offer rules must not suggest it (e.g. new-money-only deposits). */
  rule_eligible?: boolean;
  /** RON per-term rates for term deposits, parsed from the conditions text; [] when not listed. */
  rates_by_term?: { months: number; ratePct: number }[];
}

export const OPENABLE_CATEGORIES: ProductCategory[] = [
  'savings_account',
  'term_deposit',
  'investment_fund',
  'private_pension',
  'housing_savings',
];

const TERM_RE = /(\d+)\s*(lun[ăai]|months?|ani|an|years?)(?![a-zA-ZăâîșțşţĂÂÎȘȚ])/gi;

/** Parses `terms` strings ("1 lună", "3 luni", "12 months", "1 an", "2 years") into sorted unique month counts. */
export function termMonthsOf(p: Pick<CatalogProduct, 'terms'>): number[] {
  const months = new Set<number>();
  for (const t of p.terms ?? []) {
    for (const m of t.matchAll(TERM_RE)) {
      const n = Number(m[1]);
      const unit = m[2].toLowerCase();
      const isYears = unit === 'an' || unit === 'ani' || unit.startsWith('year');
      const total = isYears ? n * 12 : n;
      if (total > 0) months.add(total);
    }
  }
  return [...months].sort((a, b) => a - b);
}

const isStr = (x: unknown): x is string => typeof x === 'string';
const isStrArr = (x: unknown): x is string[] => Array.isArray(x) && x.every(isStr);
const isNumOrNull = (x: unknown): boolean => x === null || (typeof x === 'number' && Number.isFinite(x));

/** Returns the interface violations of one raw catalog item ([] when valid). */
export function validateCatalogItem(raw: unknown): string[] {
  if (!raw || typeof raw !== 'object') return ['not an object'];
  const p = raw as Record<string, unknown>;
  const errors: string[] = [];
  for (const k of ['slug', 'name', 'summary', 'retrieved_at']) {
    if (!isStr(p[k]) || !(p[k] as string).trim()) errors.push(`${k} must be a non-empty string`);
  }
  if (!PRODUCT_CATEGORIES.includes(p.category as ProductCategory)) errors.push(`invalid category "${String(p.category)}"`);
  for (const k of ['key_features', 'eligibility', 'currencies', 'terms', 'good_for', 'source_urls']) {
    if (!isStrArr(p[k])) errors.push(`${k} must be a string array`);
  }
  if (isStrArr(p.source_urls) && p.source_urls.length === 0) errors.push('source_urls must not be empty');
  if (!Array.isArray(p.fees) || !p.fees.every((f) => f && typeof f === 'object' && isStr((f as { name?: unknown }).name))) {
    errors.push('fees must be an array of { name, value }');
  }
  const r = p.interest_rate_or_return as Record<string, unknown> | null | undefined;
  if (r !== null) {
    if (!r || typeof r !== 'object' || !isNumOrNull(r.value) || !isStr(r.unit) || !isStr(r.conditions) || !isStr(r.as_of)) {
      errors.push('interest_rate_or_return must be null or { value, unit, conditions, as_of }');
    }
  }
  const min = p.min_amount as Record<string, unknown> | null | undefined;
  if (min !== null) {
    if (!min || typeof min !== 'object' || typeof min.value !== 'number' || !isStr(min.currency)) {
      errors.push('min_amount must be null or { value, currency }');
    }
  }
  if (!isNumOrNull(p.risk_level)) errors.push('risk_level must be a number or null');
  if (p.openable_via_transfer !== undefined && typeof p.openable_via_transfer !== 'boolean') {
    errors.push('openable_via_transfer must be boolean');
  }
  if (p.rule_eligible !== undefined && typeof p.rule_eligible !== 'boolean') errors.push('rule_eligible must be boolean');
  if (
    p.rates_by_term !== undefined &&
    !(
      Array.isArray(p.rates_by_term) &&
      p.rates_by_term.every(
        (x) => x && typeof (x as { months?: unknown }).months === 'number' && typeof (x as { ratePct?: unknown }).ratePct === 'number',
      )
    )
  ) {
    errors.push('rates_by_term must be an array of { months, ratePct }');
  }
  return errors;
}
