import { toMoney } from '../common/money';
import { CatalogProduct, OPENABLE_CATEGORIES, termMonthsOf } from '../products/catalog.types';

export type Projection =
  | { available: false; productSlug: string; reason: string }
  | {
      available: true;
      productSlug: string;
      principal: number;
      monthlyContribution: number;
      termMonths: number;
      annualRatePct: number;
      grossInterest: number;
      taxRate: number;
      tax: number;
      netInterest: number;
      finalAmount: number;
      goalReachMonths: number | null;
      assumptions: string[];
    };

export interface SimulateInput {
  product: CatalogProduct;
  amount: number;
  termMonths?: number;
  monthlyContribution?: number;
  goalTarget?: number;
  interestTaxRate: number;
}

const MAX_GOAL_MONTHS = 600;
const TAXED_CATEGORIES = ['savings_account', 'term_deposit', 'housing_savings'];
export const RATE_UNAVAILABLE = 'Dobânda/randamentul nu este disponibil în catalog';
const NOT_SIMULABLE = 'Simularea este disponibilă doar pentru produse de economisire, investiții sau pensie';
const FUND_ASSUMPTION = 'Randament istoric, negarantat; impozitul pe câștig nu este inclus';
const PENSION_ASSUMPTION = 'Contribuțiile la Pilonul III sunt deductibile fiscal în limita legală';

const pct = (n: number): string => `${Number(n.toFixed(2))}%`;

/** Deterministic projection of a catalog product. All figures come from code, never from the LLM. */
export function simulate(i: SimulateInput): Projection {
  const { product } = i;
  const slug = product.slug;
  if (!OPENABLE_CATEGORIES.includes(product.category)) {
    return { available: false, productSlug: slug, reason: NOT_SIMULABLE };
  }

  const isDeposit = product.category === 'term_deposit';
  const listedTerms = termMonthsOf(product);
  const termMonths = i.termMonths ?? (isDeposit && listedTerms.length ? listedTerms[0] : 12);

  const termRate = product.rates_by_term?.find((r) => r.months === termMonths)?.ratePct;
  const rate = termRate ?? product.interest_rate_or_return?.value ?? null;
  if (rate === null || rate === undefined) {
    return { available: false, productSlug: slug, reason: RATE_UNAVAILABLE };
  }

  const taxRate = TAXED_CATEGORIES.includes(product.category) ? i.interestTaxRate : 0;
  const contribution = isDeposit ? 0 : Math.max(0, i.monthlyContribution ?? 0);
  const amount = i.amount;
  const assumptions: string[] = [];
  const asOf = product.interest_rate_or_return?.as_of;
  assumptions.push(
    termRate !== undefined
      ? `Dobânda pentru ${termMonths} luni: ${pct(rate)} pe an (catalog${asOf ? `, ${asOf}` : ''})`
      : `Rata anuală folosită: ${pct(rate)} (catalog${asOf ? `, ${asOf}` : ''})`,
  );

  /** Net balance after `m` months (interest taxed at `taxRate`). */
  let balanceAt: (m: number) => { gross: number; net: number };
  if (isDeposit) {
    balanceAt = (m) => {
      const gross = (amount * rate * m) / 100 / 12;
      return { gross, net: amount + gross * (1 - taxRate) };
    };
    assumptions.push('Dobândă simplă, fixă pe durata termenului, plătită la scadență');
    if (i.monthlyContribution) assumptions.push('Depozitele la termen nu acceptă contribuții lunare; acestea au fost ignorate');
    if (listedTerms.length && !listedTerms.includes(termMonths)) {
      assumptions.push(`Termenul de ${termMonths} luni nu este listat în catalog; s-a folosit rata de referință`);
    }
  } else {
    const r = rate / 100 / 12;
    balanceAt = (m) => {
      let bal = amount;
      for (let k = 0; k < m; k++) bal = bal * (1 + r) + contribution;
      const gross = bal - amount - contribution * m;
      return { gross, net: amount + contribution * m + gross * (1 - taxRate) };
    };
    assumptions.push('Capitalizare lunară; contribuțiile sunt adăugate la final de lună');
    if (product.category === 'savings_account') assumptions.push('Dobânda este variabilă și poate fi modificată de bancă');
  }

  if (product.category === 'investment_fund') assumptions.push(FUND_ASSUMPTION);
  if (product.category === 'private_pension') assumptions.push(PENSION_ASSUMPTION);
  if (taxRate > 0) assumptions.push(`Impozit pe dobândă de ${pct(taxRate * 100)}, reținut la sursă`);

  const end = balanceAt(termMonths);
  const grossInterest = toMoney(end.gross);
  const tax = toMoney(end.gross * taxRate);
  const netInterest = toMoney(grossInterest - tax);
  const finalAmount = toMoney(amount + contribution * termMonths + netInterest);

  let goalReachMonths: number | null = null;
  if (i.goalTarget !== undefined && i.goalTarget !== null) {
    for (let m = 0; m <= MAX_GOAL_MONTHS; m++) {
      if (toMoney(balanceAt(m).net) >= i.goalTarget) {
        goalReachMonths = m;
        break;
      }
    }
  }

  return {
    available: true,
    productSlug: slug,
    principal: toMoney(amount),
    monthlyContribution: toMoney(contribution),
    termMonths,
    annualRatePct: rate,
    grossInterest,
    taxRate,
    tax,
    netInterest,
    finalAmount,
    goalReachMonths,
    assumptions,
  };
}
