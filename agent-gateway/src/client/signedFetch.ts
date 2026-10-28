import { randomToken, signEd25519 } from '../crypto.js';
import { encodePassportHeader } from '../issuer.js';
import { AUTH_HEADERS, requestSigningString } from '../requestSigning.js';
import type { Passport } from '../types.js';

export interface AgentSigner {
  passport: Passport;
  privateKeyPem: string;
}

export interface SignedHeadersInput {
  method: string;
  url: string | URL;
  body: string;
  nowSec?: number;
  nonce?: string;
}

/** Builds the four auth headers for one HTTP request. */
export function signRequestHeaders(signer: AgentSigner, input: SignedHeadersInput): Record<string, string> {
  const url = new URL(input.url);
  const timestamp = String(input.nowSec ?? Math.floor(Date.now() / 1000));
  const nonce = input.nonce ?? randomToken(18);
  const signingString = requestSigningString(input.method, url.pathname + url.search, timestamp, nonce, input.body);
  return {
    [AUTH_HEADERS.passport]: encodePassportHeader(signer.passport),
    [AUTH_HEADERS.timestamp]: timestamp,
    [AUTH_HEADERS.nonce]: nonce,
    [AUTH_HEADERS.signature]: signEd25519(signer.privateKeyPem, signingString),
  };
}

/**
 * fetch replacement for the MCP SDK client transport
 * (`new StreamableHTTPClientTransport(url, { fetch: createSignedFetch(signer) })`).
 * Every request gets a fresh timestamp, nonce and signature.
 */
export function createSignedFetch(signer: AgentSigner, baseFetch: typeof fetch = fetch) {
  return async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = init?.body;
    if (body != null && typeof body !== 'string') {
      throw new Error('signedFetch only supports string bodies (the MCP SDK sends JSON strings)');
    }
    const headers = new Headers(init?.headers);
    for (const [k, v] of Object.entries(signRequestHeaders(signer, { method, url, body: body ?? '' }))) headers.set(k, v);
    return baseFetch(url, { ...init, headers });
  };
}
