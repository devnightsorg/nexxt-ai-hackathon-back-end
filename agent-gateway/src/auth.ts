import { z } from 'zod';
import { b64uDecode, verifyEd25519 } from './crypto.js';
import { verifyPassportSignature, type TrustedIssuers } from './issuer.js';
import type { AgentRegistry } from './registry.js';
import { AUTH_HEADERS, requestSigningString } from './requestSigning.js';
import type { ErrorCode, Passport, Principal } from './types.js';

const passportSchema = z.object({
  agent_id: z.string().min(1).max(64),
  owner_id: z.string().min(1).max(64),
  operator_id: z.string().min(1).max(64),
  public_key: z.string().min(1).max(64),
  issuer: z.string().min(1).max(128),
  issued_at: z.iso.datetime(),
  expires_at: z.iso.datetime(),
  status: z.literal('active'),
  issuer_signature: z.string().min(1).max(256),
});

/** Remembers nonces for a bit longer than the allowed clock skew. Single process only. */
export class NonceCache {
  private readonly seen = new Map<string, number>();

  constructor(private readonly ttlMs: number) {}

  /** Returns false if the nonce was already used. */
  use(nonce: string, nowMs: number): boolean {
    for (const [n, exp] of this.seen) if (exp < nowMs) this.seen.delete(n);
    if (this.seen.has(nonce)) return false;
    this.seen.set(nonce, nowMs + this.ttlMs);
    return true;
  }
}

export interface AuthDeps {
  registry: AgentRegistry;
  trustedIssuers: () => TrustedIssuers;
  nonces: NonceCache;
  clockSkewSec: number;
  now: () => Date;
}

export interface SignedRequest {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  rawBody: Buffer;
}

export type AuthResult =
  | { ok: true; principal: Principal }
  | { ok: false; code: ErrorCode; reason: string; agent_id?: string; owner_id?: string };

function header(req: SignedRequest, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

/** Runs on EVERY MCP HTTP request. Order: passport -> registry binding -> proof of key -> freshness -> status. */
export function authenticateRequest(req: SignedRequest, deps: AuthDeps): AuthResult {
  const passportHeader = header(req, AUTH_HEADERS.passport);
  const timestamp = header(req, AUTH_HEADERS.timestamp);
  const nonce = header(req, AUTH_HEADERS.nonce);
  const signature = header(req, AUTH_HEADERS.signature);
  if (!passportHeader || !timestamp || !nonce || !signature) {
    return { ok: false, code: 'UNAUTHENTICATED', reason: 'missing agent passport or request proof headers' };
  }

  let passport: Passport;
  try {
    const parsed = passportSchema.safeParse(JSON.parse(b64uDecode(passportHeader).toString('utf8')));
    if (!parsed.success) return { ok: false, code: 'INVALID_PASSPORT', reason: 'passport has invalid structure' };
    passport = parsed.data;
  } catch {
    return { ok: false, code: 'INVALID_PASSPORT', reason: 'passport is not valid base64url JSON' };
  }
  const ids = { agent_id: passport.agent_id, owner_id: passport.owner_id };

  const sigError = verifyPassportSignature(passport, deps.trustedIssuers());
  if (sigError) return { ok: false, code: 'INVALID_PASSPORT', reason: sigError, ...ids };

  const now = deps.now();
  if (Date.parse(passport.expires_at) <= now.getTime()) {
    return { ok: false, code: 'INVALID_PASSPORT', reason: 'passport expired', ...ids };
  }

  const agent = deps.registry.get(passport.agent_id);
  if (!agent) return { ok: false, code: 'UNKNOWN_AGENT', reason: 'agent is not in the registry', ...ids };
  if (
    agent.public_key !== passport.public_key ||
    agent.owner_id !== passport.owner_id ||
    agent.operator_id !== passport.operator_id
  ) {
    return { ok: false, code: 'INVALID_PASSPORT', reason: 'passport does not match registry (key/owner/operator)', ...ids };
  }

  // Proof of possession: the caller must hold the private key behind passport.public_key.
  const signingString = requestSigningString(req.method, req.path, timestamp, nonce, req.rawBody);
  if (!verifyEd25519(passport.public_key, signingString, signature)) {
    return { ok: false, code: 'UNAUTHENTICATED', reason: 'request signature does not match passport key', ...ids };
  }

  const ts = Number(timestamp);
  if (!Number.isInteger(ts) || Math.abs(now.getTime() / 1000 - ts) > deps.clockSkewSec) {
    return { ok: false, code: 'UNAUTHENTICATED', reason: `timestamp outside +-${deps.clockSkewSec}s window`, ...ids };
  }
  if (nonce.length < 16 || nonce.length > 128) {
    return { ok: false, code: 'UNAUTHENTICATED', reason: 'nonce must be 16-128 chars', ...ids };
  }
  if (!deps.nonces.use(`${passport.agent_id}:${nonce}`, now.getTime())) {
    return { ok: false, code: 'REPLAY_DETECTED', reason: 'nonce already used - request replay rejected', ...ids };
  }

  if (agent.status === 'revoked') {
    return { ok: false, code: 'AGENT_REVOKED', reason: `agent revoked: ${agent.status_reason ?? 'no reason given'}`, ...ids };
  }
  if (agent.status !== 'active') {
    return { ok: false, code: 'AGENT_NOT_APPROVED', reason: 'agent registration not approved yet', ...ids };
  }

  return {
    ok: true,
    principal: { agent_id: agent.agent_id, owner_id: agent.owner_id, operator_id: agent.operator_id, request_id: nonce },
  };
}
