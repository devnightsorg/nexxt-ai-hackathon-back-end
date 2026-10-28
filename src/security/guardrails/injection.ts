export type InjectionSeverity = 'none' | 'suspicious' | 'high';

export interface InjectionResult {
  severity: InjectionSeverity;
  matches: string[];
}

const IBAN_LIKE = /\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){3,7}(?:\s?[A-Z0-9]{1,4})?\b/;

/** Explicit override / exfiltration attempts (EN + RO). */
const HIGH: RegExp[] = [
  /\b(?:ignore|disregard|forget|override|bypass)\s+(?:all\s+|any\s+)?(?:of\s+)?(?:the\s+|your\s+|my\s+)?(?:previous|prior|above|earlier|preceding|initial|system)\s+(?:instructions?|rules|prompts?|directives|guidelines)\b/i,
  /\b(?:ignor[ăa]\w*|uit[ăa]\w*|neglijeaz[ăa]\w*)\s+(?:toate\s+)?(?:instruc[țţt]iunile|regulile|indica[țţt]iile)(?:\s+(?:anterioare|precedente|de\s+mai\s+sus|ini[țţt]iale|de\s+sistem))?/i,
  /\b(?:reveal|show|print|display|repeat|leak|output|tell\s+me|give\s+me|dump)\b.{0,40}\b(?:system\s*prompt|system\s+message|hidden\s+instructions|initial\s+instructions|your\s+instructions)\b/i,
  /\b(?:arat[ăa]\w*|afi[șşs]eaz[ăa]\w*|spune\w*|dezv[ăa]luie\w*|scrie\w*|d[ăa]-mi)\b.{0,40}(?:system\s*prompt|prompt\w*\s+(?:de\s+)?sistem|instruc[țţt]iunile\s+(?:de\s+sistem|ascunse|ini[țţt]iale|tale))/i,
  /\byou\s+are\s+now\b/i,
  /\bde\s+acum\s+(?:înainte\s+|inainte\s+)?e[șşs]ti\b/i,
  /\bdeveloper\s+mode\b|\bmodul\s+dezvoltator\b|\bjailbreak\b/i,
  /\bDAN\b/,
  /<\/?\s*system\s*>|<\|im_(?:start|end)\|>/i,
];

const TRANSFER_ALL: RegExp[] = [
  /\b(?:transfer|send|move|wire)\s+all\s+(?:of\s+)?(?:my\s+|the\s+|your\s+)?(?:money|funds|balance|savings)\b/i,
  /\b(?:transfer[ăa]\w*|trimite\w*|mut[ăa]\w*|vireaz[ăa]\w*)\s+(?:to[țţt]i|toat[ăa]|tot)\s+(?:banii|suma|soldul|economiile|fondurile)\b/i,
];
const TRANSFER_TARGET = /\bto\b|\bc[ăa]tre\b/i;

/** Softer signals. */
const SUSPICIOUS: RegExp[] = [
  /\bact\s+as\b|\bpretend\b|\brole[\s-]?play\b/i,
  /\bjoac[ăa]\s+rolul\b|\bpref[ăa]-te\b|\bcomport[ăa]-te\s+ca\b|\bimagineaz[ăa]-[țţt]i\s+c[ăa]\s+e[șşs]ti\b/i,
  /[A-Za-z0-9+/=]{200,}/,
  /(?:^|\n)\s*system\s*:/i,
];

function collect(text: string, patterns: RegExp[]): string[] {
  const out: string[] = [];
  for (const re of patterns) {
    const m = re.exec(text);
    if (m) out.push(m[0].length > 80 ? `${m[0].slice(0, 77)}...` : m[0]);
  }
  return out;
}

/** Deterministic prompt-injection heuristics (first layer; the fast-model classifier is the second). */
export function detectInjection(text: string): InjectionResult {
  const t = (text ?? '').normalize('NFC');
  const high = collect(t, HIGH);
  const transfer = collect(t, TRANSFER_ALL);
  if (transfer.length && (IBAN_LIKE.test(t) || TRANSFER_TARGET.test(t))) high.push(...transfer);
  if (high.length) return { severity: 'high', matches: high };
  const suspicious = collect(t, SUSPICIOUS);
  if (suspicious.length) return { severity: 'suspicious', matches: suspicious };
  return { severity: 'none', matches: [] };
}
