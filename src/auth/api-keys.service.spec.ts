import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { throttleTracker } from '../security/principal-throttler.guard';
import { ApiKeysService, hashApiKey } from './api-keys.service';

interface Row {
  id: string;
  userId: string;
  name: string;
  prefix: string;
  hash: string;
  scopes: string[];
  maxAmountPerAction: Prisma.Decimal | null;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
}

/** Minimal in-memory stand-in for prisma.apiKey. */
function fakePrisma() {
  const rows: Row[] = [];
  const apiKey = {
    create: jest.fn(async ({ data }: { data: Omit<Row, 'id' | 'lastUsedAt' | 'revokedAt' | 'createdAt'> }) => {
      const row: Row = { ...data, id: `k${rows.length + 1}`, lastUsedAt: null, revokedAt: null, createdAt: new Date() };
      rows.push(row);
      return row;
    }),
    findUnique: jest.fn(async ({ where }: { where: { hash: string } }) => {
      const row = rows.find((r) => r.hash === where.hash);
      return row ? { ...row, user: { role: 'customer' } } : null;
    }),
    update: jest.fn(async ({ where, data }: { where: { id: string }; data: Partial<Row> }) => {
      const row = rows.find((r) => r.id === where.id)!;
      Object.assign(row, data);
      return row;
    }),
  };
  return { rows, prisma: { apiKey } as unknown as PrismaService };
}

describe('ApiKeysService', () => {
  it('create returns rk_live_ key once; DB stores only sha256 hash and 12-char prefix', async () => {
    const { rows, prisma } = fakePrisma();
    const svc = new ApiKeysService(prisma);
    const created = await svc.create('u1', { name: 'test', scopes: ['accounts:read'], maxAmountPerAction: 500 });

    expect(created.key).toMatch(/^rk_live_[A-Za-z0-9_-]{32}$/);
    expect(created.prefix).toBe(created.key.slice(0, 12));
    expect(created.prefix).toHaveLength(12);
    expect(created.maxAmountPerAction).toBe(500);
    expect(rows[0].hash).toBe(hashApiKey(created.key));
    expect(rows[0].hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(rows[0])).not.toContain(created.key);
  });

  it('authenticate(valid) → principal kind api_key with stored scopes and maxAmountPerAction', async () => {
    const { rows, prisma } = fakePrisma();
    const svc = new ApiKeysService(prisma);
    const created = await svc.create('u1', { name: 'test', scopes: ['accounts:read', 'agent:chat'], maxAmountPerAction: 250.5 });

    const p = await svc.authenticate(created.key);
    expect(p).toEqual({
      userId: 'u1',
      role: 'customer',
      kind: 'api_key',
      apiKeyId: created.id,
      scopes: ['accounts:read', 'agent:chat'],
      maxAmountPerAction: 250.5,
    });
    expect(rows[0].lastUsedAt).toBeInstanceOf(Date);
  });

  it('authenticate(revoked or unknown) → null', async () => {
    const { rows, prisma } = fakePrisma();
    const svc = new ApiKeysService(prisma);
    const created = await svc.create('u1', { name: 'test', scopes: ['accounts:read'] });

    expect(await svc.authenticate('rk_live_' + 'x'.repeat(32))).toBeNull();
    rows[0].revokedAt = new Date();
    expect(await svc.authenticate(created.key)).toBeNull();
  });
});

describe('throttleTracker', () => {
  it('prefers apiKeyId, then userId, then ip', () => {
    const base = { userId: 'u1', role: 'customer' as const, scopes: [], maxAmountPerAction: null };
    expect(throttleTracker({ principal: { ...base, kind: 'api_key', apiKeyId: 'k1' }, ip: '1.2.3.4' })).toBe('key:k1');
    expect(throttleTracker({ principal: { ...base, kind: 'user' }, ip: '1.2.3.4' })).toBe('user:u1');
    expect(throttleTracker({ ip: '1.2.3.4' })).toBe('ip:1.2.3.4');
  });
});
