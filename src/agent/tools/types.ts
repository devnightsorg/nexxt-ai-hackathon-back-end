import type { z } from 'zod';
import type { ActionsService } from '../../actions/actions.service';
import type { Principal, Scope } from '../../auth/principal';
import type { AccountsService } from '../../banking/accounts.service';
import type { StatsService } from '../../banking/stats.service';
import type { GoalsService } from '../../goals/goals.service';
import type { KnowledgeService } from '../../knowledge/knowledge.service';
import type { OffersService } from '../../offers/offers.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { ProductsService } from '../../products/products.service';
import type { TurnState } from '../turn-state';

/** Services the tool handlers may use (injected by AgentService; tools never touch the ledger). */
export interface AgentDeps {
  prisma: PrismaService;
  stats: StatsService;
  accounts: AccountsService;
  goals: GoalsService;
  products: ProductsService;
  knowledge: KnowledgeService;
  offers: OffersService;
  actions: ActionsService;
}

export interface AgentToolContext {
  principal: Principal;
  conversationId: string;
  channel: 'web' | 'mcp';
  turn: TurnState;
  deps: AgentDeps;
}

export interface AgentTool<A> {
  name: string;
  description: string;
  scope: Scope | null;
  schema: z.ZodType<A>;
  handler(ctx: AgentToolContext, args: A): Promise<unknown>;
}

/** Expected, user-facing tool failure; becomes `{"ok":false,"error":message}` for the model. */
export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolError';
  }
}

export function defineTool<A>(t: AgentTool<A>): AgentTool<A> {
  return t;
}
