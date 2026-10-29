import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createSignedFetch } from '../src/client/signedFetch.js';
import { ADMIN_TOKEN, makeEnv } from './helpers.js';

const env = makeEnv(new Date(), { realClock: true });
let server: Server;
let base: string;

beforeAll(async () => {
  server = createApp(env.ctx).listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

async function connect() {
  const client = new Client({ name: 'test-orchestrator', version: '0.0.1' });
  const signer = { passport: env.seed.credentials.passport, privateKeyPem: env.seed.credentials.private_key_pem };
  await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', base), { fetch: createSignedFetch(signer) }));
  return client;
}

const parse = (res: any) => JSON.parse(res.content[0].text);

describe('MCP over Streamable HTTP (smoke)', () => {
  it('discovers tools and calls them with signed requests', async () => {
    const client = await connect();
    const tools = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(tools).toEqual(['execute_deposit_mock', 'get_offers', 'simulate_deposit']);
    // Tool schemas expose no identity arguments.
    const exec = (await client.listTools()).tools.find((t) => t.name === 'execute_deposit_mock')!;
    expect(Object.keys(exec.inputSchema.properties ?? {}).sort()).toEqual(['amount_cents', 'idempotency_key', 'product_id']);

    const offers = parse(await client.callTool({ name: 'get_offers', arguments: {} }));
    expect(offers.status).toBe('ok');
    const ids = offers.data.offers.map((o: any) => o.product_id);
    expect(ids).toContain('td-3m-agent');
    expect(ids).not.toContain('td-6m-branch');
    const hidden = parse(await client.callTool({ name: 'execute_deposit_mock', arguments: { product_id: 'td-6m-branch', amount_cents: 100_000, idempotency_key: 'mcp-test-human' } }));
    expect(hidden).toMatchObject({ status: 'denied', error_code: 'SCOPE_DENIED' });
    const r = parse(await client.callTool({ name: 'execute_deposit_mock', arguments: { product_id: 'td-3m', amount_cents: 100_000, idempotency_key: 'mcp-test-0001', owner_id: 'customer-999' } }));
    expect(r.status).toBe('ok');
    // smuggled owner_id is ignored - mandate of the authenticated owner was used
    expect(r.data.mandate.mandate_id).toBe('mandate-001');
    await client.close();
  });

  it('rejects unsigned MCP requests', async () => {
    const client = new Client({ name: 'anon', version: '0.0.1' });
    await expect(client.connect(new StreamableHTTPClientTransport(new URL('/mcp', base)))).rejects.toThrow(/UNAUTHENTICATED/);
  });

  it('admin revoke takes effect on the next call of an open client', async () => {
    const client = await connect();
    expect(parse(await client.callTool({ name: 'get_offers', arguments: {} })).status).toBe('ok');

    const unauth = await fetch(`${base}/admin/api/agents/agent-001/revoke`, { method: 'POST' });
    expect(unauth.status).toBe(401);

    const res = await fetch(`${base}/admin/api/mandates/mandate-001/revoke`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ADMIN_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'test revoke' }),
    });
    expect(res.status).toBe(200);
    const denied = parse(await client.callTool({ name: 'get_offers', arguments: {} }));
    expect(denied).toMatchObject({ status: 'denied', error_code: 'NO_ACTIVE_MANDATE' });

    await fetch(`${base}/admin/api/agents/agent-001/revoke`, { method: 'POST', headers: { authorization: `Bearer ${ADMIN_TOKEN}` } });
    await expect(client.callTool({ name: 'get_offers', arguments: {} })).rejects.toThrow(/AGENT_REVOKED/);
    await client.close();
  });
});
