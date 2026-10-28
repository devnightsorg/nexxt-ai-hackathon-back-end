import { describe, expect, it } from 'vitest';
import { canonicalJson, generateEd25519, signEd25519, verifyEd25519 } from '../src/crypto.js';
import { issuePassport, verifyPassportSignature } from '../src/issuer.js';
import { verifyMandateSignature } from '../src/mandates.js';
import { makeEnv } from './helpers.js';

describe('crypto', () => {
  it('canonical JSON sorts keys recursively', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [{ z: 1, y: 2 }] } })).toBe('{"a":{"c":[{"y":2,"z":1}],"d":2},"b":1}');
  });

  it('Ed25519 sign/verify, tampering fails', () => {
    const k = generateEd25519();
    const sig = signEd25519(k.privateKeyPem, 'hello');
    expect(verifyEd25519(k.publicKey, 'hello', sig)).toBe(true);
    expect(verifyEd25519(k.publicKey, 'hellO', sig)).toBe(false);
    expect(verifyEd25519(generateEd25519().publicKey, 'hello', sig)).toBe(false);
    expect(verifyEd25519('not-a-key', 'hello', sig)).toBe(false);
  });
});

describe('passport', () => {
  const { seed } = makeEnv();
  const trusted = { [seed.issuer.issuer_id]: seed.issuer.public_key };

  it('valid passport verifies', () => {
    expect(verifyPassportSignature(seed.credentials.passport, trusted)).toBeNull();
  });

  it('any changed field breaks the issuer signature', () => {
    expect(verifyPassportSignature({ ...seed.credentials.passport, owner_id: 'customer-999' }, trusted)).toMatch(/signature invalid/);
    expect(verifyPassportSignature({ ...seed.credentials.passport, expires_at: '2099-01-01T00:00:00.000Z' }, trusted)).toMatch(/signature invalid/);
  });

  it('passport from an untrusted issuer is rejected', () => {
    const rogue = generateEd25519();
    const p = issuePassport(
      { ...seed.credentials.passport },
      { issuer_id: 'rogue-issuer', public_key: rogue.publicKey, private_key_pem: rogue.privateKeyPem },
    );
    expect(verifyPassportSignature(p, trusted)).toMatch(/not trusted/);
  });

  it('mandate bank signature covers limits', () => {
    expect(verifyMandateSignature(seed.mandate, seed.issuer.public_key)).toBe(true);
    expect(verifyMandateSignature({ ...seed.mandate, aggregate_limit_cents: 100_000_000 }, seed.issuer.public_key)).toBe(false);
    // mutable state is not signed
    expect(verifyMandateSignature({ ...seed.mandate, consumed_cents: 123 }, seed.issuer.public_key)).toBe(true);
  });
});
