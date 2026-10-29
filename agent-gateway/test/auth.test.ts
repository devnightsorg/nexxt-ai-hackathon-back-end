import { describe, expect, it } from 'vitest';
import { authenticateRequest, NonceCache, type AuthDeps, type SignedRequest } from '../src/auth.js';
import { signRequestHeaders, type AgentSigner } from '../src/client/signedFetch.js';
import { generateEd25519 } from '../src/crypto.js';
import { issuePassport } from '../src/issuer.js';
import { makeEnv } from './helpers.js';

function setup() {
  const env = makeEnv();
  const deps: AuthDeps = {
    registry: env.ctx.registry,
    trustedIssuers: () => env.ctx.issuer.trustedIssuers(),
    nonces: new NonceCache(130_000),
    clockSkewSec: 60,
    now: () => env.clock.t,
  };
  const signer: AgentSigner = { passport: env.seed.credentials.passport, privateKeyPem: env.seed.credentials.private_key_pem };
  const nowSec = () => Math.floor(env.clock.t.getTime() / 1000);
  const build = (s: AgentSigner = signer, opts: { body?: string; nowSec?: number; nonce?: string } = {}): SignedRequest => {
    const body = opts.body ?? '{"jsonrpc":"2.0","id":1,"method":"tools/list"}';
    const headers = signRequestHeaders(s, { method: 'POST', url: 'http://127.0.0.1:3100/mcp', body, nowSec: opts.nowSec ?? nowSec(), nonce: opts.nonce });
    return { method: 'POST', path: '/mcp', headers, rawBody: Buffer.from(body) };
  };
  return { ...env, deps, signer, build, nowSec };
}

describe('authenticateRequest', () => {
  it('accepts a valid signed request and derives identity from the registry', () => {
    const { deps, build } = setup();
    const r = authenticateRequest(build(), deps);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.principal).toMatchObject({ agent_id: 'agent-001', owner_id: 'customer-001' });
  });

  it('missing proof -> UNAUTHENTICATED', () => {
    const { deps } = setup();
    const r = authenticateRequest({ method: 'POST', path: '/mcp', headers: {}, rawBody: Buffer.alloc(0) }, deps);
    expect(r).toMatchObject({ ok: false, code: 'UNAUTHENTICATED' });
  });

  it('replayed request -> REPLAY_DETECTED', () => {
    const { deps, build } = setup();
    const req = build();
    expect(authenticateRequest(req, deps).ok).toBe(true);
    expect(authenticateRequest(req, deps)).toMatchObject({ ok: false, code: 'REPLAY_DETECTED' });
  });

  it('body tampered after signing -> UNAUTHENTICATED', () => {
    const { deps, build } = setup();
    const req = build();
    req.rawBody = Buffer.from('{"jsonrpc":"2.0","id":1,"method":"tools/call"}');
    expect(authenticateRequest(req, deps)).toMatchObject({ ok: false, code: 'UNAUTHENTICATED' });
  });

  it('stolen passport signed with another key -> UNAUTHENTICATED', () => {
    const { deps, build, signer } = setup();
    const r = authenticateRequest(build({ ...signer, privateKeyPem: generateEd25519().privateKeyPem }), deps);
    expect(r).toMatchObject({ ok: false, code: 'UNAUTHENTICATED' });
  });

  it('stale timestamp -> UNAUTHENTICATED', () => {
    const { deps, build, nowSec } = setup();
    expect(authenticateRequest(build(undefined, { nowSec: nowSec() - 120 }), deps)).toMatchObject({ ok: false, code: 'UNAUTHENTICATED' });
  });

  it('forged passport -> INVALID_PASSPORT', () => {
    const { deps, build, seed } = setup();
    const attacker = generateEd25519();
    const forged = issuePassport(
      { ...seed.credentials.passport, public_key: attacker.publicKey },
      { issuer_id: seed.issuer.issuer_id, public_key: attacker.publicKey, private_key_pem: attacker.privateKeyPem },
    );
    expect(authenticateRequest(build({ passport: forged, privateKeyPem: attacker.privateKeyPem }), deps)).toMatchObject({ ok: false, code: 'INVALID_PASSPORT' });
  });

  it('expired passport -> INVALID_PASSPORT', () => {
    const { deps, build, clock } = setup();
    clock.t = new Date(clock.t.getTime() + 31 * 24 * 3600 * 1000);
    expect(authenticateRequest(build(), deps)).toMatchObject({ ok: false, code: 'INVALID_PASSPORT', reason: 'passport expired' });
  });

  it('unknown agent -> UNKNOWN_AGENT', () => {
    const { deps, build, seed, clock } = setup();
    const k = generateEd25519();
    const p = issuePassport(
      { agent_id: 'agent-999', owner_id: 'customer-001', operator_id: 'x', public_key: k.publicKey, issued_at: clock.t.toISOString(), expires_at: new Date(clock.t.getTime() + 3600_000).toISOString() },
      seed.issuer,
    );
    expect(authenticateRequest(build({ passport: p, privateKeyPem: k.privateKeyPem }), deps)).toMatchObject({ ok: false, code: 'UNKNOWN_AGENT' });
  });

  it('genuine passport for another owner does not match registry -> INVALID_PASSPORT', () => {
    const { deps, build, seed, signer } = setup();
    const p = issuePassport({ ...seed.credentials.passport, owner_id: 'customer-002' }, seed.issuer);
    expect(authenticateRequest(build({ ...signer, passport: p }), deps)).toMatchObject({ ok: false, code: 'INVALID_PASSPORT' });
  });

  it('revoked agent -> AGENT_REVOKED on the very next request', () => {
    const { deps, build, ctx, clock } = setup();
    expect(authenticateRequest(build(), deps).ok).toBe(true);
    ctx.registry.setStatus('agent-001', 'revoked', 'test', clock.t);
    expect(authenticateRequest(build(), deps)).toMatchObject({ ok: false, code: 'AGENT_REVOKED' });
  });
});
