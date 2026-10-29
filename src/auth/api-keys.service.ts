import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash, randomBytes } from 'node:crypto';
import { toMoney } from '../common/money';
import { PrismaService } from '../prisma/prisma.service';
import { MandateTerms, Principal, Scope, SCOPES, scopesForMandate } from './principal';

export const API_KEY_PREFIX = 'rk_live_';
export const API_KEY_PREFIX_LENGTH = 12;

export interface CreateApiKeyInput {
  name: string;
  scopes: Scope[];
  maxAmountPerAction?: number;
}

export interface CreatedApiKey {
  id: string;
  key: string;
  prefix: string;
  scopes: Scope[];
  maxAmountPerAction: number | null;
}

export interface ApiKeySummary {
  id: string;
  name: string;
  prefix: string;
  scopes: Scope[];
  maxAmountPerAction: number | null;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
}

export function hashApiKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

/** `rk_live_` + 32 base64url chars (24 random bytes). */
export function generateApiKey(): string {
  return API_KEY_PREFIX + randomBytes(24).toString('base64url');
}

function toScopes(raw: string[]): Scope[] {
  return raw.filter((s): s is Scope => (SCOPES as readonly string[]).includes(s));
}

@Injectable()
export class ApiKeysService {
  constructor(private readonly prisma: PrismaService) {}

  create(userId: string, dto: CreateApiKeyInput): Promise<CreatedApiKey> {
    return this.createWithKey(userId, generateApiKey(), dto);
  }

  /** Stores a caller-chosen key (used by the seed for deterministic demo keys). */
  async createWithKey(userId: string, key: string, dto: CreateApiKeyInput): Promise<CreatedApiKey> {
    const scopes = [...new Set(dto.scopes)];
    const invalid = scopes.find((s) => !(SCOPES as readonly string[]).includes(s));
    if (invalid) throw new BadRequestException(`Permisiune necunoscută: ${invalid}`);
    const prefix = key.slice(0, API_KEY_PREFIX_LENGTH);
    const row = await this.prisma.apiKey.create({
      data: {
        userId,
        name: dto.name,
        prefix,
        hash: hashApiKey(key),
        scopes,
        maxAmountPerAction: dto.maxAmountPerAction != null ? new Prisma.Decimal(dto.maxAmountPerAction) : null,
      },
    });
    return {
      id: row.id,
      key,
      prefix,
      scopes: toScopes(row.scopes),
      maxAmountPerAction: row.maxAmountPerAction != null ? toMoney(row.maxAmountPerAction) : null,
    };
  }

  async list(userId: string): Promise<ApiKeySummary[]> {
    const rows = await this.prisma.apiKey.findMany({ where: { userId }, orderBy: { createdAt: 'desc' } });
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      prefix: r.prefix,
      scopes: toScopes(r.scopes),
      maxAmountPerAction: r.maxAmountPerAction != null ? toMoney(r.maxAmountPerAction) : null,
      lastUsedAt: r.lastUsedAt,
      revokedAt: r.revokedAt,
      createdAt: r.createdAt,
    }));
  }

  async revoke(userId: string, id: string): Promise<{ id: string; revokedAt: Date }> {
    const row = await this.prisma.apiKey.findFirst({ where: { id, userId } });
    if (!row) throw new NotFoundException('Cheia API nu a fost găsită');
    if (row.revokedAt) return { id: row.id, revokedAt: row.revokedAt };
    const updated = await this.prisma.apiKey.update({ where: { id }, data: { revokedAt: new Date() } });
    return { id: updated.id, revokedAt: updated.revokedAt as Date };
  }

  /** Issues the API key an agent uses under a freshly signed mandate (OAuth token exchange). */
  async createMandateKey(userId: string, terms: MandateTerms, expiresAt: Date): Promise<CreatedApiKey> {
    const key = generateApiKey();
    const row = await this.prisma.apiKey.create({
      data: {
        userId,
        name: `Mandat ${terms.clientName}`,
        prefix: key.slice(0, API_KEY_PREFIX_LENGTH),
        hash: hashApiKey(key),
        scopes: scopesForMandate(terms.permissions),
        mandate: terms as unknown as Prisma.InputJsonValue,
        expiresAt,
      },
    });
    return { id: row.id, key, prefix: row.prefix, scopes: toScopes(row.scopes), maxAmountPerAction: null };
  }

  /**
   * Resolves a raw key to a Principal; null if unknown or revoked. Updates `lastUsedAt`.
   * A revoked or expired mandate key still resolves (with no scopes) so MCP tools can tell the agent why it is refused.
   */
  async authenticate(rawKey: string): Promise<Principal | null> {
    if (!rawKey.startsWith(API_KEY_PREFIX)) return null;
    const row = await this.prisma.apiKey.findUnique({ where: { hash: hashApiKey(rawKey) }, include: { user: true } });
    if (!row) return null;
    const terms = row.mandate as unknown as MandateTerms | null;
    if (row.revokedAt && !terms) return null;
    await this.prisma.apiKey.update({ where: { id: row.id }, data: { lastUsedAt: new Date() } });
    const status = row.revokedAt ? 'revoked' : row.expiresAt && row.expiresAt <= new Date() ? 'expired' : 'active';
    return {
      userId: row.userId,
      role: row.user.role,
      kind: 'api_key',
      apiKeyId: row.id,
      scopes: status === 'active' ? toScopes(row.scopes) : [],
      maxAmountPerAction: row.maxAmountPerAction != null ? toMoney(row.maxAmountPerAction) : null,
      ...(terms ? { mandate: { ...terms, status, expiresAt: row.expiresAt } } : {}),
    };
  }
}
