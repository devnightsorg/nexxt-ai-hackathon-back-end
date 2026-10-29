import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Config } from '../src/config.js';
import { createContext } from '../src/context.js';
import { seedDemo } from '../src/seed.js';
import type { Principal } from '../src/types.js';

export const ADMIN_TOKEN = 'test-admin-token';

/** Fresh seeded data dir + context with a controllable clock. */
export function makeEnv(start = new Date('2026-10-28T10:00:00Z'), opts: { realClock?: boolean } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agw-test-'));
  const clock = { t: start };
  const now = opts.realClock ? () => new Date() : () => clock.t;
  const seed = seedDemo(dataDir, now());
  const config: Config = {
    host: '127.0.0.1',
    port: 0,
    dataDir,
    adminToken: ADMIN_TOKEN,
    bankAdapter: 'mock',
    bankAgentUrl: undefined,
    clockSkewSec: 60,
  };
  const ctx = createContext(config, { now });
  const principal: Principal = { agent_id: 'agent-001', owner_id: 'customer-001', operator_id: 'demo-orchestrator', request_id: 'test-req' };
  return { dataDir, clock, seed, ctx, principal };
}
