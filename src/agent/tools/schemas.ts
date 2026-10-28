import { z } from 'zod';

/** RON amount: > 0, at most 2 decimals. */
export const amountSchema = z
  .number()
  .positive()
  .refine((n) => Math.abs(Math.round(n * 100) - n * 100) < 1e-6, { message: 'Suma poate avea cel mult 2 zecimale' });

export const isoDateSchema = z.string().max(40).describe('ISO date, e.g. 2026-10-01');

export function parseDate(s: string | undefined, endOfDay = false): Date | undefined {
  if (!s) return undefined;
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z` : s);
  if (Number.isNaN(d.getTime())) throw new Error(`Dată invalidă: ${s}`);
  return d;
}
