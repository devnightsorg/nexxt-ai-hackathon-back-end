import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

const MAX_AMOUNT = 1_000_000_000;
const INVALID_AMOUNT = 'Suma trebuie să fie un număr pozitiv cu maximum 2 zecimale';

const ronFormat = new Intl.NumberFormat('ro-RO', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
  useGrouping: 'always',
});

/** Money for JSON responses: a plain number rounded half-up to 2 decimals. */
export function toMoney(d: Prisma.Decimal | number | string): number {
  return new Prisma.Decimal(d).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP).toNumber();
}

/** Validates an input amount: a JSON number, > 0, at most 2 decimals, at most 1,000,000,000. */
export function parseAmount(x: unknown): Prisma.Decimal {
  if (typeof x !== 'number' || !Number.isFinite(x) || x <= 0 || x > MAX_AMOUNT) {
    throw new BadRequestException(INVALID_AMOUNT);
  }
  const amount = new Prisma.Decimal(x);
  if (amount.decimalPlaces() > 2) throw new BadRequestException(INVALID_AMOUNT);
  return amount;
}

/** Romanian formatting without currency symbol, e.g. 2000 → "2.000,00". */
export function formatRon(n: number): string {
  return ronFormat.format(toMoney(n));
}
