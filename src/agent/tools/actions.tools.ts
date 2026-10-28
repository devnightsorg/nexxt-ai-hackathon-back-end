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

async function propose(ctx: AgentToolContext, input: ProposeInput): Promise<unknown> {
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
    if (e instanceof PolicyDeniedException) return { ok: false, violations: e.violations };
    throw e;
  }
}

export const proposeTransfer = defineTool({
  name: 'propose_transfer',
  description:
    'Proposes a transfer from one of the user accounts to another own account (toAccountId) or an IBAN (toIban). Creates a pending proposal the user must confirm in the app; no money moves now.',
  scope: 'actions:propose',
  schema: z.object({
    fromAccountId: z.string().min(1).max(64),
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
    fromAccountId: z.string().min(1).max(64),
    amount: amountSchema,
    termMonths: z.number().int().min(1).max(600).optional(),
    reason: z.string().min(1).max(300),
  }),
  handler: (ctx, args) => propose(ctx, { type: 'open_product', ...args }),
});

export const ACTIONS_TOOLS = [proposeTransfer, proposeOpenProduct];
