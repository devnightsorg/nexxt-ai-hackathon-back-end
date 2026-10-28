import { AuditLog } from './audit.js';
import { NonceCache } from './auth.js';
import { HttpBankAdapter } from './bank/http.js';
import { MockBankAdapter } from './bank/mock.js';
import type { BankAdapter } from './bank/types.js';
import type { Config } from './config.js';
import { Gateway } from './gateway.js';
import { IssuerStore } from './issuer.js';
import { MandateStore } from './mandates.js';
import { AgentRegistry } from './registry.js';

export interface AppContext {
  config: Config;
  registry: AgentRegistry;
  mandates: MandateStore;
  issuer: IssuerStore;
  audit: AuditLog;
  bank: BankAdapter;
  gateway: Gateway;
  nonces: NonceCache;
  now: () => Date;
}

export function createContext(config: Config, opts: { now?: () => Date; echoAudit?: boolean; bank?: BankAdapter } = {}): AppContext {
  const now = opts.now ?? (() => new Date());
  const registry = new AgentRegistry(config.dataDir);
  const mandates = new MandateStore(config.dataDir);
  const issuer = new IssuerStore(config.dataDir);
  const audit = new AuditLog(config.dataDir, now, opts.echoAudit ?? false);
  const bank =
    opts.bank ??
    (config.bankAdapter === 'http' ? new HttpBankAdapter(config.bankAgentUrl!) : new MockBankAdapter(now));
  const gateway = new Gateway({ mandates, issuer, bank, audit, now });
  const nonces = new NonceCache((config.clockSkewSec * 2 + 10) * 1000);
  return { config, registry, mandates, issuer, audit, bank, gateway, nonces, now };
}
