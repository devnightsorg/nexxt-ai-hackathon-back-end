import fs from 'node:fs';
import path from 'node:path';
import { AuditLog } from './audit.js';
import { generateEd25519 } from './crypto.js';
import { DEMO_ISSUER_ID, IssuerStore, issuePassport, type IssuerKeys } from './issuer.js';
import { DEFAULT_MANDATE_TERMS, MandateStore } from './mandates.js';
import { AgentRegistry } from './registry.js';
import { writeFileAtomic } from './store.js';
import type { Mandate, Passport } from './types.js';

export const DEMO_IDS = { agent: 'agent-001', owner: 'customer-001', operator: 'demo-orchestrator' } as const;

/** What the orchestrator holds: its passport and its own private key. Lives in .data/, never in git. */
export interface AgentCredentials {
  agent_id: string;
  passport: Passport;
  private_key_pem: string;
}

export interface SeedResult {
  issuer: IssuerKeys;
  credentials: AgentCredentials;
  mandate: Mandate;
  credentialsFile: string;
}

const STATE_FILES = ['agents.json', 'mandates.json', 'executions.json', 'audit.jsonl', 'issuer.json', 'trusted_issuers.json'];

export function credentialsPath(dataDir: string, agentId: string = DEMO_IDS.agent): string {
  return path.join(dataDir, `${agentId}.credentials.json`);
}

export function loadCredentials(dataDir: string, agentId: string = DEMO_IDS.agent): AgentCredentials {
  return JSON.parse(fs.readFileSync(credentialsPath(dataDir, agentId), 'utf8')) as AgentCredentials;
}

/** Resets .data/ to a fresh deterministic demo state with newly generated keys. */
export function seedDemo(dataDir: string, now: Date = new Date()): SeedResult {
  fs.mkdirSync(dataDir, { recursive: true });
  for (const f of STATE_FILES) fs.rmSync(path.join(dataDir, f), { force: true });

  const issuerStore = new IssuerStore(dataDir);
  const issuerPair = generateEd25519();
  const issuer: IssuerKeys = { issuer_id: DEMO_ISSUER_ID, public_key: issuerPair.publicKey, private_key_pem: issuerPair.privateKeyPem };
  issuerStore.setKeys(issuer);

  const audit = new AuditLog(dataDir, () => now);
  const agentPair = generateEd25519();
  const passport = issuePassport(
    {
      agent_id: DEMO_IDS.agent,
      owner_id: DEMO_IDS.owner,
      operator_id: DEMO_IDS.operator,
      public_key: agentPair.publicKey,
      issued_at: now.toISOString(),
      expires_at: new Date(now.getTime() + 30 * 24 * 3600 * 1000).toISOString(),
    },
    issuer,
  );
  audit.record({ event: 'passport.issued', result: 'info', actor: DEMO_ISSUER_ID, agent_id: DEMO_IDS.agent, owner_id: DEMO_IDS.owner, reason: `expires ${passport.expires_at}` });

  new AgentRegistry(dataDir).register(
    { agent_id: DEMO_IDS.agent, owner_id: DEMO_IDS.owner, operator_id: DEMO_IDS.operator, public_key: agentPair.publicKey, status: 'active', status_reason: 'seeded and approved for demo' },
    now,
  );
  audit.record({ event: 'agent.registered', result: 'info', actor: 'seed', agent_id: DEMO_IDS.agent, owner_id: DEMO_IDS.owner, reason: 'status active' });

  const mandate = new MandateStore(dataDir).issue(
    {
      agent_id: DEMO_IDS.agent,
      owner_id: DEMO_IDS.owner,
      ...DEFAULT_MANDATE_TERMS,
      expires_at: new Date(now.getTime() + 7 * 24 * 3600 * 1000).toISOString(),
      approved_by: DEMO_IDS.owner,
    },
    issuer,
    now,
  );
  audit.record({
    event: 'mandate.issued',
    result: 'info',
    actor: `${DEMO_IDS.owner} (simulated customer approval)`,
    agent_id: DEMO_IDS.agent,
    owner_id: DEMO_IDS.owner,
    mandate_id: mandate.mandate_id,
    reason: `products=${mandate.allowed_products.join(',')} per_action=${mandate.per_action_limit_cents} aggregate=${mandate.aggregate_limit_cents}`,
  });

  const credentials: AgentCredentials = { agent_id: DEMO_IDS.agent, passport, private_key_pem: agentPair.privateKeyPem };
  const credentialsFile = credentialsPath(dataDir);
  writeFileAtomic(credentialsFile, JSON.stringify(credentials, null, 2));

  return { issuer, credentials, mandate, credentialsFile };
}
