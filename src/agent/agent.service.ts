import { BadRequestException, HttpException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Conversation, Prisma } from '@prisma/client';
import { ActionsService, ProposalDto, toProposalDto } from '../actions/actions.service';
import { actorFromPrincipal, Principal } from '../auth/principal';
import { AccountsService } from '../banking/accounts.service';
import { StatsService } from '../banking/stats.service';
import { config } from '../config/config';
import { GoalsService } from '../goals/goals.service';
import { KnowledgeService } from '../knowledge/knowledge.service';
import { ChatMessage, ChatResult, ChatToolCall, LlmService, LlmUnavailableError, ToolDef } from '../llm/llm.service';
import { OffersService } from '../offers/offers.service';
import { PrismaService } from '../prisma/prisma.service';
import { CatalogProduct } from '../products/catalog.types';
import { ProductsService } from '../products/products.service';
import { AuditService } from '../security/audit/audit.service';
import { GuardrailsService, REFUSAL_TEXT } from '../security/guardrails/guardrails.service';
import { detectInjection } from '../security/guardrails/injection';
import { extractRates, guardOutput } from '../security/guardrails/output-guard';
import { PiiVault } from '../security/guardrails/pii-vault';
import { buildSystemPrompt } from './system-prompt';
import { parseToolArguments } from './tool-arguments';
import { AGENT_TOOLS, AgentDeps, AgentTool, hasToolScope, toolsForPrincipal, toToolDefs, ToolError } from './tools';
import { recommendProduct } from './tools/offers.tools';
import { Citation, newTurnState, Recommendation, TurnState } from './turn-state';

export const DEGRADED_TEXT =
  'Asistentul nu este disponibil momentan. Poți vedea în continuare conturile, statisticile și ofertele tale.';
const EMPTY_REPLY_TEXT = 'Nu am putut formula un răspuns. Te rog reformulează întrebarea.';
const HISTORY_LIMIT = 20;
const TOOL_RESULT_MAX = 6000;
const MAX_MESSAGE = 4000;

export interface AgentReply {
  conversationId: string;
  reply: string;
  recommendations: Recommendation[];
  proposals: ProposalDto[];
  citations: Citation[];
  guardrail: { blocked: boolean; reason: string | null; redactions: number; strippedSentences: number; warnings: string[] };
  degraded: boolean;
}

export interface ChatInput {
  message: string;
  conversationId?: string;
  /** Goal the conversation is about (goal chat); stored on the conversation. */
  goalId?: string;
}

