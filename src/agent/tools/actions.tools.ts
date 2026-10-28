import { z } from 'zod';
import { ProposalDto } from '../../actions/actions.service';
import { PolicyDeniedException, ProposeInput } from '../../actions/policy';
import { AgentToolContext, defineTool } from './types';
import { amountSchema } from './schemas';

function proposedVia(ctx: AgentToolContext): string {
  return ctx.channel === 'mcp' ? `mcp:${ctx.principal.apiKeyId ?? ''}` : 'web_agent';
}

function view(p: ProposalDto) {
  return { id: p.id, type: p.type, status: p.status, summary: p.summary, policyVerdict: p.policyVerdict, expiresAt: p.expiresAt };
}

/**
 * Models often pass an own account's IBAN or an invented placeholder instead of its id.
 * Map an own IBAN back to the id; for an unknown source, fall back to the user's only current account.
 */
async function resolveOwnAccount(ctx: AgentToolContext, ref: string | undefined, isSource: boolean): Promise<string | undefined> {
  if (!ref) return ref;
  const accounts = await ctx.deps.accounts.listForUser(ctx.principal.userId);
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

async function propose(ctx: AgentToolContext, rawInput: ProposeInput): Promise<unknown> {
  const input: ProposeInput = { ...rawInput };
  input.fromAccountId = (await resolveOwnAccount(ctx, input.fromAccountId, true)) ?? input.fromAccountId;
  if (input.type === 'transfer' && input.toAccountId) input.toAccountId = await resolveOwnAccount(ctx, input.toAccountId, false);
  try {
    const proposal = await ctx.deps.actions.propose(ctx.principal, input, {
      proposedVia: proposedVia(ctx),
      conversationId: ctx.conversationId,
    });
    ctx.turn.proposals.push(proposal);
    return {
      ok: true,
      proposal: view(proposal),
      note: 'Propunerea așteaptă confirmarea utilizatorului în aplicație; nimic nu s-a executat încă.',
    };
  } catch (e) {
    if (e instanceof PolicyDeniedException) {
      return { ok: false, violations: e.violations, hint: 'Use account ids returned by get_accounts.' };
    }
    throw e;
  }
}

export const proposeTransfer = defineTool({
  name: 'propose_transfer',
  description:
    'Proposes a transfer from one of the user accounts to another own account (toAccountId) or an IBAN (toIban). Creates a pending proposal the user must confirm in the app; no money moves now.',
  scope: 'actions:propose',
  schema: z.object({
    fromAccountId: z.string().min(1).max(64).describe('Account id from get_accounts'),
    toAccountId: z.string().min(1).max(64).optional(),
    toIban: z.string().min(1).max(42).optional(),
    beneficiaryName: z.string().max(120).optional(),
    amount: amountSchema,
    reason: z.string().min(1).max(300),
  }),
  handler: (ctx, args) => propose(ctx, { type: 'transfer', ...args }),
});

export const proposeOpenProduct = defineTool({
  name: 'propose_open_product',
  description:
    'Proposes opening a catalog product (deposit, savings account, fund, pension) funded from one of the user accounts. Creates a pending proposal the user must confirm in the app; no money moves now.',
  scope: 'actions:propose',
  schema: z.object({
    productSlug: z.string().min(1).max(120),
    fromAccountId: z.string().min(1).max(64).describe('Account id from get_accounts'),
    amount: amountSchema,
    termMonths: z.number().int().min(1).max(600).optional(),
    reason: z.string().min(1).max(300),
  }),
  handler: (ctx, args) => propose(ctx, { type: 'open_product', ...args }),
});

export const ACTIONS_TOOLS = [proposeTransfer, proposeOpenProduct];
