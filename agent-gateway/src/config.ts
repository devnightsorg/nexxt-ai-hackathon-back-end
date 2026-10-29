import path from 'node:path';

export interface Config {
  host: string;
  port: number;
  dataDir: string;
  adminToken: string | undefined;
  bankAdapter: 'mock' | 'http';
  bankAgentUrl: string | undefined;
  clockSkewSec: number;
}

/** Loads agent-gateway/.env if present (Node 20.12+). Values never get printed. */
export function loadDotEnv(file = path.resolve(process.cwd(), '.env')): void {
  try {
    process.loadEnvFile(file);
  } catch {
    // no .env file - rely on real environment variables
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // Empty values in .env count as "not set".
  const bankAdapter = (env.BANK_ADAPTER || 'mock').toLowerCase();
  if (bankAdapter !== 'mock' && bankAdapter !== 'http') {
    throw new Error(`BANK_ADAPTER must be "mock" or "http", got "${bankAdapter}"`);
  }
  if (bankAdapter === 'http' && !env.BANK_AGENT_URL) {
    throw new Error('BANK_ADAPTER=http requires BANK_AGENT_URL');
  }
  return {
    host: env.HOST || '127.0.0.1',
    port: Number(env.PORT || 3100),
    dataDir: path.resolve(env.DATA_DIR || path.join(process.cwd(), '.data')),
    adminToken: env.ADMIN_TOKEN || undefined,
    bankAdapter,
    bankAgentUrl: env.BANK_AGENT_URL || undefined,
    clockSkewSec: Number(env.CLOCK_SKEW_SEC || 60),
  };
}
