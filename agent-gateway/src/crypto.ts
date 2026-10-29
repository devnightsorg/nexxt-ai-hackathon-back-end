import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  verify,
  type KeyObject,
} from 'node:crypto';

// All signatures are Ed25519 via node:crypto. Public keys travel as raw 32-byte keys in base64url
// (the JWK "x" value), private keys as PKCS#8 PEM. No custom algorithms.

export function b64uEncode(data: Buffer | string): string {
  return Buffer.from(data).toString('base64url');
}

export function b64uDecode(s: string): Buffer {
  return Buffer.from(s, 'base64url');
}

export function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

export function randomToken(bytes = 16): string {
  return randomBytes(bytes).toString('base64url');
}

/** Deterministic JSON: object keys sorted recursively, undefined values dropped. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = sortDeep(v);
    }
    return out;
  }
  return value;
}

export interface Ed25519KeyPair {
  publicKey: string;
  privateKeyPem: string;
}

export function generateEd25519(): Ed25519KeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const jwk = publicKey.export({ format: 'jwk' });
  return {
    publicKey: jwk.x as string,
    privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
  };
}

function publicKeyFromRaw(raw: string): KeyObject {
  if (b64uDecode(raw).length !== 32) throw new Error('Ed25519 public key must be 32 bytes');
  return createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: raw }, format: 'jwk' });
}

export function signEd25519(privateKeyPem: string, data: string | Buffer): string {
  return b64uEncode(sign(null, Buffer.from(data), createPrivateKey(privateKeyPem)));
}

export function verifyEd25519(publicKeyRaw: string, data: string | Buffer, signature: string): boolean {
  try {
    return verify(null, Buffer.from(data), publicKeyFromRaw(publicKeyRaw), b64uDecode(signature));
  } catch {
    return false;
  }
}
