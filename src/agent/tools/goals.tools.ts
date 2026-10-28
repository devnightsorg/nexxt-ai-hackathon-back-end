import { GoalType } from '@prisma/client';
import { z } from 'zod';
import { defineTool } from './types';
import { amountSchema, isoDateSchema } from './schemas';

export const listGoals = defineTool({
  name: 'list_goals',
  description: 'Lists the user financial goals with target, saved amount, progress and months left.',
  scope: 'goals:read',
  schema: z.object({}),
  handler: (ctx) => ctx.deps.goals.list(ctx.principal.userId),
});

export const createGoal = defineTool({
  name: 'create_goal',
  description: 'Creates a financial goal for the user (only when the user explicitly asks for it).',
  scope: 'goals:write',
  schema: z.object({
    name: z.string().min(1).max(120),
    type: z.nativeEnum(GoalType),
    targetAmount: amountSchema,
    targetDate: isoDateSchema.optional(),
  }),
  handler: (ctx, args) =>
    ctx.deps.goals.create(ctx.principal.userId, {
      name: args.name,
      type: args.type,
      targetAmount: args.targetAmount,
      ...(args.targetDate ? { targetDate: args.targetDate } : {}),
    }),
});

export const GOALS_TOOLS = [listGoals, createGoal];
