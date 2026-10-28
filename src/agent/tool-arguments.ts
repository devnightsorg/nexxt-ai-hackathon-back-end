/**
 * Parses a tool call's JSON arguments ('' → {}). Some Featherless deployments occasionally stream the
 * arguments with the opening repeated (`{}{}{}`, `{"slug": "{"slug": "x"}`); then the trailing object is
 * used, but only when the raw text starts with that object's own opening (its first key, or `{}`), so a
 * truncated or nested payload is never mistaken for the arguments. Returns undefined when unparseable.
 */
export function parseToolArguments(raw: string | null | undefined): unknown {
  const text = raw?.trim() ? raw.trim() : '{}';
  try {
    return JSON.parse(text);
  } catch {
    // fall through to salvage
  }
  for (let i = text.lastIndexOf('{'); i > 0; i = text.lastIndexOf('{', i - 1)) {
    const tail = text.slice(i);
    let value: unknown;
    try {
      value = JSON.parse(tail);
    } catch {
      continue;
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const opening = tail.match(/^\{\s*(?:"(?:[^"\\]|\\.)*"\s*:|\})/)?.[0];
    return opening && text.startsWith(opening) ? value : undefined;
  }
  return undefined;
}
