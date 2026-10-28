import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { AuditEvent } from '../src/audit.js';
import { HttpBankAdapter } from '../src/bank/http.js';
import { MockBankAdapter } from '../src/bank/mock.js';
import type { BankAdapter } from '../src/bank/types.js';
import { computeChannelStats } from '../src/channelStats.js';
import { createContext } from '../src/context.js';
import { ADMIN_TOKEN, makeEnv } from './helpers.js';

const exec = (product_id: string, amount_cents: number, idempotency_key: string) => ({ product_id, amount_cents, idempotency_key });

function countingMock() {
  const mock = new MockBankAdapter();
  const calls = { execute: 0 };
  const bank: BankAdapter = {
    kind: 'mock',
    listOffers: () => mock.listOffers(),
    simulateDeposit: (r) => mock.simulateDeposit(r),
    executeDeposit: (r) => {
      calls.execute += 1;
      return mock.executeDeposit(r);
    },
  };
  return { bank, calls };
}

describe('distribution channels (P0)', () => {
  it('get_offers returns agent_only + both, never human_only', async () => {
    const { ctx, principal } = makeEnv();
    const res = await ctx.gateway.getOffers(principal);
    const offers = (res.data as any).offers as Array<{ product_id: string; distribution_channel: string; allowed_by_mandate: boolean }>;
    const channels = new Set(offers.map((o) => o.distribution_channel));
    expect([...channels].sort()).toEqual(['agent_only', 'both']);
    expect(offers.map((o) => o.product_id)).not.toContain('td-6m-branch');
    expect(offers.find((o) => o.product_id === 'td-3m-agent')).toMatchObject({ distribution_channel: 'agent_only', allowed_by_mandate: true });
    expect(offers.find((o) => o.product_id === 'ins-travel-agent')).toMatchObject({ allowed_by_mandate: false });
  });

  it('guessed human_only ID: simulate and execute -> SCOPE_DENIED, no bank call, no limit consumed', async () => {
    const { ctx, principal } = makeEnv();
    const { bank, calls } = countingMock();
    const c = createContext(ctx.config, { now: ctx.now, bank });
    expect(await c.gateway.simulateDeposit(principal, { product_id: 'td-6m-branch', amount_cents: 100_000 })).toMatchObject({ error_code: 'SCOPE_DENIED' });
    expect(await c.gateway.executeDepositMock(principal, exec('td-6m-branch', 100_000, 'human-key-0001'))).toMatchObject({ error_code: 'SCOPE_DENIED' });
    expect(calls.execute).toBe(0);
    expect(c.mandates.get('mandate-001')!.consumed_cents).toBe(0);
  });

  it('human_only and unknown IDs get the same answer (no catalog probing)', async () => {
    const { ctx, principal } = makeEnv();
    const a = await ctx.gateway.executeDepositMock(principal, exec('td-6m-branch', 100_000, 'probe-key-001'));
    const b = await ctx.gateway.executeDepositMock(principal, exec('td-does-not-exist', 100_000, 'probe-key-002'));
    expect(a.reason?.replace('td-6m-branch', 'X')).toBe(b.reason?.replace('td-does-not-exist', 'X'));
  });

  it('agent_only deposit succeeds, counts once against the aggregate and is audited', async () => {
    const { ctx, principal } = makeEnv();
    const { bank, calls } = countingMock();
    const c = createContext(ctx.config, { now: ctx.now, bank });
    expect((await c.gateway.executeDepositMock(principal, exec('td-3m-agent', 100_000, 'agent-key-0001'))).status).toBe('ok');
    expect((await c.gateway.executeDepositMock(principal, exec('td-3m-agent', 100_000, 'agent-key-0001'))).data).toMatchObject({ idempotent_replay: true });
    expect(calls.execute).toBe(1);
    expect(c.mandates.get('mandate-001')!.consumed_cents).toBe(100_000);
    const executed = c.audit.list().filter((e) => e.event === 'execute_deposit_mock.executed');
    expect(executed).toHaveLength(1);
    expect(executed[0]).toMatchObject({ product_id: 'td-3m-agent', amount_cents: 100_000, agent_id: 'agent-001' });
  });

  it('agent_only product with a type outside the mandate -> SCOPE_DENIED', async () => {
    const { ctx, principal } = makeEnv();
    expect(await ctx.gateway.executeDepositMock(principal, exec('ins-travel-agent', 5_000, 'ins-key-0001'))).toMatchObject({
      error_code: 'SCOPE_DENIED',
      reason: expect.stringMatching(/insurance not allowed/),
    });
  });
});

describe('fixed-term simulation (P1.1)', () => {
  it('rejects a term that differs from the catalog for fixed-term products', async () => {
    const { ctx, principal } = makeEnv();
    expect(await ctx.gateway.simulateDeposit(principal, { product_id: 'td-3m', amount_cents: 100_000, term_months: 12 })).toMatchObject({ error_code: 'INVALID_INPUT' });
    expect((await ctx.gateway.simulateDeposit(principal, { product_id: 'td-3m', amount_cents: 100_000, term_months: 3 })).status).toBe('ok');
    expect((await ctx.gateway.simulateDeposit(principal, { product_id: 'td-3m', amount_cents: 100_000 })).status).toBe('ok');
  });

  it('flexible products keep accepting a chosen term', async () => {
    const { ctx, principal, seed } = makeEnv();
    // sav-flex is savings; issue a mandate that allows savings for this check
    ctx.mandates.issue(
      {
        agent_id: 'agent-001',
        owner_id: 'customer-001',
        allowed_actions: ['simulate_deposit'],
        allowed_products: ['savings'],
        per_action_limit_cents: 200_000,
        aggregate_limit_cents: 500_000,
        human_approval_above_cents: 150_000,
        expires_at: '2026-11-30T00:00:00.000Z',
        approved_by: 'customer-001',
      },
      seed.issuer,
      ctx.now(),
    );
    const r = await ctx.gateway.simulateDeposit(principal, { product_id: 'sav-flex', amount_cents: 100_000, term_months: 6 });
    expect(r).toMatchObject({ status: 'ok', data: { simulation: { term_months: 6 } } });
  });
});

