import { HttpException } from '@nestjs/common';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { GoalType } from '@prisma/client';
import { z, ZodRawShape } from 'zod';
import { ActionsService } from '../actions/actions.service';
import { ProposeInput } from '../actions/policy';
import { AgentService } from '../agent/agent.service';
import { amountSchema } from '../agent/tools/schemas';
import { actorFromPrincipal, Principal, Scope } from '../auth/principal';
import { StatsService } from '../banking/stats.service';
import { config } from '../config/config';
import { simulate } from '../finance/projection';
import { GoalsService } from '../goals/goals.service';
import { KnowledgeService } from '../knowledge/knowledge.service';
import { MoneyMapService } from '../money-map/money-map.service';
import { OffersService } from '../offers/offers.service';
import { ProductsService } from '../products/products.service';
import { AuditService } from '../security/audit/audit.service';
import { UsersService } from '../users/users.service';

export interface McpDeps {
  users: UsersService;
  stats: StatsService;
  goals: GoalsService;
  offers: OffersService;
  knowledge: KnowledgeService;
  moneyMap: MoneyMapService;
  products: ProductsService;
  agent: AgentService;
  actions: ActionsService;
  audit: AuditService;
}

export interface McpToolDef {
  name: string;
  description: string;
  scope: Scope | null;
  inputSchema: ZodRawShape;
  handler: (deps: McpDeps, p: Principal, args: any) => Promise<unknown>;
}

export interface McpToolResult {
  [key: string]: unknown;
  isError?: boolean;
  content: { type: 'text'; text: string }[];
}

export const MCP_INTERNAL_ERROR = 'A apărut o eroare internă. Încearcă din nou mai târziu.';

export const missingScopeText = (scope: Scope): string => `Lipsește permisiunea ${scope}`;

/** Romanian, agent-readable error text for a failed tool call (message + policy violations, if any). */
export function toolErrorText(e: unknown): string {
  if (e instanceof HttpException) {
    const body = e.getResponse();
    let message = e.message;
    let violations: string[] = [];
    if (typeof body === 'string') message = body;
    else if (body && typeof body === 'object') {
      const b = body as { message?: unknown; violations?: unknown };
      if (Array.isArray(b.message)) message = b.message.join('; ');
      else if (typeof b.message === 'string') message = b.message;
      if (Array.isArray(b.violations)) violations = b.violations.map(String);
    }
    return violations.length ? `${message}: ${violations.join(', ')}` : message;
  }
  return MCP_INTERNAL_ERROR;
}

export const okResult = (value: unknown): McpToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(value ?? null) }],
});

export const errorResult = (text: string): McpToolResult => ({ isError: true, content: [{ type: 'text', text }] });

const proposalId = { proposalId: z.string().min(1).max(64) };

