import { execSync } from 'node:child_process';
import { config } from '../src/config/config';

/**
 * Points every e2e run at the test database, migrated to the latest schema, with rate limits out of the way.
 * Uses the non-destructive `migrate deploy`; suites that need empty tables call resetDb().
 */
export default function globalSetup(): void {
  process.env.DATABASE_URL = config().TEST_DATABASE_URL;
  process.env.THROTTLE_LIMIT = '10000';
  process.env.AGENT_THROTTLE_LIMIT = '10000';
  try {
    execSync('npx prisma migrate deploy', { env: process.env, stdio: 'pipe' });
  } catch (err) {
    const e = err as { stdout?: Buffer; stderr?: Buffer };
    throw new Error(`prisma migrate deploy failed:\n${e.stdout?.toString() ?? ''}${e.stderr?.toString() ?? ''}`);
  }
}
