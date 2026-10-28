/**
 * Deterministic JSON: object keys sorted recursively, undefined properties dropped, values with toJSON
 * (Date, Decimal) serialized through it. Used for the audit hash chain, so it must never change behaviour.
 */
export function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'bigint') return JSON.stringify(value.toString());
  if (typeof value === 'function' || typeof value === 'symbol') return 'null';
  if (typeof value !== 'object') return JSON.stringify(value);

  const withToJson = value as { toJSON?: () => unknown };
  if (typeof withToJson.toJSON === 'function') return stableStringify(withToJson.toJSON());

  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(',')}]`;

  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined && typeof obj[k] !== 'function' && typeof obj[k] !== 'symbol')
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}
