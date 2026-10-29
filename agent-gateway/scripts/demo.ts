// Demo orchestrator: drives the gateway through real MCP calls (spec section 7) and prints the evidence.
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApp } from '../src/app.js';
import type { AuditEvent } from '../src/audit.js';
import { createSignedFetch, signRequestHeaders, type AgentSigner } from '../src/client/signedFetch.js';
import { loadConfig, loadDotEnv } from '../src/config.js';
import { createContext } from '../src/context.js';
import { generateEd25519, randomToken } from '../src/crypto.js';
import { issuePassport } from '../src/issuer.js';
import { seedDemo } from '../src/seed.js';
import type { Mandate } from '../src/types.js';

loadDotEnv();
const config = loadConfig();
const adminToken = config.adminToken ?? randomToken(24);
const delayMs = Number(process.env.DEMO_DELAY_MS ?? 0);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const eur = (c: number) => `EUR ${(c / 100).toFixed(2)}`;

interface Outcome {
  status: string;
  error_code?: string;
  reason?: string;
  data?: any;
}

let passed = 0;
let failed = 0;
let stepNo = 0;

function step(title: string) {
  stepNo += 1;
  console.log(`\n[${String(stepNo).padStart(2, '0')}] ${title}`);
}

function expect(o: Outcome, want: { status?: string; code?: string }, detail?: string) {
  const ok = (want.status === undefined || o.status === want.status) && (want.code === undefined || o.error_code === want.code);
  if (ok) passed += 1;
  else failed += 1;
  const got = o.error_code ? `${o.status} ${o.error_code}` : o.status;
  const wanted = want.code ? `${want.status ?? 'denied'} ${want.code}` : want.status;
  console.log(`     ${ok ? 'PASS' : 'FAIL'}  expected ${wanted}, got ${got}${o.reason ? ` - ${o.reason}` : ''}`);
  if (detail) console.log(`           ${detail}`);
}

/** Auth failures come back as HTTP 401/403 with our JSON body inside the SDK error message. */
function outcomeFromError(err: unknown): Outcome {
  const msg = err instanceof Error ? err.message : String(err);
  const json = msg.match(/\{.*\}/s);
  if (json) {
    try {
      return JSON.parse(json[0]) as Outcome;
    } catch {
      // fall through
    }
  }
  return { status: 'error', reason: msg };
}

class Agent {
  private client: Client | undefined;
  constructor(
    private readonly baseUrl: string,
    private readonly signer: AgentSigner,
  ) {}

  private async connect(): Promise<Client> {
    if (this.client) return this.client;
    const client = new Client({ name: 'demo-orchestrator', version: '0.1.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', this.baseUrl), { fetch: createSignedFetch(this.signer) }));
    this.client = client;
    return client;
  }

  async listTools(): Promise<string[]> {
    return (await (await this.connect()).listTools()).tools.map((t) => t.name);
  }

  async call(name: string, args: Record<string, unknown> = {}): Promise<Outcome> {
    try {
      const res = await (await this.connect()).callTool({ name, arguments: args });
      const first = (res.content as Array<{ type: string; text?: string }>)[0];
      return JSON.parse(first?.text ?? '{}') as Outcome;
    } catch (err) {
      return outcomeFromError(err);
    }
  }

  async close() {
    await this.client?.close().catch(() => undefined);
  }
}

