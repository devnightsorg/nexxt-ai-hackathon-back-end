import { zodToJsonSchema } from 'zod-to-json-schema';
import type { Principal, Scope } from '../../auth/principal';
import type { ToolDef } from '../../llm/llm.service';
import { ACTIONS_TOOLS } from './actions.tools';
import { BANKING_TOOLS } from './banking.tools';
import { CATALOG_TOOLS } from './catalog.tools';
import { GOALS_TOOLS } from './goals.tools';
import { MONEY_MAP_TOOLS } from './money-map.tools';
import { OFFERS_TOOLS } from './offers.tools';
import type { AgentTool } from './types';

export * from './types';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const AGENT_TOOLS: AgentTool<any>[] = [
  ...BANKING_TOOLS,
  ...GOALS_TOOLS,
  ...CATALOG_TOOLS,
  ...OFFERS_TOOLS,
  ...MONEY_MAP_TOOLS,
  ...ACTIONS_TOOLS,
];

export function hasToolScope(p: Principal, scope: Scope | null): boolean {
  return scope === null || p.scopes.includes(scope);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function toolsForPrincipal(p: Principal, tools: AgentTool<any>[] = AGENT_TOOLS): AgentTool<any>[] {
  return tools.filter((t) => hasToolScope(p, t.scope));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function toolJsonSchema(t: AgentTool<any>): Record<string, unknown> {
  // Cast avoids TS2589 (deep generic instantiation) on zod-to-json-schema's overloads.
  const toJson = zodToJsonSchema as unknown as (s: unknown, o: { $refStrategy: 'none' }) => Record<string, unknown>;
  const schema = toJson(t.schema, { $refStrategy: 'none' });
  delete schema.$schema;
  return schema;
}

/** OpenAI-style tool definitions; with a principal, tools whose scope it lacks are left out. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function toToolDefs(tools: AgentTool<any>[], principal?: Principal): ToolDef[] {
  const visible = principal ? toolsForPrincipal(principal, tools) : tools;
  return visible.map((t) => ({
    type: 'function' as const,
    function: { name: t.name, description: t.description, parameters: toolJsonSchema(t) },
  }));
}
