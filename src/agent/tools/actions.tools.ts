import { AccountType } from '@prisma/client';
import { z } from 'zod';
import { ProposalDto } from '../../actions/actions.service';
import { PolicyDeniedException, ProposeInput } from '../../actions/policy';
import type { AccountDto } from '../../banking/dto';
import { AgentToolContext, defineTool } from './types';
import { amountSchema } from './schemas';

/** Own accounts money is saved into: a transfer there in a goal chat counts toward that goal. */
const SAVING_ACCOUNT_TYPES: readonly AccountType[] = ['savings', 'term_deposit', 'investment', 'pension', 'housing_savings'];

function proposedVia(ctx: AgentToolContext): string {
  return ctx.channel === 'mcp' ? `mcp:${ctx.principal.apiKeyId ?? ''}` : 'web_agent';
}

function view(p: ProposalDto) {
  return {
    id: p.id,
    type: p.type,
    status: p.status,
    summary: p.summary,
    goalId: typeof p.payload.goalId === 'string' ? p.payload.goalId : null,
    policyVerdict: p.policyVerdict,
    expiresAt: p.expiresAt,
  };
}

function pendingNote(ctx: AgentToolContext): string {
  return ctx.channel === 'mcp'
    ? 'Pending: the user must confirm it in the Raiffeisen app; nothing has run yet.'
    : 'Pending: the user sees it as a card under your reply and confirms it by pressing Confirm there (they are already in the app). Nothing has run yet, so do not say it is done.';
}

function normalizeName(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Models often pass an own account's IBAN or an invented placeholder instead of its id.
 * Map an own IBAN back to the id; for an unknown source, fall back to the user's only current account.
 */
function resolveOwnAccount(accounts: AccountDto[], ref: string | undefined, isSource: boolean): string | undefined {
  if (!ref) return ref;
  if (accounts.some((a) => a.id === ref)) return ref;
  const norm = ref.replace(/\s+/g, '').toUpperCase();
  const byIban = accounts.find((a) => a.iban.replace(/\s+/g, '').toUpperCase() === norm);
  if (byIban) return byIban.id;
  if (isSource) {
    const current = accounts.filter((a) => a.type === 'current' && a.status === 'active');
    if (current.length === 1) return current[0].id;
  }
  return ref;
}

/** The model's goal reference (id, or exact name) if it is one of the user's goals. */
async function resolveGoalRef(ctx: AgentToolContext, ref: string | undefined): Promise<string | undefined> {
  if (!ref) return undefined;
  const goals = await ctx.deps.prisma.goal.findMany({ where: { userId: ctx.principal.userId }, select: { id: true, name: true } });
  const byId = goals.find((g) => g.id === ref);
  if (byId) return byId.id;
  const byName = goals.filter((g) => normalizeName(g.name) === normalizeName(ref));
  return byName.length === 1 ? byName[0].id : undefined;
}

/**
 * Goal the proposal counts toward: the model's explicit goal, else the conversation's goal when the money is
 * being saved (opening a product, or a transfer into an own savings-type account that is not the source).
 */
async function goalFor(ctx: AgentToolContext, input: ProposeInput, accounts: AccountDto[], ref: string | undefined): Promise<string | undefined> {
  const explicit = await resolveGoalRef(ctx, ref);
  if (explicit) return explicit;
  if (!ctx.goalId) return undefined;
  if (input.type === 'open_product') return ctx.goalId;
  const norm = input.toIban?.replace(/\s+/g, '').toUpperCase();
  const target = accounts.find((a) => a.id === input.toAccountId || (!!norm && a.iban.replace(/\s+/g, '').toUpperCase() === norm));
  if (target && target.id !== input.fromAccountId && SAVING_ACCOUNT_TYPES.includes(target.type as AccountType)) return ctx.goalId;
  return undefined;
}

async function propose(ctx: AgentToolContext, rawInput: ProposeInput, goalRef: string | undefined): Promise<unknown> {
  const accounts = await ctx.deps.accounts.listForUser(ctx.principal.userId);
  const input: ProposeInput = { ...rawInput };
  delete input.goalId;
  input.fromAccountId = resolveOwnAccount(accounts, input.fromAccountId, true) ?? input.fromAccountId;
  if (input.type === 'transfer' && input.toAccountId) input.toAccountId = resolveOwnAccount(accounts, input.toAccountId, false);
  const goalId = await goalFor(ctx, input, accounts, goalRef);
  if (goalId) input.goalId = goalId;
  try {
    const proposal = await ctx.deps.actions.propose(ctx.principal, input, {
      proposedVia: proposedVia(ctx),
      conversationId: ctx.conversationId,
    });
    ctx.turn.proposals.push(proposal);
    return { ok: true, proposal: view(proposal), note: pendingNote(ctx) };
  } catch (e) {
    if (e instanceof PolicyDeniedException) {
      return { ok: false, violations: e.violations, hint: 'Use account ids returned by get_accounts.' };
    }
    throw e;
  }
}

const goalIdArg = z
  .string()
  .min(1)
  .max(120)
  .optional()
  .describe("Id (from list_goals) of the user's goal this money is for; in a goal conversation it defaults to that goal");

export const proposeTransfer = defineTool({
  name: 'propose_transfer',
  description:
    'Proposes a transfer from one of the user accounts to another own account (toAccountId) or an IBAN (toIban). Creates a pending proposal the user must confirm; no money moves now.',
  scope: 'actions:propose',
  schema: z.object({
    fromAccountId: z.string().min(1).max(64).describe('Account id from get_accounts'),
    toAccountId: z.string().min(1).max(64).optional(),
    toIban: z.string().min(1).max(42).optional(),
    beneficiaryName: z.string().max(120).optional(),
    amount: amountSchema,
    reason: z.string().min(1).max(300),
    goalId: goalIdArg,
  }),
  handler: (ctx, { goalId, ...args }) => propose(ctx, { type: 'transfer', ...args }, goalId),
});

export const proposeOpenProduct = defineTool({
  name: 'propose_open_product',
  description:
    'Proposes opening a catalog product (deposit, savings account, fund, pension) funded from one of the user accounts. Creates a pending proposal the user must confirm; no money moves now.',
  scope: 'actions:propose',
  schema: z.object({
    productSlug: z.string().min(1).max(120),
    fromAccountId: z.string().min(1).max(64).describe('Account id from get_accounts'),
    amount: amountSchema,
    termMonths: z.number().int().min(1).max(600).optional(),
    reason: z.string().min(1).max(300),
    goalId: goalIdArg,
  }),
  handler: (ctx, { goalId, ...args }) => propose(ctx, { type: 'open_product', ...args }, goalId),
});

export const ACTIONS_TOOLS = [proposeTransfer, proposeOpenProduct];
