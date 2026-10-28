/** Simulated Romanian IBANs (Raiffeisen bank code `RZBR`) and ISO 13616 validation. */

function mod97(numeric: string): number {
  let rem = 0;
  for (let i = 0; i < numeric.length; i += 7) {
    rem = Number(String(rem) + numeric.slice(i, i + 7)) % 97;
  }
  return rem;
}

function toNumeric(s: string): string {
  return s
    .split('')
    .map((c) => (/[A-Z]/.test(c) ? String(c.charCodeAt(0) - 55) : c))
    .join('');
}

/** ISO 13616 mod-97 check (spaces stripped, any country). */
export function isValidIban(s: string): boolean {
  const iban = String(s ?? '')
    .replace(/\s+/g, '')
    .toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban)) return false;
  return mod97(toNumeric(iban.slice(4) + iban.slice(0, 4))) === 1;
}

/** `RO` + 2 check digits + `RZBR` + 16 digits derived from `n`. */
export function generateIban(n: number): string {
  const bban = 'RZBR' + String(Math.abs(Math.trunc(n))).padStart(16, '0').slice(-16);
  const check = 98 - mod97(toNumeric(bban + 'RO00'));
  return 'RO' + String(check).padStart(2, '0') + bban;
}