describe('HTTP adapter fails closed on missing/invalid channel', () => {
  let bankServer: Server;
  let bankUrl: string;
  const bankCalls = { execute: 0 };

  beforeAll(async () => {
    const bank = express();
    bank.use(express.json());
    const base = { product_type: 'term_deposit', title: 'T', rate_bps: 400, term_months: 3, min_amount_cents: 1000, description: 'd' };
    bank.get('/offers', (_req, res) => {
      res.json([
        { ...base, product_id: 'http-none' }, // no distribution_channel
        { ...base, product_id: 'http-bad', distribution_channel: 'agents' }, // invalid value
        { ...base, product_id: 'http-both', distribution_channel: 'both' },
      ]);
    });
    bank.post('/deposits/execute', (_req, res) => {
      bankCalls.execute += 1;
      res.json({ deposit_id: 'X', status: 'executed_mock' });
    });
    bankServer = bank.listen(0, '127.0.0.1');
    await new Promise<void>((r) => bankServer.once('listening', () => r()));
    bankUrl = `http://127.0.0.1:${(bankServer.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => bankServer.close(() => r())));

  it('unclassified offers are hidden and not executable; admin sees them as unclassified', async () => {
    const { ctx, principal } = makeEnv();
    const c = createContext({ ...ctx.config, bankAdapter: 'http', bankAgentUrl: bankUrl }, { now: ctx.now, bank: new HttpBankAdapter(bankUrl) });
    const offers = ((await c.gateway.getOffers(principal)).data as any).offers.map((o: any) => o.product_id);
    expect(offers).toEqual(['http-both']);
    for (const id of ['http-none', 'http-bad']) {
      expect(await c.gateway.executeDepositMock(principal, exec(id, 10_000, `http-key-${id}`))).toMatchObject({ error_code: 'SCOPE_DENIED' });
    }
    expect(bankCalls.execute).toBe(0);

    const app = createApp(c).listen(0, '127.0.0.1');
    await new Promise<void>((r) => app.once('listening', () => r()));
    const url = `http://127.0.0.1:${(app.address() as AddressInfo).port}/admin/api/offers`;
    const body = (await (await fetch(url, { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } })).json()) as any;
    expect(body.offers.map((o: any) => o.distribution_channel)).toEqual(['unclassified', 'unclassified', 'both']);
    await new Promise<void>((r) => app.close(() => r()));
  });
});

describe('admin catalog and channel stats (P1)', () => {
  it('catalog comparison is admin-only and shows [MOCK] offers of all three channels', async () => {
    const { ctx } = makeEnv();
    const server = createApp(ctx).listen(0, '127.0.0.1');
    await new Promise<void>((r) => server.once('listening', () => r()));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/admin/api`;
    try {
      expect((await fetch(`${base}/offers`)).status).toBe(401);
      expect((await fetch(`${base}/channel-stats`)).status).toBe(401);
      const body = (await (await fetch(`${base}/offers`, { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } })).json()) as any;
      expect(new Set(body.offers.map((o: any) => o.distribution_channel))).toEqual(new Set(['human_only', 'agent_only', 'both']));
      expect(body.offers.every((o: any) => o.title.startsWith('[MOCK]'))).toBe(true);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('counts only successful non-replay executions', () => {
    const ev = (event: string, result: AuditEvent['result'], extra: Partial<AuditEvent> = {}): AuditEvent => ({ audit_id: 'a', ts: 't', event, result, agent_id: 'agent-001', ...extra });
    const stats = computeChannelStats([
      ev('execute_deposit_mock.executed', 'allow', { amount_cents: 100_000 }),
      ev('execute_deposit_mock.executed', 'allow', { amount_cents: 50_000, agent_id: 'agent-002' }),
      ev('execute_deposit_mock.idempotent_replay', 'info', { amount_cents: 100_000 }),
      ev('simulate_deposit.allowed', 'allow', { amount_cents: 900_000 }),
      ev('execute_deposit_mock.denied', 'deny', { amount_cents: 250_000, error_code: 'LIMIT_EXCEEDED' }),
      ev('auth.denied', 'deny', { error_code: 'REPLAY_DETECTED' }),
      ev('admin.auth_failed', 'deny', { agent_id: undefined }),
    ]);
    expect(stats).toMatchObject({
      unique_agents_with_executions: 2,
      simulated_deposits_executed: 2,
      simulated_deposit_volume_cents: 150_000,
      denied_agent_actions: 2,
      denied_by_error_code: { LIMIT_EXCEEDED: 1, REPLAY_DETECTED: 1 },
    });
    expect(stats.notice).toMatch(/SIMULATED/);
  });
});
