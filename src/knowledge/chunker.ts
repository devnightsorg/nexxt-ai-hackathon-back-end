import matter from 'gray-matter';

export interface ChunkOptions {
  /** Max characters of a chunk body (excluding the "<title> › <heading path>" prefix line). Default 1200. */
  maxChars?: number;
  /** Characters repeated from the previous chunk when a long section is split. Default 150. */
  overlap?: number;
  /** Title override (otherwise front matter `title`, then the first `#` heading, then "Document"). */
  title?: string;
}

interface Section {
  path: string[];
  lines: string[];
}

/** Last `overlap` characters of `text`, starting at a word boundary when possible. */
function tailOf(text: string, overlap: number): string {
  if (overlap <= 0) return '';
  if (text.length <= overlap) return text;
  let tail = text.slice(text.length - overlap);
  const space = tail.search(/\s/);
  if (space > 0 && space < tail.length - 1) tail = tail.slice(space + 1);
  return tail.trim();
}

/** Hard-splits a single oversized paragraph into pieces of at most `size` chars, preferring whitespace. */
function hardSplit(text: string, size: number): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > size) {
    let cut = rest.lastIndexOf(' ', size);
    if (cut < size / 2) cut = size;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}

function splitBody(body: string, maxChars: number, overlap: number): string[] {
  if (body.length <= maxChars) return [body];
  const pieceMax = Math.max(20, maxChars - overlap - 2);
  const pieces: string[] = [];
  for (const para of body.split(/\n\s*\n/)) {
    const p = para.trim();
    if (!p) continue;
    if (p.length <= pieceMax) pieces.push(p);
    else pieces.push(...hardSplit(p, pieceMax));
  }

  const out: string[] = [];
  let cur = '';
  for (const piece of pieces) {
    const candidate = cur ? `${cur}\n\n${piece}` : piece;
    if (candidate.length <= maxChars) {
      cur = candidate;
      continue;
    }
    out.push(cur);
    const tail = tailOf(cur, Math.min(overlap, maxChars - piece.length - 2));
    cur = tail ? `${tail}\n\n${piece}` : piece;
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * Splits a markdown document into retrieval chunks: front matter → `meta`, sections split on `#`–`###`
 * headings, each chunk prefixed with `"<title> › <heading path>\n"`, long sections split on paragraph
 * boundaries with overlap.
 */
export function chunkMarkdown(md: string, o: ChunkOptions = {}): { meta: Record<string, unknown>; chunks: string[] } {
  const maxChars = o.maxChars ?? 1200;
  const overlap = o.overlap ?? 150;
  const parsed = matter(md);
  const meta = { ...(parsed.data as Record<string, unknown>) };
  const lines = parsed.content.replace(/\r\n/g, '\n').split('\n');

  const firstH1 = lines.find((l) => /^#\s+\S/.test(l))?.replace(/^#\s+/, '').trim();
  const title =
    o.title?.trim() || (typeof meta.title === 'string' && meta.title.trim()) || firstH1 || 'Document';

  const sections: Section[] = [];
  const stack: string[] = [];
  let current: Section = { path: [], lines: [] };
  let inFence = false;
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    const m = !inFence ? /^(#{1,3})\s+(.+?)\s*#*\s*$/.exec(line) : null;
    if (m) {
      sections.push(current);
      const level = m[1].length;
      stack.length = level - 1;
      stack[level - 1] = m[2].trim();
      const path = stack.filter((h, i) => h && !(i === 0 && h === title));
      current = { path, lines: [] };
    } else {
      current.lines.push(line);
    }
  }
  sections.push(current);

  const chunks: string[] = [];
  for (const s of sections) {
    const body = s.lines.join('\n').trim();
    if (!body) continue;
    const prefix = s.path.length ? `${title} › ${s.path.join(' › ')}\n` : `${title}\n`;
    for (const part of splitBody(body, maxChars, overlap)) chunks.push(prefix + part);
  }
  return { meta, chunks };
}
