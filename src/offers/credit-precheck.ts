import type { FinancialSnapshot } from '../banking/stats.service';
import { toMoney } from '../common/money';

const DTI_LIMIT = 0.4;
/** Assumed minimum monthly payment on revolving credit-card debt. */
const CARD_MIN_PAYMENT_RATE = 0.05;

export interface CreditPrecheck {
  dtiLimit: 0.4;
  existingDebtPayments: number;
  maxMonthlyInstallment: number;
  indicativeMaxLoan: number | null;
  indicative: true;
  notes: string[];
}

/** Indicative debt-to-income check (40% DTI); never a credit decision. */
export function creditPrecheck(
  s: FinancialSnapshot,
  o: { annualRatePct?: number; termMonths?: number } = {},
): CreditPrecheck {
  const existingDebtPayments = toMoney(s.creditCardDebt * CARD_MIN_PAYMENT_RATE);
  const maxMonthlyInstallment = toMoney(Math.max(0, DTI_LIMIT * s.avgMonthlyIncome - existingDebtPayments));
  let indicativeMaxLoan: number | null = null;
  if (o.annualRatePct !== undefined && o.termMonths !== undefined && o.termMonths > 0) {
    const r = o.annualRatePct / 100 / 12;
    const n = o.termMonths;
    const pv = r === 0 ? maxMonthlyInstallment * n : (maxMonthlyInstallment * (1 - Math.pow(1 + r, -n))) / r;
    indicativeMaxLoan = toMoney(Math.floor(pv));
  }
  const notes = [
    'Calcul orientativ: rata lunară totală nu poate depăși 40% din venitul net lunar.',
    'Ratele existente includ o plată minimă estimată de 5% din datoria cardului de credit.',
    'Decizia finală de creditare aparține băncii, după analiza dosarului complet.',
  ];
  if (indicativeMaxLoan !== null) {
    notes.push(`Suma maximă orientativă presupune o dobândă de ${o.annualRatePct}% pe an pe ${o.termMonths} luni.`);
  }
  return { dtiLimit: DTI_LIMIT, existingDebtPayments, maxMonthlyInstallment, indicativeMaxLoan, indicative: true, notes };
}