export const MCP_TOOLS: McpToolDef[] = [
  {
    name: 'get_profile_summary',
    description: 'Profilul clientului: nume, profil de risc, venit lunar declarat.',
    scope: 'profile:read',
    inputSchema: {},
    handler: (d, p) => d.users.getProfile(p.userId),
  },
  {
    name: 'get_financial_snapshot',
    description: 'Situația financiară curentă: solduri, venituri/cheltuieli medii, rezervă de urgență, bani neutilizați.',
    scope: 'accounts:read',
    inputSchema: {},
    handler: (d, p) => d.stats.snapshot(p.userId),
  },
  {
    name: 'list_goals',
    description: 'Obiectivele financiare ale clientului, cu progres.',
    scope: 'goals:read',
    inputSchema: {},
    handler: (d, p) => d.goals.list(p.userId),
  },
  {
    name: 'create_goal',
    description: 'Creează un obiectiv financiar pentru client.',
    scope: 'goals:write',
    inputSchema: {
      name: z.string().min(1).max(120),
      type: z.nativeEnum(GoalType),
      targetAmount: amountSchema,
      targetDate: z.string().max(40).optional().describe('ISO date, e.g. 2027-06-01'),
      priority: z.number().int().min(1).max(5).optional(),
    },
    handler: (d, p, a) =>
      d.goals.create(p.userId, {
        name: a.name,
        type: a.type,
        targetAmount: a.targetAmount,
        ...(a.targetDate ? { targetDate: a.targetDate } : {}),
        ...(a.priority ? { priority: a.priority } : {}),
      }),
  },
  {
    name: 'get_personalised_offers',
    description: 'Oferte personalizate din catalogul Raiffeisen, calculate pe baza datelor clientului.',
    scope: 'offers:read',
    inputSchema: {},
    handler: (d, p) => d.offers.list(p.userId),
  },
  {
    name: 'get_money_map',
    description:
      'Harta financiară a clientului: scara în 7 pași (statusuri, pasul curent) și cele mai importante 3 acțiuni recomandate.',
    scope: 'accounts:read',
    inputSchema: {},
    handler: (d, p) => d.moneyMap.getMoneyMap(p.userId),
  },
  {
    name: 'search_knowledge_base',
    description: 'Caută în baza de cunoștințe Raiffeisen (produse, comisioane, educație financiară).',
    scope: null,
    inputSchema: { query: z.string().min(1).max(500), k: z.number().int().min(1).max(10).optional() },
    handler: (d, _p, a) => d.knowledge.search(a.query, { k: a.k }),
  },
  {
    name: 'list_products',
    description: 'Lista produselor din catalog, filtrabilă după categorie sau scop.',
    scope: null,
    inputSchema: { category: z.string().max(60).optional(), goodFor: z.string().max(60).optional() },
    handler: (d, _p, a) => d.products.list({ category: a.category, goodFor: a.goodFor }),
  },
  {
    name: 'simulate_product',
    description: 'Proiecție deterministă (dobândă, impozit, sumă finală, luni până la țintă) pentru un produs din catalog.',
    scope: null,
    inputSchema: {
      productSlug: z.string().min(1).max(120),
      amount: amountSchema,
      termMonths: z.number().int().min(1).max(600).optional(),
      monthlyContribution: z.number().min(0).optional(),
      goalTarget: amountSchema.optional(),
    },
    handler: async (d, _p, a) => {
      const product = await d.products.get(a.productSlug);
      return simulate({
        product,
        amount: a.amount,
        termMonths: a.termMonths,
        monthlyContribution: a.monthlyContribution,
        goalTarget: a.goalTarget,
        interestTaxRate: config().INTEREST_TAX_RATE,
      });
    },
  },
  {
    name: 'ask_raiffeisen_agent',
    description: 'Întreabă agentul financiar Raiffeisen. Răspunsul include recomandări, propuneri în așteptare și citări.',
    scope: 'agent:chat',
    inputSchema: { message: z.string().min(1).max(4000), conversationId: z.string().max(64).optional() },
    handler: (d, p, a) => d.agent.chat(p, { message: a.message, conversationId: a.conversationId }, 'mcp'),
  },
  {
    name: 'propose_action',
    description:
      'Propune un transfer (între conturi proprii) sau deschiderea unui produs. Creează o propunere în așteptare; nimic nu se execută fără confirmare.',
    scope: 'actions:propose',
    inputSchema: {
      type: z.enum(['transfer', 'open_product']),
      fromAccountId: z.string().min(1).max(64),
      toAccountId: z.string().min(1).max(64).optional(),
      toIban: z.string().min(1).max(42).optional(),
      beneficiaryName: z.string().max(120).optional(),
      productSlug: z.string().min(1).max(120).optional(),
      termMonths: z.number().int().min(1).max(600).optional(),
      amount: z.number(),
      reason: z.string().max(300).optional(),
      goalId: z.string().min(1).max(64).optional(),
    },
    handler: (d, p, a) =>
      d.actions.propose(p, a as ProposeInput, { proposedVia: `mcp:${p.apiKeyId ?? p.userId}` }),
  },
  {
    name: 'confirm_action',
    description: 'Confirmă și execută o propunere în așteptare.',
    scope: 'actions:confirm',
    inputSchema: proposalId,
    handler: (d, p, a) => d.actions.confirm(p, a.proposalId),
  },
  {
    name: 'get_action_status',
    description: 'Starea unei propuneri (pending, executed, rejected, failed, expired).',
    scope: 'actions:propose',
    inputSchema: proposalId,
    handler: (d, p, a) => d.actions.get(p, a.proposalId),
  },
];

/** Runs one MCP tool for a principal: scope check, error mapping, audit. Never throws. */
export async function runMcpTool(def: McpToolDef, deps: McpDeps, p: Principal, args: unknown): Promise<McpToolResult> {
  let result: McpToolResult;
  if (def.scope && !p.scopes.includes(def.scope)) {
    result = errorResult(missingScopeText(def.scope));
  } else {
    try {
      result = okResult(await def.handler(deps, p, args ?? {}));
    } catch (e) {
      result = errorResult(toolErrorText(e));
    }
  }
  const ok = !result.isError;
  await deps.audit
    .record({
      ...actorFromPrincipal(p),
      userId: p.userId,
      action: 'mcp.tool_call',
      resource: def.name,
      verdict: ok ? 'allowed' : 'blocked',
      details: { tool: def.name, ok, apiKeyId: p.apiKeyId ?? null },
    })
    .catch(() => undefined);
  return result;
}

/** Registers every MCP tool on a per-request server, bound to the authenticated principal. */
export function registerMcpTools(server: McpServer, p: Principal, deps: McpDeps): void {
  const register = server.registerTool.bind(server) as unknown as (
    name: string,
    cfg: { description: string; inputSchema: ZodRawShape },
    cb: (args: unknown) => Promise<McpToolResult>,
  ) => void;
  for (const def of MCP_TOOLS) {
    register(def.name, { description: def.description, inputSchema: def.inputSchema }, (args) =>
      runMcpTool(def, deps, p, args),
    );
  }
}
