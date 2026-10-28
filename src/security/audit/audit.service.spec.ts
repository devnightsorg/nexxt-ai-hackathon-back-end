import { execSync } from 'node:child_process';
import { config } from '../../config/config';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService, GENESIS_HASH } from './audit.service';
import { stableStringify } from './stable-stringify';

describe('stableStringify', () => {
  it('stableStringify({b:1,a:{d:1,c:2}}) === \'{"a":{"c":2,"d":1},"b":1}\'', () =>
    expect(stableStringify({ b: 1, a: { d: 1, c: 2 } })).toBe('{"a":{"c":2,"d":1},"b":1}'));

  it('keeps nulls, drops undefined, serializes Dates', () =>
    expect(stableStringify({ z: null, u: undefined, d: new Date('2026-01-01T00:00:00.000Z'), l: [2, 1] })).toBe(
      '{"d":"2026-01-01T00:00:00.000Z","l":[2,1],"z":null}',
    ));
});

// Uses the test database (docker compose up -d db).
describe('AuditService (test DB)', () => {
  let prisma: PrismaService;
  let audit: AuditService;

  beforeAll(() => {
    process.env.DATABASE_URL = config().TEST_DATABASE_URL;
    execSync('npx prisma migrate deploy', { env: process.env, stdio: 'pipe' });
    prisma = new PrismaService();
    audit = new AuditService(prisma);
  }, 60000);

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe('TRUNCATE TABLE "AuditLog" RESTART IDENTITY');
  });

  it('chains: second row prevHash === first row hash; verify() → {valid:true, checked:2}', async () => {
    await audit.record({ actorType: 'user', actorId: 'u1', userId: 'u1', action: 'auth.login' });
    await audit.record({
      actorType: 'system',
      action: 'payment.denied',
      verdict: 'blocked',
      details: { amount: 12.5, nested: { b: 1, a: [1, 'x'] }, when: new Date() },
    });
    const rows = await prisma.auditLog.findMany({ orderBy: { id: 'asc' } });
    expect(rows).toHaveLength(2);
    expect(rows[0].prevHash).toBe(GENESIS_HASH);
    expect(rows[1].prevHash).toBe(rows[0].hash);
    await expect(audit.verify()).resolves.toEqual({ valid: true, checked: 2, firstBrokenId: null });
  });

  it('detects tampering: UPDATE details of row 1 via raw SQL → verify() → {valid:false, firstBrokenId:1}', async () => {
    await audit.record({ actorType: 'user', actorId: 'u1', userId: 'u1', action: 'payment.executed', details: { amount: 100 } });
    await audit.record({ actorType: 'user', actorId: 'u1', userId: 'u1', action: 'auth.login' });
    await prisma.$executeRawUnsafe(`UPDATE "AuditLog" SET details = '{"amount": 1}'::jsonb WHERE id = 1`);
    await expect(audit.verify()).resolves.toMatchObject({ valid: false, firstBrokenId: 1 });
  });

  it('20 concurrent record() calls → verify() valid, 20 rows', async () => {
    await Promise.all(
      Array.from({ length: 20 }, (_, i) => audit.record({ actorType: 'agent', userId: 'u1', action: 'agent.tool_call', details: { i } })),
    );
    expect(await prisma.auditLog.count()).toBe(20);
    await expect(audit.verify()).resolves.toEqual({ valid: true, checked: 20, firstBrokenId: null });
  });

  it('list() filters by actions/prefixes/verdict, newest first', async () => {
    await audit.record({ actorType: 'user', userId: 'u1', action: 'auth.login' });
    await audit.record({ actorType: 'user', userId: 'u1', action: 'auth.login_failed', verdict: 'blocked' });
    await audit.record({ actorType: 'agent', userId: 'u2', action: 'guardrail.input_blocked', verdict: 'blocked' });
    const blocked = await audit.list({ actions: ['auth.login_failed'], actionPrefixes: ['guardrail.'] });
    expect(blocked.map((r) => r.action)).toEqual(['guardrail.input_blocked', 'auth.login_failed']);
    expect((await audit.list({ userId: 'u1', verdict: 'allowed' })).map((r) => r.action)).toEqual(['auth.login']);
  });
});
