export type PiiKind = 'IBAN' | 'CNP' | 'CARD' | 'EMAIL' | 'PHONE';

const KINDS: PiiKind[] = ['IBAN', 'CNP', 'CARD', 'EMAIL', 'PHONE'];
const TOKEN_RE = /\[(IBAN|CNP|CARD|EMAIL|PHONE)_(\d+)\]/g;

const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const IBAN_RE = /\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){3,7}(?:\s?[A-Z0-9]{1,4})?\b/g;
const CNP_RE = /\b[1-8]\d{12}\b/g;
const CARD_RE = /\b(?:\d{13,19}|\d{4}(?:[ -]\d{4}){2,3}(?:[ -]\d{1,3})?|\d{4}[ -]\d{6}[ -]\d{4,5})\b/g;
const PHONE_RE = /(?:\+40|\b0)7\d{2}[\s.-]?\d{3}[\s.-]?\d{3}\b/g;

/** ISO 13616 mod-97 check (any country; spaces ignored). Local copy to avoid a cross-task dependency. */
export function isValidIbanChecksum(s: string): boolean {
  const iban = s.replace(/\s+/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban)) return false;
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let rem = 0;
  for (const ch of rearranged) {
    const v = ch >= 'A' && ch <= 'Z' ? String(ch.charCodeAt(0) - 55) : ch;
    for (const d of v) rem = (rem * 10 + Number(d)) % 97;
  }
  return rem === 1;
}

export function luhnValid(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = Number(digits[i]);
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return digits.length > 0 && sum % 10 === 0;
}

/** Longest prefix of an IBAN-like match (cut at a character boundary) that passes the checksum. */
function validIbanPrefix(match: string): string | null {
  for (let end = match.length; end >= 15; end--) {
    const candidate = match.slice(0, end);
    if (/\s$/.test(candidate)) continue;
    if (isValidIbanChecksum(candidate)) return candidate;
  }
  return null;
}

function normalize(kind: PiiKind, value: string): string {
  switch (kind) {
    case 'IBAN':
      return value.replace(/\s+/g, '').toUpperCase();
    case 'CARD':
    case 'CNP':
      return value.replace(/\D/g, '');
    case 'PHONE': {
      const digits = value.replace(/\D/g, '');
      return digits.startsWith('40') ? `0${digits.slice(2)}` : digits;
    }
    case 'EMAIL':
      return value.toLowerCase();
  }
}

/**
 * Replaces raw PII with stable numbered tokens (`[IBAN_1]`, `[CNP_1]`, ...) before text reaches the LLM,
 * and restores them in model output / tool arguments. State round-trips through `toJSON()`.
 */
export class PiiVault {
  private readonly byToken = new Map<string, string>();
  private readonly byValue = new Map<string, string>();
  private readonly counters: Record<PiiKind, number> = { IBAN: 0, CNP: 0, CARD: 0, EMAIL: 0, PHONE: 0 };
  private count = 0;

  constructor(state?: Record<string, string>) {
    for (const [token, value] of Object.entries(state ?? {})) {
      const m = /^\[(IBAN|CNP|CARD|EMAIL|PHONE)_(\d+)\]$/.exec(token);
      if (!m || typeof value !== 'string') continue;
      const kind = m[1] as PiiKind;
      this.byToken.set(token, value);
      this.byValue.set(`${kind}:${normalize(kind, value)}`, token);
      this.counters[kind] = Math.max(this.counters[kind], Number(m[2]));
    }
  }

  /** Number of PII occurrences replaced by `redact` on this instance. */
  get redactionCount(): number {
    return this.count;
  }

  redact(text: string): string {
    if (!text) return text;
    let out = text.replace(EMAIL_RE, (m) => this.tokenFor('EMAIL', m));
    out = out.replace(IBAN_RE, (m) => {
      const valid = validIbanPrefix(m);
      if (!valid) return m;
      return this.tokenFor('IBAN', valid) + m.slice(valid.length);
    });
    out = out.replace(CNP_RE, (m) => this.tokenFor('CNP', m));
    out = out.replace(CARD_RE, (m) => {
      const digits = m.replace(/\D/g, '');
      if (digits.length < 13 || digits.length > 19 || !luhnValid(digits)) return m;
      return this.tokenFor('CARD', m);
    });
    out = out.replace(PHONE_RE, (m) => this.tokenFor('PHONE', m));
    return out;
  }

  /** Replaces vault tokens with the original values, recursively inside strings of objects/arrays. */
  restore<T>(v: T): T {
    return this.restoreAny(v) as T;
  }

  toJSON(): Record<string, string> {
    return Object.fromEntries(this.byToken);
  }

  private restoreAny(v: unknown): unknown {
    if (typeof v === 'string') {
      return v.replace(TOKEN_RE, (token) => this.byToken.get(token) ?? token);
    }
    if (Array.isArray(v)) return v.map((x) => this.restoreAny(x));
    if (v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype) {
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, this.restoreAny(x)]));
    }
    return v;
  }

  private tokenFor(kind: PiiKind, value: string): string {
    this.count++;
    const key = `${kind}:${normalize(kind, value)}`;
    const existing = this.byValue.get(key);
    if (existing) return existing;
    const token = `[${kind}_${++this.counters[kind]}]`;
    this.byToken.set(token, value);
    this.byValue.set(key, token);
    return token;
  }
}

export const PII_KINDS = KINDS;