async function admin<T>(baseUrl: string, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(new URL(`/admin/api${path}`, baseUrl), {
    method,
    headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`admin ${method} ${path}: HTTP ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

async function resolveGateway(): Promise<{ baseUrl: string; stop: () => Promise<void> }> {
  const external = process.env.GATEWAY_URL ?? `http://${config.host}:${config.port}`;
  try {
    const res = await fetch(new URL('/health', external), { signal: AbortSignal.timeout(800) });
    if (res.ok) {
      console.log(`Using running gateway at ${external} (watch ${external}/admin)`);
      return { baseUrl: external, stop: async () => undefined };
    }
  } catch {
    // not running - start one in-process
  }
  const ctx = createContext({ ...config, adminToken });
  const server = createApp(ctx).listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', () => r()));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  console.log(`No gateway running - started an in-process gateway at ${baseUrl}`);
  return { baseUrl, stop: () => new Promise((r) => server.close(() => r())) };
}

async function main() {
  console.log('=== Agent Trust Gateway - live MCP demo (all bank data and deposits are MOCK) ===');
  const seed = seedDemo(config.dataDir);
  console.log(`Seeded fresh demo identities: ${seed.credentials.agent_id} / ${seed.credentials.passport.owner_id}, ${seed.mandate.mandate_id}`);
  const { baseUrl, stop } = await resolveGateway();
  const signer: AgentSigner = { passport: seed.credentials.passport, privateKeyPem: seed.credentials.private_key_pem };
  const agent = new Agent(baseUrl, signer);
  const pause = () => (delayMs ? sleep(delayMs) : Promise.resolve());

  try {
    step('Bank catalog as the bank admin sees it (distribution channels set by the bank)');
    const catalog = await admin<{ offers: Array<{ product_id: string; product_type: string; distribution_channel: string; rate_bps: number; term_months: number }> }>(baseUrl, 'GET', '/offers');
    for (const o of catalog.offers) {
      console.log(`     ${o.distribution_channel.padEnd(12)} ${o.product_id.padEnd(17)} ${o.product_type.padEnd(13)} ${(o.rate_bps / 100).toFixed(2)}%  ${o.term_months ? `${o.term_months}m` : 'flexible'}`);
    }
    await pause();

    step('Authorize: agent-001 connects over MCP with passport + signed request');
    const tools = await agent.listTools();
    console.log(`     tools discovered: ${tools.join(', ')}`);
    expect({ status: tools.length === 3 ? 'ok' : 'error' }, { status: 'ok' });
    await pause();

    step('get_offers - the agent sees only agent_only + both offers');
    const offers = await agent.call('get_offers');
    const seen: Array<{ product_id: string; distribution_channel: string }> = offers.data?.offers ?? [];
    expect(offers, { status: 'ok' }, `${seen.length} offers from ${offers.data?.source}: ${seen.map((o) => `${o.product_id} (${o.distribution_channel})`).join(', ')}`);
    const channelOk = !seen.some((o) => o.product_id === 'td-6m-branch') && seen.some((o) => o.product_id === 'td-3m-agent');
    expect({ status: channelOk ? 'ok' : 'error' }, { status: 'ok' }, 'human-only td-6m-branch hidden, agent-only td-3m-agent visible');
    const injected = seen.find((o) => o.product_id === 'td-promo-x') as { description?: string } | undefined;
    await pause();

    step('Agent guesses the hidden human-only product ID td-6m-branch');
    expect(await agent.call('simulate_deposit', { product_id: 'td-6m-branch', amount_cents: 100_000 }), { code: 'SCOPE_DENIED' });
    expect(await agent.call('execute_deposit_mock', { product_id: 'td-6m-branch', amount_cents: 100_000, idempotency_key: 'demo-exec-human' }), { code: 'SCOPE_DENIED' });
    const afterGuess = (await admin<Mandate[]>(baseUrl, 'GET', '/mandates')).find((x) => x.mandate_id === seed.mandate.mandate_id)!;
    expect({ status: afterGuess.consumed_cents === 0 ? 'ok' : 'error' }, { status: 'ok' }, `limit untouched: used ${eur(afterGuess.consumed_cents)}`);
    await pause();

    step('simulate_deposit agent-only td-3m-agent EUR 1000.00 for 3 months (no limit consumed)');
    const sim = await agent.call('simulate_deposit', { product_id: 'td-3m-agent', amount_cents: 100_000, term_months: 3 });
    expect(sim, { status: 'ok' }, sim.data ? `interest ${eur(sim.data.simulation.expected_interest_cents)}, maturity ${sim.data.simulation.maturity_date}` : undefined);
    console.log('     ... and with an invented 12-month term for this fixed 3-month deposit:');
    expect(await agent.call('simulate_deposit', { product_id: 'td-3m-agent', amount_cents: 100_000, term_months: 12 }), { code: 'INVALID_INPUT' });
    await pause();

    step('execute_deposit_mock agent-only td-3m-agent EUR 1000.00 (within mandate)');
    const ex1 = await agent.call('execute_deposit_mock', { product_id: 'td-3m-agent', amount_cents: 100_000, idempotency_key: 'demo-exec-0001' });
    expect(ex1, { status: 'ok' }, ex1.data ? `deposit ${ex1.data.execution.deposit_id}, remaining aggregate ${eur(ex1.data.mandate.remaining_aggregate_cents)}` : undefined);
    await pause();

    step('Retry with the SAME idempotency key (network retry)');
    const ex1b = await agent.call('execute_deposit_mock', { product_id: 'td-3m-agent', amount_cents: 100_000, idempotency_key: 'demo-exec-0001' });
    expect(ex1b, { status: 'ok' });
    const noDouble = ex1b.data?.idempotent_replay === true && ex1b.data?.mandate?.remaining_aggregate_cents === 400_000;
    expect({ status: noDouble ? 'ok' : 'error' }, { status: 'ok' }, `same deposit ${ex1b.data?.execution?.deposit_id}, remaining still ${eur(ex1b.data?.mandate?.remaining_aggregate_cents ?? 0)} - no double spend`);
    await pause();

    step('Over per-action limit: EUR 2500.00');
    expect(await agent.call('execute_deposit_mock', { product_id: 'td-3m', amount_cents: 250_000, idempotency_key: 'demo-exec-0002' }), { code: 'LIMIT_EXCEEDED' });
    await pause();

    step('Above human-approval threshold: EUR 1800.00');
    expect(await agent.call('execute_deposit_mock', { product_id: 'td-3m', amount_cents: 180_000, idempotency_key: 'demo-exec-0003' }), { code: 'APPROVAL_REQUIRED' });
    await pause();

    step('Forbidden product type: insurance (mandate allows term_deposit only), shared and agent-only');
    expect(await agent.call('execute_deposit_mock', { product_id: 'ins-life', amount_cents: 50_000, idempotency_key: 'demo-exec-0004' }), { code: 'SCOPE_DENIED' });
    expect(await agent.call('execute_deposit_mock', { product_id: 'ins-travel-agent', amount_cents: 5_000, idempotency_key: 'demo-exec-0004b' }), { code: 'SCOPE_DENIED' });
    await pause();

    step('Prompt injection hidden in offer td-promo-x');
    console.log(`     offer text: "${injected?.description}"`);
    console.log('     a naive agent obeys it and tries to move EUR 1,000,000.00 ...');
    expect(await agent.call('execute_deposit_mock', { product_id: 'td-promo-x', amount_cents: 100_000_000, idempotency_key: 'demo-exec-0005' }), { code: 'LIMIT_EXCEEDED' });
    const m = (await admin<Mandate[]>(baseUrl, 'GET', '/mandates')).find((x) => x.mandate_id === seed.mandate.mandate_id)!;
    const unchanged = m.per_action_limit_cents === 200_000 && m.aggregate_limit_cents === 500_000 && m.consumed_cents === 100_000;
    expect({ status: unchanged ? 'ok' : 'error' }, { status: 'ok' }, `mandate unchanged: per-action ${eur(m.per_action_limit_cents)}, aggregate ${eur(m.aggregate_limit_cents)}, used ${eur(m.consumed_cents)}`);
    await pause();

    step('Exhaust aggregate limit: 2 x EUR 1500.00 ok, third EUR 1500.00 denied');
    expect(await agent.call('execute_deposit_mock', { product_id: 'td-3m', amount_cents: 150_000, idempotency_key: 'demo-exec-0006' }), { status: 'ok' });
    expect(await agent.call('execute_deposit_mock', { product_id: 'td-promo-x', amount_cents: 150_000, idempotency_key: 'demo-exec-0007' }), { status: 'ok' });
    expect(await agent.call('execute_deposit_mock', { product_id: 'td-3m', amount_cents: 150_000, idempotency_key: 'demo-exec-0008' }), { code: 'LIMIT_EXCEEDED' });
    await pause();

    step('Expired mandate: customer approves a 2-second mandate, agent calls after it expires');
    await admin(baseUrl, 'POST', '/mandates', { agent_id: 'agent-001', customer_approval: true, expires_in_seconds: 2 });
    await sleep(2500);
    expect(await agent.call('execute_deposit_mock', { product_id: 'td-3m', amount_cents: 50_000, idempotency_key: 'demo-exec-0009' }), { code: 'MANDATE_EXPIRED' });
    const fresh = await admin<Mandate>(baseUrl, 'POST', '/mandates', { agent_id: 'agent-001', customer_approval: true });
    console.log(`     customer approves a new mandate ${fresh.mandate_id}`);
    expect(await agent.call('get_offers'), { status: 'ok' });
    await pause();

    step('Security: unknown agent with a genuine-looking bank passport');
    const strangerKeys = generateEd25519();
    const now = new Date();
    const strangerPassport = issuePassport(
      { agent_id: 'agent-999', owner_id: 'customer-001', operator_id: 'unknown-operator', public_key: strangerKeys.publicKey, issued_at: now.toISOString(), expires_at: new Date(now.getTime() + 3600_000).toISOString() },
      seed.issuer,
    );
    expect(await new Agent(baseUrl, { passport: strangerPassport, privateKeyPem: strangerKeys.privateKeyPem }).call('get_offers'), { code: 'UNKNOWN_AGENT' });

    step('Security: forged passport for agent-001 signed by an attacker key');
    const attackerIssuer = generateEd25519();
    const forged = issuePassport(
      { ...seed.credentials.passport, public_key: strangerKeys.publicKey },
      { issuer_id: seed.issuer.issuer_id, public_key: attackerIssuer.publicKey, private_key_pem: attackerIssuer.privateKeyPem },
    );
    expect(await new Agent(baseUrl, { passport: forged, privateKeyPem: strangerKeys.privateKeyPem }).call('get_offers'), { code: 'INVALID_PASSPORT' });

    step('Security: stolen real passport, request signed with a different key (bad signature)');
    expect(await new Agent(baseUrl, { passport: seed.credentials.passport, privateKeyPem: strangerKeys.privateKeyPem }).call('get_offers'), { code: 'UNAUTHENTICATED' });

    step('Security: missing proof (plain HTTP call without passport headers)');
    const bare = await fetch(new URL('/mcp', baseUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect((await bare.json()) as Outcome, { code: 'UNAUTHENTICATED' });

    step('Security: replay - the same signed request sent twice');
    const url = new URL('/mcp', baseUrl);
    const body = JSON.stringify({ jsonrpc: '2.0', id: 42, method: 'tools/list' });
    const replayHeaders = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...signRequestHeaders(signer, { method: 'POST', url, body }) };
    const first = await fetch(url, { method: 'POST', headers: replayHeaders, body });
    expect({ status: first.ok ? 'ok' : 'error' }, { status: 'ok' }, 'original request accepted');
    const second = await fetch(url, { method: 'POST', headers: replayHeaders, body });
    expect((await second.json()) as Outcome, { code: 'REPLAY_DETECTED' });
    await pause();

    step(`Customer revokes mandate ${fresh.mandate_id} (admin API) -> next agent call`);
    await admin(baseUrl, 'POST', `/mandates/${fresh.mandate_id}/revoke`, { reason: 'customer withdrew consent in banking app' });
    expect(await agent.call('get_offers'), { code: 'NO_ACTIVE_MANDATE' });
    await pause();

    step('Customer revokes agent-001 itself -> next agent call (same MCP client, same keys)');
    await admin(baseUrl, 'POST', '/agents/agent-001/revoke', { reason: 'customer revoked the agent' });
    expect(await agent.call('get_offers'), { code: 'AGENT_REVOKED' });

    step('Agent Channel figures from the audit log (SIMULATED DATA - NOT REAL DEPOSITS / NOT BANK KPIs)');
    const stats = await admin<{ unique_agents_with_executions: number; simulated_deposits_executed: number; simulated_deposit_volume_cents: number; denied_agent_actions: number; denied_by_error_code: Record<string, number> }>(baseUrl, 'GET', '/channel-stats');
    console.log(`     unique agents with executions: ${stats.unique_agents_with_executions}, deposits executed: ${stats.simulated_deposits_executed}, volume: ${eur(stats.simulated_deposit_volume_cents)}`);
    console.log(`     denied agent actions: ${stats.denied_agent_actions} (${Object.entries(stats.denied_by_error_code).map(([k, v]) => `${k} ${v}`).join(', ')})`);
    const statsOk = stats.unique_agents_with_executions === 1 && stats.simulated_deposits_executed === 3 && stats.simulated_deposit_volume_cents === 400_000;
    expect({ status: statsOk ? 'ok' : 'error' }, { status: 'ok' }, '3 executions = EUR 4000.00; replay, simulations and denials not counted');

    step('Audit log (oldest first)');
    const audit = (await admin<AuditEvent[]>(baseUrl, 'GET', '/audit?limit=200')).reverse();
    for (const e of audit) {
      const amount = e.amount_cents != null ? ` ${eur(e.amount_cents)}` : '';
      const who = e.agent_id ?? e.actor ?? '-';
      console.log(
        `     ${e.ts.slice(11, 19)} ${e.result.toUpperCase().padEnd(5)} ${e.event.padEnd(38)} ${who.padEnd(10)} ${(e.mandate_id ?? '').padEnd(12)}` +
          `${(e.error_code ?? '').padEnd(19)} ${e.product_id ?? ''}${amount}${e.reason ? ` | ${e.reason}` : ''}`,
      );
    }
  } finally {
    await agent.close();
    await stop();
  }

  console.log(`\n=== Result: ${passed} checks passed, ${failed} failed ===`);
  console.log('Note: the demo leaves agent-001 revoked. Run "npm run seed" (or the demo again) to reset.');
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error('Demo crashed:', err);
  process.exitCode = 1;
});
