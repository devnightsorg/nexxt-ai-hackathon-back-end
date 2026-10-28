import { z } from 'zod';
import { MoneyMapService } from '../../money-map/money-map.service';
import { defineTool } from './types';

export const getMoneyMap = defineTool({
  name: 'get_money_map',
  description:
    'The user\'s money map: 7-step financial ladder (cash flow, buffer, expensive debt, protection, emergency fund, goals, long-term) with statuses, the current step and up to 3 ranked next actions. Statuses and numbers are decided by the bank; only rephrase them.',
  scope: 'accounts:read',
  schema: z.object({}),
  handler: (ctx) => {
    const d = ctx.deps;
    return new MoneyMapService(d.prisma, d.stats, d.goals, d.products, d.accounts).getMoneyMap(ctx.principal.userId);
  },
});

export const MONEY_MAP_TOOLS = [getMoneyMap];
