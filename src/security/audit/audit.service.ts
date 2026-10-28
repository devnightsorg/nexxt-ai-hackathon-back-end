import { Injectable } from '@nestjs/common';
import { ActorType, AuditLog, Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { stableStringify } from './stable-stringify';

export const GENESIS_HASH = '0'.repeat(64);
const AUDIT_LOCK_KEY = 4242;
const VERIFY_BATCH = 500;

export type AuditEntry = AuditLog;
export type AuditVerdict = 'allowed' | 'blocked';

export interface AuditEvent {
  actorType: ActorType;
  actorId?: string | null;
  userId?: string | null;
  action: string;
  resource?: string | null;
  verdict?: AuditVerdict;
  details?: Record<string, unknown>;
}

export interface AuditFilter {
  userId?: string;
  actions?: string[];
  actionPrefixes?: string[];
  verdict?: AuditVerdict;
  limit?: number;
}

interface HashedFields {
  ts: Date;
  actorType: ActorType;
  actorId: string | null;
  userId: string | null;
  action: string;
  resource: string | null;
  verdict: AuditVerdict;
  details: unknown;
}

export function computeAuditHash(prevHash: string, f: HashedFields): string {
  const body = stableStringify({
    ts: f.ts.toISOString(),
    actorType: f.actorType,
    actorId: f.actorId,
    userId: f.userId,
    action: f.action,
    resource: f.resource,
    verdict: f.verdict,
    details: f.details,
  });
  return createHash('sha256').update(prevHash + body).digest('hex');
}

/** Append-only, hash-chained audit trail. Each row's hash covers the previous row's hash plus its own content. */
@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async record(e: AuditEvent): Promise<void> {
    // Normalize details to plain JSON so the hash matches what jsonb gives back on verify().
    const details = JSON.parse(stableStringify(e.details ?? {})) as Prisma.InputJsonObject;
    const fields = {
      actorType: e.actorType,
      actorId: e.actorId ?? null,
      userId: e.userId ?? null,
      action: e.action,
      resource: e.resource ?? null,
      verdict: e.verdict ?? 'allowed',
      details,
    };

    await this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${AUDIT_LOCK_KEY})`;
        const last = await tx.auditLog.findFirst({ orderBy: { id: 'desc' }, select: { hash: true } });
        const prevHash = last?.hash ?? GENESIS_HASH;
        const ts = new Date();
        const hash = computeAuditHash(prevHash, { ts, ...fields });
        await tx.auditLog.create({ data: { ts, ...fields, prevHash, hash } });
      },
      { maxWait: 15000, timeout: 15000 },
    );
  }

  async verify(): Promise<{ valid: boolean; checked: number; firstBrokenId: number | null }> {
    let expectedPrev = GENESIS_HASH;
    let checked = 0;
    let cursor = 0;
    for (;;) {
      const rows = await this.prisma.auditLog.findMany({
        where: { id: { gt: cursor } },
        orderBy: { id: 'asc' },
        take: VERIFY_BATCH,
      });
      if (rows.length === 0) break;
      for (const row of rows) {
        checked++;
        const recomputed = computeAuditHash(expectedPrev, {
          ts: row.ts,
          actorType: row.actorType,
          actorId: row.actorId,
          userId: row.userId,
          action: row.action,
          resource: row.resource,
          verdict: row.verdict,
          details: row.details,
        });
        if (row.prevHash !== expectedPrev || row.hash !== recomputed) {
          return { valid: false, checked, firstBrokenId: row.id };
        }
        expectedPrev = row.hash;
        cursor = row.id;
      }
    }
    return { valid: true, checked, firstBrokenId: null };
  }

  /** Newest first. `actions` and `actionPrefixes` combine with OR. */
  async list(f: AuditFilter = {}): Promise<AuditEntry[]> {
    const actionOr: Prisma.AuditLogWhereInput[] = [
      ...(f.actions?.length ? [{ action: { in: f.actions } }] : []),
      ...(f.actionPrefixes ?? []).map((p) => ({ action: { startsWith: p } })),
    ];
    return this.prisma.auditLog.findMany({
      where: {
        ...(f.userId ? { userId: f.userId } : {}),
        ...(f.verdict ? { verdict: f.verdict } : {}),
        ...(actionOr.length ? { OR: actionOr } : {}),
      },
      orderBy: { id: 'desc' },
      take: Math.min(Math.max(f.limit ?? 100, 1), 1000),
    });
  }
}
