import path from 'node:path';
import { canonicalJson, signEd25519, verifyEd25519 } from './crypto.js';
import { JsonFile } from './store.js';
import type { Passport } from './types.js';

export const DEMO_ISSUER_ID = 'demo-bank-agent-registry';

/** Demo bank key: signs passports and mandates. Private key stays in .data/ (gitignored). */
export interface IssuerKeys {
  issuer_id: string;
  public_key: string;
  private_key_pem: string;
}

export type TrustedIssuers = Record<string, string>;

export class IssuerStore {
  private readonly keys: JsonFile<IssuerKeys | null>;
  private readonly trusted: JsonFile<TrustedIssuers>;

  constructor(dataDir: string) {
    this.keys = new JsonFile(path.join(dataDir, 'issuer.json'), () => null);
    this.trusted = new JsonFile(path.join(dataDir, 'trusted_issuers.json'), () => ({}));
  }

  getKeys(): IssuerKeys {
    const keys = this.keys.read();
    if (!keys) throw new Error('Issuer keys missing - run "npm run seed" first');
    return keys;
  }

  setKeys(keys: IssuerKeys): void {
    this.keys.write(keys);
    this.trusted.write({ [keys.issuer_id]: keys.public_key });
  }

  trustedIssuers(): TrustedIssuers {
    return this.trusted.read();
  }
}

export function issuePassport(
  fields: Omit<Passport, 'issuer' | 'issuer_signature' | 'status'>,
  issuer: IssuerKeys,
): Passport {
  const unsigned = { ...fields, issuer: issuer.issuer_id, status: 'active' as const };
  return { ...unsigned, issuer_signature: signEd25519(issuer.private_key_pem, canonicalJson(unsigned)) };
}

export function verifyPassportSignature(passport: Passport, trusted: TrustedIssuers): string | null {
  const issuerKey = trusted[passport.issuer];
  if (!issuerKey) return `issuer "${passport.issuer}" is not trusted`;
  const { issuer_signature, ...unsigned } = passport;
  if (!verifyEd25519(issuerKey, canonicalJson(unsigned), issuer_signature)) {
    return 'issuer signature invalid';
  }
  return null;
}

export function encodePassportHeader(passport: Passport): string {
  return Buffer.from(JSON.stringify(passport)).toString('base64url');
}
