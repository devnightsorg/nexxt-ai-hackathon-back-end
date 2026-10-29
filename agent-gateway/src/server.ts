import fs from 'node:fs';
import path from 'node:path';
import { createApp } from './app.js';
import { loadConfig, loadDotEnv } from './config.js';
import { createContext } from './context.js';

loadDotEnv();
const config = loadConfig();

if (!fs.existsSync(path.join(config.dataDir, 'issuer.json'))) {
  console.error(`No demo data in ${config.dataDir}. Run "npm run seed" first.`);
  process.exit(1);
}
if (!config.adminToken) console.warn('ADMIN_TOKEN is not set - admin API is disabled.');

const ctx = createContext(config, { echoAudit: true });
const app = createApp(ctx);

app.listen(config.port, config.host, () => {
  const base = `http://${config.host === '::1' ? '[::1]' : config.host}:${config.port}`;
  console.log(`Agent Trust Gateway listening on ${base}`);
  console.log(`  MCP endpoint : ${base}/mcp (Streamable HTTP, signed requests only)`);
  console.log(`  Admin page   : ${base}/admin`);
  console.log(`  Bank adapter : ${ctx.bank.kind}${ctx.bank.kind === 'mock' ? ' (MOCK - simulated data)' : ` -> ${config.bankAgentUrl}`}`);
});
