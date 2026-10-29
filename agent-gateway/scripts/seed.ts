import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, loadDotEnv } from '../src/config.js';
import { randomToken } from '../src/crypto.js';
import { seedDemo } from '../src/seed.js';

const envFile = path.resolve(process.cwd(), '.env');
if (!fs.existsSync(envFile)) {
  const example = fs.readFileSync(path.resolve(process.cwd(), '.env.example'), 'utf8');
  fs.writeFileSync(envFile, example.replace(/^ADMIN_TOKEN=.*$/m, `ADMIN_TOKEN=${randomToken(24)}`), { mode: 0o600 });
  console.log('Created .env with a random ADMIN_TOKEN (open .env to copy it into the admin page).');
}
loadDotEnv(envFile);

const config = loadConfig();
const result = seedDemo(config.dataDir);

console.log(`Demo data reset in ${config.dataDir}`);
console.log(`  issuer        : ${result.issuer.issuer_id}`);
console.log(`  agent         : ${result.credentials.agent_id} (owner ${result.credentials.passport.owner_id}, operator ${result.credentials.passport.operator_id})`);
console.log(`  passport until: ${result.credentials.passport.expires_at}`);
console.log(`  mandate       : ${result.mandate.mandate_id} products=${result.mandate.allowed_products.join(',')} ` +
  `per_action=EUR ${result.mandate.per_action_limit_cents / 100} aggregate=EUR ${result.mandate.aggregate_limit_cents / 100} ` +
  `approval_above=EUR ${result.mandate.human_approval_above_cents / 100}`);
console.log(`  agent credentials (orchestrator side, keep secret): ${path.relative(process.cwd(), result.credentialsFile)}`);
