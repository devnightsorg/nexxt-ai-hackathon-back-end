import { ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  InjectThrottlerOptions,
  InjectThrottlerStorage,
  ThrottlerGuard,
  ThrottlerLimitDetail,
  type ThrottlerModuleOptions,
  type ThrottlerStorage,
} from '@nestjs/throttler';
import { actorFromPrincipal, Principal } from '../auth/principal';
import { config } from '../config/config';
import { AuditService } from './audit/audit.service';

export const THROTTLE_TTL_MS = 60000;

/** Global default: THROTTLE_LIMIT (120) requests / 60 s per principal; evaluated per request. */
export const DEFAULT_THROTTLE = {
  default: { limit: () => config().THROTTLE_LIMIT, ttl: THROTTLE_TTL_MS },
};

/** Stricter limit for agent / MCP routes: `@Throttle(AGENT_THROTTLE)`. AGENT_THROTTLE_LIMIT (20) / 60 s. */
export const AGENT_THROTTLE = {
  default: { limit: () => config().AGENT_THROTTLE_LIMIT, ttl: THROTTLE_TTL_MS },
};

export function throttleTracker(req: { principal?: Principal; ip?: string; ips?: string[] }): string {
  const p = req.principal;
  if (p?.apiKeyId) return `key:${p.apiKeyId}`;
  if (p?.userId) return `user:${p.userId}`;
  return `ip:${req.ips?.length ? req.ips[0] : (req.ip ?? 'unknown')}`;
}

/** Rate limiting keyed by API key, then user, then IP. Runs after AuthGuard so the principal is known. */
@Injectable()
export class PrincipalThrottlerGuard extends ThrottlerGuard {
  constructor(
    @InjectThrottlerOptions() options: ThrottlerModuleOptions,
    @InjectThrottlerStorage() storage: ThrottlerStorage,
    reflector: Reflector,
    private readonly audit: AuditService,
  ) {
    super(options, storage, reflector);
  }

  protected async getTracker(req: Record<string, any>): Promise<string> {
    return throttleTracker(req);
  }

  protected async throwThrottlingException(context: ExecutionContext, detail: ThrottlerLimitDetail): Promise<void> {
    const req = context.switchToHttp().getRequest<{ principal?: Principal; method?: string; originalUrl?: string; url?: string }>();
    const p = req.principal;
    const actor = p ? actorFromPrincipal(p) : { actorType: 'system' as const, actorId: null };
    await this.audit.record({
      ...actor,
      userId: p?.userId ?? null,
      action: 'ratelimit.exceeded',
      resource: `${req.method ?? ''} ${req.originalUrl ?? req.url ?? ''}`.trim(),
      verdict: 'blocked',
      details: { tracker: detail.tracker, limit: detail.limit, ttl: detail.ttl },
    });
    await super.throwThrottlingException(context, detail);
  }
}
