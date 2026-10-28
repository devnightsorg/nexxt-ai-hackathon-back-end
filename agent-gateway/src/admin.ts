import { createHash, timingSafeEqual } from 'node:crypto';
import express, { type NextFunction, type Request, type Response, type Router } from 'express';
import { z } from 'zod';
import { ADMIN_PAGE_HTML } from './adminPage.js';
import { computeChannelStats } from './channelStats.js';
import type { AppContext } from './context.js';
import { DEFAULT_MANDATE_TERMS } from './mandates.js';
import { ACTIONS, PRODUCT_TYPES } from './types.js';

// Separately authenticated customer/bank actions. Deliberately NOT exposed as MCP tools.

const mandateBody = z.object({
  agent_id: z.string().min(1),
  customer_approval: z.literal(true, { message: 'customer_approval must be true (simulated explicit customer approval)' }),
  expires_in_seconds: z.number().int().min(1).max(365 * 24 * 3600).default(7 * 24 * 3600),
  allowed_actions: z.array(z.enum(ACTIONS)).min(1).default(DEFAULT_MANDATE_TERMS.allowed_actions),
  allowed_products: z.array(z.enum(PRODUCT_TYPES)).min(1).default(DEFAULT_MANDATE_TERMS.allowed_products),
  per_action_limit_cents: z.number().int().positive().default(DEFAULT_MANDATE_TERMS.per_action_limit_cents),
  aggregate_limit_cents: z.number().int().positive().default(DEFAULT_MANDATE_TERMS.aggregate_limit_cents),
  human_approval_above_cents: z.number().int().positive().default(DEFAULT_MANDATE_TERMS.human_approval_above_cents),
});

const reasonBody = z.object({ reason: z.string().max(200).optional() }).default({});

const digest = (s: string) => createHash('sha256').update(s).digest();

function requireAdmin(ctx: AppContext) {
  return (req: Request, res: Response, next: NextFunction) => {
    const expected = ctx.config.adminToken;
    if (!expected) {
      res.status(503).json({ error: 'ADMIN_TOKEN is not configured' });
      return;
    }
    const given = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    if (!given || !timingSafeEqual(digest(given), digest(expected))) {
      ctx.audit.record({ event: 'admin.auth_failed', result: 'deny', actor: 'unknown', reason: `${req.method} ${req.path}` });
      res.status(401).json({ error: 'invalid admin token' });
      return;
    }
    next();
  };
}

export function createAdminRouter(ctx: AppContext): Router {
  const router = express.Router();

  router.get('/', (_req, res) => {
    res.type('html').send(ADMIN_PAGE_HTML);
  });

  const api = express.Router();
  api.use(express.json({ limit: '32kb' }));
  api.use(requireAdmin(ctx));

  api.get('/agents', (_req, res) => {
    res.json(ctx.registry.list());
  });

  api.post('/agents/:id/approve', (req, res) => {
    const agent = ctx.registry.get(req.params.id as string);
    if (!agent) return void res.status(404).json({ error: 'agent not found' });
    if (agent.status === 'revoked') return void res.status(409).json({ error: 'revoked agents cannot be re-approved' });
    const updated = ctx.registry.setStatus(agent.agent_id, 'active', 'approved by bank admin', ctx.now());
    ctx.audit.record({ event: 'agent.approved', result: 'info', actor: 'admin', agent_id: agent.agent_id, owner_id: agent.owner_id });
    res.json(updated);
  });

  api.post('/agents/:id/revoke', (req, res) => {
    const agent = ctx.registry.get(req.params.id as string);
    if (!agent) return void res.status(404).json({ error: 'agent not found' });
    const reason = reasonBody.parse(req.body ?? {}).reason ?? 'revoked by customer';
    const updated = ctx.registry.setStatus(agent.agent_id, 'revoked', reason, ctx.now());
    ctx.audit.record({ event: 'agent.revoked', result: 'info', actor: 'admin', agent_id: agent.agent_id, owner_id: agent.owner_id, reason });
    res.json(updated);
  });

  api.get('/mandates', (_req, res) => {
    res.json(ctx.mandates.list());
  });

  api.post('/mandates', (req, res) => {
    const parsed = mandateBody.safeParse(req.body ?? {});
    if (!parsed.success) return void res.status(400).json({ error: parsed.error.issues.map((i) => i.message).join('; ') });
    const body = parsed.data;
    const agent = ctx.registry.get(body.agent_id);
    if (!agent) return void res.status(404).json({ error: 'agent not found' });
    if (agent.status === 'revoked') return void res.status(409).json({ error: 'agent is revoked' });
    const now = ctx.now();
    const mandate = ctx.mandates.issue(
      {
        agent_id: agent.agent_id,
        owner_id: agent.owner_id, // owner comes from the registry, not from the request
        allowed_actions: body.allowed_actions,
        allowed_products: body.allowed_products,
        per_action_limit_cents: body.per_action_limit_cents,
        aggregate_limit_cents: body.aggregate_limit_cents,
        human_approval_above_cents: body.human_approval_above_cents,
        expires_at: new Date(now.getTime() + body.expires_in_seconds * 1000).toISOString(),
        approved_by: agent.owner_id,
      },
      ctx.issuer.getKeys(),
      now,
    );
    ctx.audit.record({
      event: 'mandate.issued',
      result: 'info',
      actor: `${agent.owner_id} (simulated customer approval)`,
      agent_id: agent.agent_id,
      owner_id: agent.owner_id,
      mandate_id: mandate.mandate_id,
      reason: `products=${mandate.allowed_products.join(',')} per_action=${mandate.per_action_limit_cents} aggregate=${mandate.aggregate_limit_cents} expires=${mandate.expires_at}`,
    });
    res.status(201).json(mandate);
  });

  api.post('/mandates/:id/revoke', (req, res) => {
    const mandate = ctx.mandates.get(req.params.id as string);
    if (!mandate) return void res.status(404).json({ error: 'mandate not found' });
    const reason = reasonBody.parse(req.body ?? {}).reason ?? 'revoked by customer';
    const updated = ctx.mandates.revoke(mandate.mandate_id, reason, ctx.now());
    ctx.audit.record({
      event: 'mandate.revoked',
      result: 'info',
      actor: `${mandate.owner_id} (customer)`,
      agent_id: mandate.agent_id,
      owner_id: mandate.owner_id,
      mandate_id: mandate.mandate_id,
      reason,
    });
    res.json(updated);
  });

  // Full catalog incl. human-only offers - admin only, never via MCP or a public route.
  api.get('/offers', async (_req, res) => {
    try {
      const offers = await ctx.bank.listOffers();
      res.json({
        source: ctx.bank.kind === 'mock' ? 'MOCK bank adapter (simulated data)' : 'bank backend',
        offers: offers.map((o) => ({ ...o, distribution_channel: o.distribution_channel ?? 'unclassified' })),
      });
    } catch (err) {
      res.status(502).json({ error: `bank adapter failed: ${err instanceof Error ? err.message : String(err)}` });
    }
  });

  api.get('/channel-stats', (_req, res) => {
    res.json(computeChannelStats(ctx.audit.list(Number.MAX_SAFE_INTEGER)));
  });

  api.get('/audit', (req, res) => {
    const limit = Math.min(Number(req.query.limit ?? 100) || 100, 1000);
    res.json(ctx.audit.list(limit));
  });

  router.use('/api', api);
  return router;
}
