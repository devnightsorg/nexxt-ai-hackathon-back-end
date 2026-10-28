import { describe, expect, it } from 'vitest';
import type { BankAdapter } from '../src/bank/types.js';
import { MockBankAdapter } from '../src/bank/mock.js';
import { createContext } from '../src/context.js';
import { makeEnv } from './helpers.js';

const exec = (amount_cents: number, idempotency_key: string, product_id = 'td-3m') => ({ product_id, amount_cents, idempotency_key });

describe('Gateway', () => {
  it('get_offers and simulate succeed; simulation consumes no limit', async () => {
    const { ctx, principal } = makeEnv();
    expect((await ctx.gateway.getOffers(principal)).status).toBe('ok');
    const sim = await ctx.gateway.simulateDeposit(principal, { product_id: 'td-3m', amount_cents: 100_000 });
    expect(sim).toMatchObject({ status: 'ok', data: { simulation: { expected_interest_cents: 1125 }, limits_consumed: false } });
    expect(ctx.mandates.get('mandate-001')!.consumed_cents).toBe(0);
  });

  it('execution succeeds once; same idempotency key does not execute or consume twice', async () => {
    const { ctx, principal } = makeEnv();
    let bankCalls = 0;
    const mock = new MockBankAdapter();
    const counting: BankAdapter = { kind: 'mock', listOffers: () => mock.listOffers(), simulateDeposit: (r) => mock.simulateDeposit(r), executeDeposit: (r) => { bankCalls += 1; return mock.executeDeposit(r); } };
    const c2 = createContext(ctx.config, { now: ctx.now, bank: counting });
    const a = await c2.gateway.executeDepositMock(principal, exec(100_000, 'key-00000001'));
    const b = await c2.gateway.executeDepositMock(principal, exec(100_000, 'key-00000001'));
    expect(a.status).toBe('ok');
    expect(b).toMatchObject({ status: 'ok', data: { idempotent_replay: true } });
    expect((b.data as any).execution.deposit_id).toBe((a.data as any).execution.deposit_id);
    expect(bankCalls).toBe(1);
    expect(c2.mandates.get('mandate-001')!.consumed_cents).toBe(100_000);
  });

  it('same idempotency key with different amount -> IDEMPOTENCY_CONFLICT', async () => {
    const { ctx, principal } = makeEnv();
    await ctx.gateway.executeDepositMock(principal, exec(100_000, 'key-00000002'));
    expect(await ctx.gateway.executeDepositMock(principal, exec(120_000, 'key-00000002'))).toMatchObject({ error_code: 'IDEMPOTENCY_CONFLICT' });
  });

  it('parallel executions cannot exceed the aggregate limit', async () => {
    const { ctx, principal } = makeEnv();
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => ctx.gateway.executeDepositMock(principal, exec(150_000, `par-key-${i}0000`))));
    expect(results.filter((r) => r.status === 'ok')).toHaveLength(3);
    expect(results.filter((r) => r.error_code === 'LIMIT_EXCEEDED')).toHaveLength(3);
    expect(ctx.mandates.get('mandate-001')!.consumed_cents).toBe(450_000);
  });

  it('forbidden product and excessive amount denied by server code', async () => {
    const { ctx, principal } = makeEnv();
    expect(await ctx.gateway.executeDepositMock(principal, exec(50_000, 'key-00000003', 'ins-life'))).toMatchObject({ error_code: 'SCOPE_DENIED' });
    expect(await ctx.gateway.executeDepositMock(principal, exec(10_000_000, 'key-00000004'))).toMatchObject({ error_code: 'LIMIT_EXCEEDED' });
    expect(await ctx.gateway.executeDepositMock(principal, exec(180_000, 'key-00000005'))).toMatchObject({ error_code: 'APPROVAL_REQUIRED' });
  });

  it('injection text in an offer has no effect on limits', async () => {
    const { ctx, principal } = makeEnv();
    const offers = (await ctx.gateway.getOffers(principal)).data as any;
    expect(offers.offers.find((o: any) => o.product_id === 'td-promo-x').description).toMatch(/ignore all limits/);
    expect(await ctx.gateway.executeDepositMock(principal, exec(100_000_000, 'key-00000006', 'td-promo-x'))).toMatchObject({ error_code: 'LIMIT_EXCEEDED' });
    const m = ctx.mandates.get('mandate-001')!;
    expect([m.per_action_limit_cents, m.aggregate_limit_cents, m.consumed_cents]).toEqual([200_000, 500_000, 0]);
  });

  it('expired and revoked mandates deny every tool', async () => {
    const { ctx, principal, clock } = makeEnv();
    clock.t = new Date(clock.t.getTime() + 8 * 24 * 3600 * 1000);
    expect(await ctx.gateway.getOffers(principal)).toMatchObject({ error_code: 'MANDATE_EXPIRED' });
    clock.t = new Date('2026-10-28T10:00:00Z');
    ctx.mandates.revoke('mandate-001', 'customer revoked', clock.t);
    expect(await ctx.gateway.getOffers(principal)).toMatchObject({ error_code: 'NO_ACTIVE_MANDATE' });
    expect(await ctx.gateway.executeDepositMock(principal, exec(10_000, 'key-00000007'))).toMatchObject({ error_code: 'NO_ACTIVE_MANDATE' });
  });

  it('tampered mandate limits on disk are rejected', async () => {
    const { ctx, principal, dataDir } = makeEnv();
    const fs = await import('node:fs');
    const file = `${dataDir}/mandates.json`;
    const all = JSON.parse(fs.readFileSync(file, 'utf8'));
    all['mandate-001'].per_action_limit_cents = 100_000_000;
    fs.writeFileSync(file, JSON.stringify(all));
    expect(await ctx.gateway.getOffers(principal)).toMatchObject({ error_code: 'NO_ACTIVE_MANDATE', reason: expect.stringMatching(/signature/) });
  });

  it('audit records decisions without secrets', async () => {
    const { ctx, principal, seed } = makeEnv();
    await ctx.gateway.executeDepositMock(principal, exec(50_000, 'key-00000008', 'ins-life'));
    const raw = (await import('node:fs')).readFileSync(ctx.audit.file, 'utf8');
    expect(raw).toContain('SCOPE_DENIED');
    expect(raw).not.toContain(seed.credentials.private_key_pem.split('\n')[1]);
    expect(raw).not.toContain(seed.credentials.passport.issuer_signature);
  });
});