export interface ConversationSummary {
  id: string;
  channel: string;
  title: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ConversationDetail extends ConversationSummary {
  messages: { id: string; role: 'user' | 'assistant'; content: string; createdAt: Date }[];
}

interface StoredToolMessage {
  toolCallId: string;
  name: string;
  arguments: string;
  content: string;
}

interface ToolOutcome {
  content: string;
  ok: boolean;
  error?: string;
}

function errorMessage(e: unknown): string {
  if (e instanceof HttpException) {
    const r = e.getResponse();
    if (typeof r === 'string') return r;
    const m = (r as { message?: unknown }).message;
    if (Array.isArray(m)) return m.join('; ');
    if (typeof m === 'string') return m;
    return e.message;
  }
  if (e instanceof Error) return e.message;
  return 'Eroare necunoscută';
}

function normalizeName(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Catalog products the reply names explicitly (by name or slug), longest names first, at most `max`. */
export function productsMentioned(reply: string, catalog: CatalogProduct[], max = 3): CatalogProduct[] {
  const text = ` ${normalizeName(reply)} `;
  const raw = reply.toLowerCase();
  const sorted = [...catalog].sort((a, b) => b.name.length - a.name.length);
  const found: CatalogProduct[] = [];
  for (const c of sorted) {
    const name = normalizeName(c.name);
    if ((name.length >= 8 && text.includes(` ${name} `)) || raw.includes(c.slug)) found.push(c);
    if (found.length >= max) break;
  }
  return found;
}

/** Goal named in a conversation's opening message: the longest goal name found there as a whole phrase. */
export function inferGoalId(text: string, goals: { id: string; name: string }[]): string | null {
  const haystack = ` ${normalizeName(text)} `;
  const hits = goals
    .map((g) => ({ id: g.id, name: normalizeName(g.name) }))
    .filter((g) => g.name.length >= 3 && haystack.includes(` ${g.name} `));
  if (!hits.length) return null;
  const best = hits.reduce((a, b) => (b.name.length > a.name.length ? b : a));
  // Two different goals named in the opening message (neither contains the other) → ambiguous.
  return hits.every((h) => best.name.includes(h.name)) ? best.id : null;
}

/** Messages of blocked turns (prompt injection) are kept for the transcript but never fed back to the model. */
function isBlockedMessage(m: { attachments: Prisma.JsonValue }): boolean {
  return !!m.attachments && typeof m.attachments === 'object' && (m.attachments as { blocked?: unknown }).blocked === true;
}

/**
 * Chronological user/assistant messages minus blocked turns: flagged ones, and turns stored before the flag
 * existed (an assistant refusal and the user message it answered).
 */
export function historyForModel<T extends { role: string; content: string; attachments: Prisma.JsonValue }>(chronological: T[]): T[] {
  const out: T[] = [];
  for (const m of chronological) {
    if (isBlockedMessage(m)) continue;
    if (m.role === 'assistant' && m.content === REFUSAL_TEXT) {
      if (out.length && out[out.length - 1].role === 'user') out.pop();
      continue;
    }
    out.push(m);
  }
  return out;
}

const STATUS_NOTE: Record<string, string> = {
  executed: 'the customer confirmed it and it was EXECUTED (the money moved; balances already include it)',
  rejected: 'the customer REJECTED it; nothing happened',
  expired: 'it EXPIRED without confirmation; nothing happened',
  failed: 'it FAILED at confirmation; nothing happened',
};

/**
 * For the model only: what became of the proposals an earlier assistant reply announced, so it never presents
 * an executed proposal as still waiting for confirmation (or counts it twice).
 */
export function proposalStatusNote(
  attachments: Prisma.JsonValue,
  status: Map<string, { summary: string; status: string }>,
): string {
  const ids = (attachments as { proposals?: unknown } | null)?.proposals;
  if (!Array.isArray(ids)) return '';
  const notes = ids
    .map((id) => (typeof id === 'string' ? status.get(id) : undefined))
    .filter((x): x is { summary: string; status: string } => !!x && x.status in STATUS_NOTE)
    .map((x) => `"${x.summary}": ${STATUS_NOTE[x.status]}`);
  return notes.length ? `\n\n[Bank status update, not part of the reply above: since then ${notes.join('; ')}.]` : '';
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 13)}…[trunchiat]` : s;
}

/** Rates (%) mentioned in a tool result: "N%" patterns plus numeric *RatePct / ratePct fields. */
export function ratesInResult(json: string, value: unknown): number[] {
  const out = extractRates(json);
  const walk = (v: unknown, depth: number): void => {
    if (depth > 8 || !v || typeof v !== 'object') return;
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (typeof x === 'number' && /ratepct$/i.test(k)) out.push(x);
      else if (k === 'interest_rate_or_return' || k === 'interestRateOrReturn') {
        const val = (x as { value?: unknown } | null)?.value;
        if (typeof val === 'number') out.push(val);
      } else walk(x, depth + 1);
    }
  };
  walk(value, 0);
  return out;
}

export function catalogRates(products: CatalogProduct[]): number[] {
  const out: number[] = [];
  for (const p of products) {
    if (typeof p.interest_rate_or_return?.value === 'number') out.push(p.interest_rate_or_return.value);
    for (const r of p.rates_by_term ?? []) out.push(r.ratePct);
    out.push(...extractRates(JSON.stringify(p)));
  }
  return [...new Set(out)];
}

@Injectable()
export class AgentService {
  private readonly logger = new Logger(AgentService.name);
  private readonly deps: AgentDeps;

  constructor(
    private readonly prisma: PrismaService,
    private readonly llm: LlmService,
    private readonly guardrails: GuardrailsService,
    private readonly audit: AuditService,
    stats: StatsService,
    accounts: AccountsService,
    goals: GoalsService,
    private readonly products: ProductsService,
    knowledge: KnowledgeService,
    offers: OffersService,
    actions: ActionsService,
  ) {
    this.deps = { prisma, stats, accounts, goals, products, knowledge, offers, actions };
  }

  async chat(p: Principal, i: ChatInput, channel: 'web' | 'mcp'): Promise<AgentReply> {
    const message = typeof i?.message === 'string' ? i.message : '';
    if (message.trim().length < 1 || message.length > MAX_MESSAGE) {
      throw new BadRequestException(`Mesajul trebuie să aibă între 1 și ${MAX_MESSAGE} caractere`);
    }
    const actor = { ...actorFromPrincipal(p), userId: p.userId };

    // 1. Conversation + vault.
    const conv = await this.loadOrCreateConversation(p, i.conversationId, channel);
    let goal: { id: string; name: string } | null = null;
    const vault = new PiiVault((conv.piiVault ?? {}) as Record<string, string>);
    const turn = newTurnState();
    const toolMessages: StoredToolMessage[] = [];
    const toolNames: string[] = [];
    const warnings: string[] = [];
    let iterations = 0;
    let blocked: { reason: string; details: Record<string, unknown> } | null = null;
    let degraded = false;
    let strippedSentences = 0;
    let replyText = '';

    // 2. Heuristic injection check (no LLM call when high).
    const injection = detectInjection(message);

    // 3. Redact PII before anything reaches the LLM (also what we persist).
    const redacted = vault.redact(message);
    if (vault.redactionCount > 0) {
      await this.audit.record({
        ...actor,
        action: 'guardrail.pii_redacted',
        resource: `conversation:${conv.id}`,
        details: { count: vault.redactionCount, source: 'user_message' },
      });
    }

    if (injection.severity === 'high') {
      blocked = { reason: 'Tentativă de manipulare a asistentului', details: { severity: 'high', matches: injection.matches } };
    } else {
      if (injection.severity === 'suspicious') warnings.push('Mesaj suspect (euristici)');
      try {
        // 4. Prompt + tools.
        const [user, catalog, recent, proposals] = await Promise.all([
          this.prisma.user.findUniqueOrThrow({ where: { id: p.userId } }),
          this.products.getAll(),
          this.prisma.message.findMany({
            where: { conversationId: conv.id, role: { in: ['user', 'assistant'] } },
            orderBy: { createdAt: 'desc' },
            take: HISTORY_LIMIT * 2,
          }),
          this.prisma.actionProposal.findMany({
            where: { conversationId: conv.id, userId: p.userId },
            orderBy: { createdAt: 'desc' },
            take: 20,
          }),
        ]);
        const history = historyForModel([...recent].reverse()).slice(-HISTORY_LIMIT);
        goal = await this.conversationGoal(p, conv, i.goalId, redacted);
        const now = new Date();
        const proposalStatus = new Map(
          proposals.map((x) => [
            x.id,
            {
              summary: vault.redact(toProposalDto(x).summary),
              status: x.status === 'pending' && x.expiresAt <= now ? 'expired' : x.status,
            },
          ]),
        );
        const system = buildSystemPrompt({
          firstName: user.fullName.split(/\s+/)[0] ?? user.fullName,
          age: user.age,
          occupation: user.occupation,
          riskProfile: user.riskProfile,
          today: now.toISOString().slice(0, 10),
          catalogIndex: catalog.map((c) => `${c.slug} — ${c.name} (${c.category})`).join('\n'),
          channel,
          goal: goal ? { id: goal.id, name: vault.redact(goal.name) } : null,
          proposals: [...proposalStatus.values()].slice(0, 10),
        });
        const messages: ChatMessage[] = [
          { role: 'system', content: system },
          ...history
            .filter((m) => m.content)
            .map(
              (m): ChatMessage =>
                m.role === 'user'
                  ? { role: 'user', content: m.content }
                  : { role: 'assistant', content: m.content + proposalStatusNote(m.attachments, proposalStatus) },
            ),
          { role: 'user', content: redacted },
        ];
        const allowedTools = toolsForPrincipal(p);
        const tools: ToolDef[] = toToolDefs(allowedTools);

        // 5. Classifier and first agent call run concurrently; both settle before any tool runs.
        const [cls, first] = await Promise.allSettled([
          this.guardrails.classify(redacted),
          this.llm.chat({ model: 'agent', messages, tools }),
        ]);
        const classification = cls.status === 'fulfilled' ? cls.value : null;
        if (classification?.injection) {
          blocked = {
            reason: classification.reason ?? 'Clasificatorul a detectat o tentativă de manipulare',
            details: { reason: classification.reason, source: 'classifier' },
          };
        } else {
          if (first.status === 'rejected') throw first.reason;
          if (classification?.offTopic) warnings.push('Cerere în afara subiectului financiar');
          let res: ChatResult = first.value;
          const ctx = { principal: p, conversationId: conv.id, channel, turn, deps: this.deps, goalId: goal?.id ?? null };

          // 6. Tool loop.
          const max = config().AGENT_MAX_ITERATIONS;
          while (res.toolCalls.length > 0 && iterations < max) {
            messages.push({
              role: 'assistant',
              content: res.content || null,
              tool_calls: res.toolCalls.map((tc) => ({
                id: tc.id,
                type: 'function' as const,
                function: { name: tc.name, arguments: tc.arguments },
              })),
            });
            for (const tc of res.toolCalls) {
              toolNames.push(tc.name);
              const outcome = await this.runToolCall(tc, ctx, vault, actor);
              messages.push({ role: 'tool', tool_call_id: tc.id, content: outcome.content });
              toolMessages.push({
                toolCallId: tc.id,
                name: tc.name,
                arguments: truncate(vault.redact(tc.arguments ?? ''), 2000),
                content: outcome.content,
              });
            }
            iterations++;
            res = await this.llm.chat({ model: 'agent', messages, tools });
          }
          if (res.toolCalls.length > 0) {
            res = await this.llm.chat({ model: 'agent', messages });
          }

          // 6b. Fallback: the model named catalog products without calling recommend_product.
          if (turn.recommendations.length === 0 && res.content) {
            for (const product of productsMentioned(res.content, catalog)) {
              try {
                await recommendProduct.handler(ctx, { productSlug: product.slug, why: 'Produs din catalog sugerat de asistent în acest răspuns.' });
              } catch (err) {
                this.logger.warn(`Fallback recommendation failed for ${product.slug}: ${(err as Error).message}`);
              }
            }
          }

          // 7a. Output guard.
          const guarded = guardOutput(res.content || EMPTY_REPLY_TEXT, {
            allowedRates: [...turn.allowedRates, ...catalogRates(catalog)],
            catalogNames: catalog.map((c) => c.name),
            recommendationCategories: turn.recommendations.map((r) => r.category),
          });
          strippedSentences = guarded.strippedSentences.length;
          warnings.push(...guarded.warnings);
          if (strippedSentences > 0) {
            await this.audit.record({
              ...actor,
              action: 'guardrail.output_stripped',
              resource: `conversation:${conv.id}`,
              details: { count: strippedSentences, sentences: guarded.strippedSentences },
            });
          }
          replyText = guarded.text || EMPTY_REPLY_TEXT;
        }
      } catch (e) {
        // 9. Degraded mode.
        if (!(e instanceof LlmUnavailableError)) throw e;
        this.logger.warn(`Agent degraded: ${e.message}`);
        degraded = true;
        replyText = DEGRADED_TEXT;
      }
    }

    // 7b. Blocked turn.
    if (blocked) {
      replyText = REFUSAL_TEXT;
      turn.recommendations = [];
      turn.citations = [];
      await this.audit.record({
        ...actor,
        action: 'guardrail.input_blocked',
        resource: `conversation:${conv.id}`,
        verdict: 'blocked',
        details: blocked.details,
      });
    }

    // 8. Persist (redacted) and audit.
    const storedReply = vault.redact(replyText);
    const base = Date.now();
    let seq = 0;
    const at = () => new Date(base + seq++);
    await this.prisma.$transaction([
      this.prisma.message.create({
        data: {
          conversationId: conv.id,
          role: 'user',
          content: redacted,
          ...(blocked ? { attachments: { blocked: true } as Prisma.InputJsonValue } : {}),
          createdAt: at(),
        },
      }),
      ...toolMessages.map((t) =>
        this.prisma.message.create({
          data: {
            conversationId: conv.id,
            role: 'tool',
            content: t.content,
            toolCallId: t.toolCallId,
            toolCalls: { name: t.name, arguments: t.arguments } as Prisma.InputJsonValue,
            createdAt: at(),
          },
        }),
      ),
      this.prisma.message.create({
        data: {
          conversationId: conv.id,
          role: 'assistant',
          content: storedReply,
          attachments: {
            recommendations: turn.recommendations.map((r) => r.productSlug),
            proposals: turn.proposals.map((x) => x.id),
            ...(blocked ? { blocked: true } : {}),
          } as unknown as Prisma.InputJsonValue,
          createdAt: at(),
        },
      }),
      this.prisma.conversation.update({
        where: { id: conv.id },
        data: {
          piiVault: vault.toJSON() as Prisma.InputJsonValue,
          ...(conv.title || blocked ? {} : { title: truncate(redacted.replace(/\s+/g, ' ').trim(), 80) }),
          ...(goal && !blocked && goal.id !== conv.goalId ? { goalId: goal.id } : {}),
        },
      }),
    ]);
    await this.audit.record({
      ...actor,
      action: 'agent.turn',
      resource: `conversation:${conv.id}`,
      verdict: blocked ? 'blocked' : 'allowed',
      details: { channel, tools: toolNames, iterations, blocked: !!blocked, degraded },
    });

    return {
      conversationId: conv.id,
      reply: vault.restore(replyText),
      recommendations: turn.recommendations,
      proposals: turn.proposals,
      citations: turn.citations,
      guardrail: {
        blocked: !!blocked,
        reason: blocked?.reason ?? null,
        redactions: vault.redactionCount,
        strippedSentences,
        warnings,
      },
      degraded,
    };
  }

  async listConversations(p: Principal): Promise<ConversationSummary[]> {
    const rows = await this.prisma.conversation.findMany({
      where: { userId: p.userId },
      orderBy: { updatedAt: 'desc' },
      take: 100,
    });
    return rows.map((c) => this.summary(c));
  }

  async getConversation(p: Principal, id: string): Promise<ConversationDetail> {
    const conv = await this.prisma.conversation.findFirst({
      where: { id, userId: p.userId },
      include: { messages: { where: { role: { in: ['user', 'assistant'] } }, orderBy: { createdAt: 'asc' } } },
    });
    if (!conv) throw new NotFoundException('Conversația nu există');
    const vault = new PiiVault((conv.piiVault ?? {}) as Record<string, string>);
    return {
      ...this.summary(conv),
      messages: conv.messages.map((m) => ({
        id: m.id,
        role: m.role as 'user' | 'assistant',
        content: vault.restore(m.content),
        createdAt: m.createdAt,
      })),
    };
  }

  // ---------------------------------------------------------------------------

  private summary(c: Conversation): ConversationSummary {
    const vault = new PiiVault((c.piiVault ?? {}) as Record<string, string>);
    return {
      id: c.id,
      channel: c.channel,
      title: c.title ? vault.restore(c.title) : null,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
    };
  }

  /**
   * Goal the conversation is about: the client's goalId, else the one stored on the conversation, else the goal
   * named in the conversation's opening message (the app's goal chat starts with the goal's details).
   * Only the user's own, non-cancelled goals count.
   */
  private async conversationGoal(
    p: Principal,
    conv: Conversation,
    requested: string | undefined,
    currentMessage: string,
  ): Promise<{ id: string; name: string } | null> {
    const goals = await this.prisma.goal.findMany({
      where: { userId: p.userId, status: { not: 'cancelled' } },
      select: { id: true, name: true },
      orderBy: { createdAt: 'desc' },
    });
    const byId = (id: string | null | undefined) => (id ? (goals.find((g) => g.id === id) ?? null) : null);
    if (requested) {
      const g = byId(requested);
      if (!g) throw new NotFoundException('Obiectivul nu există');
      return g;
    }
    if (conv.goalId) return byId(conv.goalId);
    const opening = await this.prisma.message.findMany({
      where: { conversationId: conv.id, role: 'user' },
      orderBy: { createdAt: 'asc' },
      take: 5,
      select: { content: true, attachments: true },
    });
    const first = opening.find((m) => !isBlockedMessage(m))?.content ?? currentMessage;
    return byId(inferGoalId(first, goals));
  }

  private async loadOrCreateConversation(p: Principal, id: string | undefined, channel: 'web' | 'mcp'): Promise<Conversation> {
    if (id) {
      const conv = await this.prisma.conversation.findFirst({ where: { id, userId: p.userId } });
      if (!conv) throw new NotFoundException('Conversația nu există');
      return conv;
    }
    return this.prisma.conversation.create({
      data: { userId: p.userId, channel, apiKeyId: p.kind === 'api_key' ? (p.apiKeyId ?? null) : null },
    });
  }

  private async runToolCall(
    tc: ChatToolCall,
    ctx: { principal: Principal; conversationId: string; channel: 'web' | 'mcp'; turn: TurnState; deps: AgentDeps },
    vault: PiiVault,
    actor: ReturnType<typeof actorFromPrincipal> & { userId: string },
  ): Promise<ToolOutcome> {
    const outcome = await this.executeTool(tc, ctx, vault);
    await this.audit.record({
      ...actor,
      action: 'agent.tool_call',
      resource: `conversation:${ctx.conversationId}`,
      verdict: outcome.ok ? 'allowed' : 'blocked',
      details: {
        tool: tc.name,
        ok: outcome.ok,
        ...(outcome.error ? { error: outcome.error } : {}),
        arguments: truncate(vault.redact(tc.arguments ?? ''), 1000),
      },
    });
    return outcome;
  }

  private async executeTool(
    tc: ChatToolCall,
    ctx: { principal: Principal; conversationId: string; channel: 'web' | 'mcp'; turn: TurnState; deps: AgentDeps },
    vault: PiiVault,
  ): Promise<ToolOutcome> {
    const fail = (error: string): ToolOutcome => ({ content: JSON.stringify({ ok: false, error }), ok: false, error });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tool: AgentTool<any> | undefined = AGENT_TOOLS.find((t) => t.name === tc.name);
    if (!tool) return fail(`Unealtă necunoscută: ${tc.name}`);
    if (!hasToolScope(ctx.principal, tool.scope)) return fail(`Permisiune lipsă: ${tool.scope}`);

    const raw = parseToolArguments(tc.arguments);
    if (raw === undefined) return fail('Argumente JSON invalide');
    const parsed = tool.schema.safeParse(raw);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join('.') || 'args'}: ${i.message}`).join('; ');
      return fail(`Argumente invalide: ${issues}`);
    }

    let result: unknown;
    try {
      result = await tool.handler(ctx, vault.restore(parsed.data));
    } catch (e) {
      if (e instanceof LlmUnavailableError) throw e;
      if (!(e instanceof ToolError) && !(e instanceof HttpException)) {
        this.logger.warn(`Tool ${tc.name} failed: ${(e as Error)?.stack ?? e}`);
      }
      return fail(errorMessage(e));
    }

    const json = JSON.stringify(result ?? null);
    ctx.turn.allowedRates.push(...ratesInResult(json, result));
    const content = truncate(vault.redact(json), TOOL_RESULT_MAX);
    const isFail = !!result && typeof result === 'object' && (result as { ok?: unknown }).ok === false;
    return { content, ok: !isFail, ...(isFail ? { error: 'policy_denied' } : {}) };
  }
}
