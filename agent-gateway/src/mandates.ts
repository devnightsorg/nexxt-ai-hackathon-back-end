import path from 'node:path';
import { canonicalJson, signEd25519, verifyEd25519 } from './crypto.js';
import type { IssuerKeys } from './issuer.js';
import { JsonFile } from './store.js';
import type { Action, Mandate, ProductType } from './types.js';

export interface MandateRequest {
  agent_id: string;
  owner_id: string;
  allowed_actions: Action[];
  allowed_products: ProductType[];
  per_action_limit_cents: number;
  aggregate_limit_cents: number;
  human_approval_above_cents: number;
  expires_at: string;
  approved_by: string;
}

/** Demo fixture limits - NOT approved bank limits. */
export const DEFAULT_MANDATE_TERMS = {
  allowed_actions: ['get_offers', 'simulate_deposit', 'execute_deposit_mock'] as Action[],
  allowed_products: ['term_deposit'] as ProductType[],
  per_action_limit_cents: 200_000,
  aggregate_limit_cents: 500_000,
  human_approval_above_cents: 150_000,
};

// Fields that are immutable after issuance and covered by the bank signature.
type SignedPart = Omit<Mandate, 'bank_signature' | 'status' | 'consumed_cents' | 'status_changed_at' | 'status_reason'>;

function signedPart(m: Mandate): SignedPart {
  const { bank_signature, status, consumed_cents, status_changed_at, status_reason, ...rest } = m;
  return rest;
}

export function verifyMandateSignature(m: Mandate, issuerPublicKey: string): boolean {
  return verifyEd25519(issuerPublicKey, canonicalJson(signedPart(m)), m.bank_signature);
}

interface IdempotencyRecord {
  fingerprint: string;
  mandate_id: string;
  result: unknown;
  created_at: string;
}

export class MandateStore {
  private readonly mandates: JsonFile<Record<string, Mandate>>;
  private readonly executions: JsonFile<Record<string, IdempotencyRecord>>;

  constructor(dataDir: string) {
    this.mandates = new JsonFile(path.join(dataDir, 'mandates.json'), () => ({}));
    this.executions = new JsonFile(path.join(dataDir, 'executions.json'), () => ({}));
  }

  list(): Mandate[] {
    return Object.values(this.mandates.read()).sort((a, b) => a.issued_at.localeCompare(b.issued_at));
  }

  get(id: string): Mandate | undefined {
    return this.mandates.read()[id];
  }

  /** The agent's most recent non-superseded mandate (may be revoked or expired - policy decides). */
  currentFor(agentId: string): Mandate | undefined {
    return this.list()
      .filter((m) => m.agent_id === agentId && m.status !== 'superseded')
      .at(-1);
  }

  /** Called only by the bank/admin side after (simulated) explicit customer approval. */
  issue(req: MandateRequest, issuer: IssuerKeys, now: Date): Mandate {
    let created: Mandate | undefined;
    this.mandates.update((all) => {
      const ts = now.toISOString();
      for (const m of Object.values(all)) {
        if (m.agent_id === req.agent_id && m.status === 'active') {
          m.status = 'superseded';
          m.status_changed_at = ts;
          m.status_reason = 'replaced by a newer mandate';
        }
      }
      const unsigned: SignedPart = {
        mandate_id: `mandate-${String(Object.keys(all).length + 1).padStart(3, '0')}`,
        agent_id: req.agent_id,
        owner_id: req.owner_id,
        allowed_actions: req.allowed_actions,
        allowed_products: req.allowed_products,
        currency: 'EUR',
        per_action_limit_cents: req.per_action_limit_cents,
        aggregate_limit_cents: req.aggregate_limit_cents,
        human_approval_above_cents: req.human_approval_above_cents,
        issued_at: ts,
        expires_at: req.expires_at,
        customer_approval: { approved_by: req.approved_by, approved_at: ts, method: 'simulated' },
      };
      created = {
        ...unsigned,
        bank_signature: signEd25519(issuer.private_key_pem, canonicalJson(unsigned)),
        status: 'active',
        consumed_cents: 0,
      };
      all[created.mandate_id] = created;
    });
    return created!;
  }

  revoke(id: string, reason: string, now: Date): Mandate {
    let updated: Mandate | undefined;
    this.mandates.update((all) => {
      const m = all[id];
      if (!m) throw new Error(`mandate ${id} not found`);
      m.status = 'revoked';
      m.status_changed_at = now.toISOString();
      m.status_reason = reason;
      updated = m;
    });
    return updated!;
  }

  /** Must be called inside the gateway execution lock. */
  consume(id: string, amountCents: number): Mandate {
    let updated: Mandate | undefined;
    this.mandates.update((all) => {
      const m = all[id];
      if (!m) throw new Error(`mandate ${id} not found`);
      m.consumed_cents += amountCents;
      updated = m;
    });
    return updated!;
  }

  getExecution(key: string): IdempotencyRecord | undefined {
    return this.executions.read()[key];
  }

  saveExecution(key: string, record: IdempotencyRecord): void {
    this.executions.update((all) => {
      all[key] = record;
    });
  }
}
