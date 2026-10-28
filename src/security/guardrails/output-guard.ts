export interface OutputGuardContext {
  allowedRates: number[];
  catalogNames: string[];
  recommendationCategories: string[];
  /** Last 4 IBAN characters the reply may cite as masked refs (…1234, ••1234); others are removed. Omitted → no check. */
  accountSuffixes?: string[];
}

export interface OutputGuardResult {
  text: string;
  strippedSentences: string[];
  warnings: string[];
  disclaimerAdded: boolean;
}

export const INVESTMENT_DISCLAIMER =
  '_Investițiile implică riscuri; randamentele trecute nu garantează rezultate viitoare. Recomandarea ține cont de profilul tău de risc._';

const DISCLAIMER_CATEGORIES = ['investment_fund', 'private_pension'];
const RATE_KEYWORD = /dobând|dobânz|dobanz|randament|DAE|DOBANDA|interest|yield|return|p\.a\.|pe an/i;
const PRODUCT_WORD = /\b(?:cont|depozit|card|credit|fond|pensie|asigurare|account|deposit|fund|pension|loan)/i;
const RATE_RE = /(?<![\d.,])(\d+(?:[.,]\d+)?)\s*%/g;
const SPAN_RES = [/\*\*([^*\n]+?)\*\*/g, /__([^_\n]+?)__/g, /"([^"\n]+?)"/g, /„([^”"\n]+?)[”"]/g, /“([^”\n]+?)”/g];
const RATE_TOLERANCE = 0.005;
/** Masked account reference: optional "RO49" prefix, an ellipsis or bullets, then exactly 4 digits ("…9149", "••9149"). */
const MASKED_ACCOUNT_RE = /(?:\b[A-Z]{2}\d{2})?(?:…|\.{3}|•{2,}\s?)(\d{4})(?!\d)/g;

/** Numbers followed by `%` (accepts `4,5%`, `4.50 %`, `4,50% p.a.`). */
export function extractRates(text: string): number[] {
  const out: number[] = [];
  for (const m of (text ?? '').matchAll(RATE_RE)) {
    const n = Number(m[1].replace(',', '.'));
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}

/** Splits text into sentence segments (sentence + trailing whitespace) so it can be rebuilt verbatim. */
function segments(text: string): { sentence: string; trailing: string }[] {
  const out: { sentence: string; trailing: string }[] = [];
  let start = 0;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    const isEnd = ch === '\n' || (/[.!?]/.test(ch) && (i + 1 >= text.length || /\s/.test(text[i + 1])));
    if (isEnd) {
      let j = ch === '\n' ? i : i + 1;
      while (j < text.length && /\s/.test(text[j])) j++;
      const sentenceEnd = ch === '\n' ? i : i + 1;
      out.push({ sentence: text.slice(start, sentenceEnd), trailing: text.slice(sentenceEnd, j) });
      start = j;
      i = j;
      continue;
    }
    i++;
  }
  if (start < text.length) out.push({ sentence: text.slice(start), trailing: '' });
  return out;
}

function hasUnallowedRate(sentence: string, allowed: number[]): boolean {
  if (!RATE_KEYWORD.test(sentence)) return false;
  return extractRates(sentence).some((r) => !allowed.some((a) => Math.abs(a - r) <= RATE_TOLERANCE));
}

/**
 * Post-processes the agent's reply: strips sentences quoting rates absent from this turn's tool results /
 * catalog, warns about product names not in the catalog, and appends the investment disclaimer.
 */
export function guardOutput(reply: string, ctx: OutputGuardContext): OutputGuardResult {
  const strippedSentences: string[] = [];
  const warnings: string[] = [];

  let text = '';
  for (const { sentence, trailing } of segments(reply ?? '')) {
    if (sentence.trim() && hasUnallowedRate(sentence, ctx.allowedRates)) {
      strippedSentences.push(sentence.trim());
      text += trailing.replace(/[^\n]/g, '');
    } else {
      text += sentence + trailing;
    }
  }
  text = text.replace(/\n{3,}/g, '\n\n').trim();

  if (ctx.accountSuffixes) {
    const known = new Set(ctx.accountSuffixes);
    text = text.replace(MASKED_ACCOUNT_RE, (m: string, digits: string) => {
      if (known.has(digits)) return m;
      warnings.push(`Referință de cont necunoscută: "${m}"`);
      return '••••';
    });
  }

  const names = ctx.catalogNames.map((n) => n.toLowerCase().trim()).filter(Boolean);
  const seen = new Set<string>();
  for (const re of SPAN_RES) {
    for (const m of text.matchAll(re)) {
      const span = m[1].trim();
      const lower = span.toLowerCase();
      if (!span || seen.has(lower) || !PRODUCT_WORD.test(span)) continue;
      seen.add(lower);
      const known = names.some((n) => n.includes(lower) || lower.includes(n));
      if (!known) warnings.push(`Produs necunoscut în catalog: "${span}"`);
    }
  }

  let disclaimerAdded = false;
  if (ctx.recommendationCategories.some((c) => DISCLAIMER_CATEGORIES.includes(c)) && !text.includes(INVESTMENT_DISCLAIMER)) {
    text = `${text}\n\n${INVESTMENT_DISCLAIMER}`;
    disclaimerAdded = true;
  }
  return { text, strippedSentences, warnings, disclaimerAdded };
}
