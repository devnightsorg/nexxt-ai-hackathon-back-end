import { sha256Hex } from './crypto.js';

// Shared between gateway (verify) and orchestrator clients (sign). Python clients must build
// exactly the same string - see docs/ORCHESTRATOR_AUTH.md.

export const AUTH_HEADERS = {
  passport: 'x-agent-passport',
  timestamp: 'x-agent-timestamp',
  nonce: 'x-agent-nonce',
  signature: 'x-agent-signature',
} as const;

export const SIGNING_VERSION = 'AGW1';

/**
 * Lines joined by "\n": version, METHOD, path (with query), unix timestamp seconds, nonce,
 * lowercase hex SHA-256 of the raw body bytes (empty body hashes the empty string).
 */
export function requestSigningString(
  method: string,
  pathWithQuery: string,
  timestamp: string,
  nonce: string,
  body: Buffer | string,
): string {
  return [SIGNING_VERSION, method.toUpperCase(), pathWithQuery, timestamp, nonce, sha256Hex(body)].join('\n');
}
