import Anthropic from '@anthropic-ai/sdk';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import OpenAI from 'openai';
import { AppConfig, config } from '../config/config';
import { fromAnthropicMessage, historyToolStubs, toAnthropicRequest } from './anthropic-adapter';

export type ChatMessage = OpenAI.Chat.ChatCompletionMessageParam;
export type ToolDef = OpenAI.Chat.ChatCompletionTool;

export interface ChatToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface ChatResult {
  content: string;
  toolCalls: ChatToolCall[];
}

export interface ChatOptions {
  model: 'agent' | 'fast';
  messages: ChatMessage[];
  tools?: ToolDef[];
  /** Default 1024 for agent, 200 for fast (Featherless); 4096 for the agent on Anthropic. */
  maxTokens?: number;
  /** Default 0.3. Featherless only: the Anthropic Messages API no longer accepts sampling parameters. */
  temperature?: number;
  timeoutMs?: number;
}

/** Thrown whenever the LLM provider cannot be used (disabled, network error, timeout, non-2xx). */
export class LlmUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'LlmUnavailableError';
  }
}

export const EMBEDDING_DIM = 1024;
const EMBED_BATCH = 32;
const ANTHROPIC_MAX_TOKENS = 4096;

/** Minimal surface of the OpenAI client this service uses (lets unit tests inject a mock). */
export interface LlmClient {
  chat: { completions: { create(body: unknown, opts?: unknown): Promise<unknown> } };
  embeddings: { create(body: unknown, opts?: unknown): Promise<unknown> };
}

/** Minimal surface of the Anthropic client this service uses (lets unit tests inject a mock). */
export interface AnthropicClient {
  messages: { create(body: unknown, opts?: unknown): Promise<unknown> };
}

/** One line naming the provider/model behind agent, fast and embeddings, plus missing-key warnings. */
export function describeRouting(cfg: AppConfig = config()): { summary: string; warnings: string[] } {
  const agent =
    cfg.AGENT_PROVIDER === 'anthropic' ? `anthropic ${cfg.ANTHROPIC_AGENT_MODEL}` : `featherless ${cfg.AGENT_MODEL}`;
  const summary =
    `LLM routing: agent → ${agent} | fast → featherless ${cfg.FAST_MODEL} | ` +
    `embeddings → featherless ${cfg.EMBEDDING_MODEL} (${EMBEDDING_DIM} dims)`;
  const warnings: string[] = [];
  if (cfg.AGENT_PROVIDER === 'anthropic' && !cfg.ANTHROPIC_API_KEY) {
    warnings.push(
      cfg.FEATHERLESS_API_KEY
        ? `AGENT_PROVIDER=anthropic but ANTHROPIC_API_KEY is empty: every agent call will fail over to featherless ${cfg.AGENT_MODEL}`
        : 'AGENT_PROVIDER=anthropic but ANTHROPIC_API_KEY is empty: the agent will run in degraded mode',
    );
  }
  if (!cfg.FEATHERLESS_API_KEY) {
    warnings.push('FEATHERLESS_API_KEY is empty: fast model and embeddings are disabled (heuristics + full-text search only)');
  }
  return { summary, warnings };
}

export function stripThinking(text: string | null | undefined): string {
  if (!text) return '';
  let out = text.replace(/<think>[\s\S]*?<\/think>/gi, '');
  // A dangling opening tag (truncated reasoning) or a stray closing tag.
  out = out.replace(/<think>[\s\S]*$/i, '').replace(/^[\s\S]*?<\/think>/i, '');
  return out.trim();
}

/** Appends `/no_think` to the first system message (adding one if absent). */
export function withNoThink(messages: ChatMessage[]): ChatMessage[] {
  const idx = messages.findIndex((m) => m.role === 'system');
  if (idx === -1) return [{ role: 'system', content: '/no_think' }, ...messages];
  return messages.map((m, i) => {
    if (i !== idx || m.role !== 'system') return m;
    const content =
      typeof m.content === 'string'
        ? `${m.content}\n/no_think`
        : [...m.content, { type: 'text' as const, text: '/no_think' }];
    return { ...m, content };
  });
}

function statusOf(err: unknown): number | undefined {
  const status = (err as { status?: unknown })?.status;
  return typeof status === 'number' ? status : undefined;
}

function isRetryable(err: unknown): boolean {
  const status = statusOf(err);
  return status !== undefined && (status === 429 || status >= 500);
}

/**
 * LLM gateway: Featherless (OpenAI-compatible) serves the fast model and embeddings, and the agent unless
 * AGENT_PROVIDER is 'anthropic', in which case the agent goes to the Anthropic Messages API (failing over to
 * the Featherless agent model when Anthropic is unavailable).
 */
@Injectable()
export class LlmService implements OnModuleInit {
  private readonly logger = new Logger(LlmService.name);
  private client: LlmClient | null = null;
  private clientKey = '';
  private anthropic: AnthropicClient | null = null;
  private anthropicKey = '';

  onModuleInit(): void {
    const { summary, warnings } = describeRouting();
    this.logger.log(summary);
    for (const w of warnings) this.logger.warn(w);
  }

  /** True when at least one provider is configured. */
  isEnabled(): boolean {
    const cfg = config();
    return cfg.FEATHERLESS_API_KEY.length > 0 || (cfg.AGENT_PROVIDER === 'anthropic' && cfg.ANTHROPIC_API_KEY.length > 0);
  }

  /** Overridable in tests. */
  setClient(client: LlmClient): void {
    this.client = client;
    this.clientKey = '__injected__';
  }

  /** Overridable in tests. */
  setAnthropicClient(client: AnthropicClient): void {
    this.anthropic = client;
    this.anthropicKey = '__injected__';
  }

  private getClient(): LlmClient {
    const cfg = config();
    if (this.clientKey === '__injected__' && this.client) return this.client;
    if (!cfg.FEATHERLESS_API_KEY) throw new LlmUnavailableError('LLM dezactivat: FEATHERLESS_API_KEY lipsește');
    if (!this.client || this.clientKey !== cfg.FEATHERLESS_API_KEY) {
      this.client = new OpenAI({
        apiKey: cfg.FEATHERLESS_API_KEY,
        baseURL: cfg.FEATHERLESS_BASE_URL,
        maxRetries: 0,
      }) as unknown as LlmClient;
      this.clientKey = cfg.FEATHERLESS_API_KEY;
    }
    return this.client;
  }

  private getAnthropicClient(cfg: AppConfig): AnthropicClient {
    if (this.anthropicKey === '__injected__' && this.anthropic) return this.anthropic;
    if (!this.anthropic || this.anthropicKey !== cfg.ANTHROPIC_API_KEY) {
      // Retries are ours (call(): one retry on 429/5xx), so the SDK must not retry on top.
      this.anthropic = new Anthropic({ apiKey: cfg.ANTHROPIC_API_KEY, maxRetries: 0 }) as unknown as AnthropicClient;
      this.anthropicKey = cfg.ANTHROPIC_API_KEY;
    }
    return this.anthropic;
  }

  /**
   * Agent calls on Anthropic fail over to the Featherless agent model: when the Anthropic call ends in
   * LlmUnavailableError (after its own one retry on 429/5xx) and FEATHERLESS_API_KEY is set, the same request
   * is sent once to AGENT_MODEL. Only if that also fails does the error reach the caller (agent → degraded).
   */
  async chat(o: ChatOptions): Promise<ChatResult> {
    const cfg = config();
    if (o.model !== 'agent' || cfg.AGENT_PROVIDER !== 'anthropic') return this.chatFeatherless(o, cfg);
    try {
      return await this.chatAnthropic(o, cfg);
    } catch (err) {
      if (!(err instanceof LlmUnavailableError) || !cfg.FEATHERLESS_API_KEY) throw err;
      this.logger.warn(`Anthropic agent call failed (${err.message}); failing over to featherless ${cfg.AGENT_MODEL}`);
      return this.chatFeatherless(o, cfg);
    }
  }

  private async chatAnthropic(o: ChatOptions, cfg: AppConfig): Promise<ChatResult> {
    if (!cfg.ANTHROPIC_API_KEY) throw new LlmUnavailableError('LLM agent dezactivat: ANTHROPIC_API_KEY lipsește');
    const client = this.getAnthropicClient(cfg);
    const req = toAnthropicRequest(o.messages, o.tools);
    // No temperature/top_p/top_k: the Messages API rejects sampling parameters.
    // Thinking stays off so no thinking blocks have to be replayed through our provider-neutral tool loop.
    const body: Anthropic.MessageCreateParamsNonStreaming = {
      model: cfg.ANTHROPIC_AGENT_MODEL,
      max_tokens: o.maxTokens ?? ANTHROPIC_MAX_TOKENS,
      messages: req.messages,
      thinking: { type: 'disabled' },
      // Automatic prompt caching: tools + system prompt (and the growing tool loop) are a stable prefix.
      cache_control: { type: 'ephemeral' },
    };
    if (req.system) body.system = req.system;
    if (req.tools?.length) {
      body.tools = req.tools;
    } else {
      // A final answer without tools still replays tool_use blocks, which must name declared tools.
      const stubs = historyToolStubs(req.messages);
      if (stubs.length > 0) {
        body.tools = stubs;
        body.tool_choice = { type: 'none' };
      }
    }
    const timeoutMs = o.timeoutMs ?? cfg.AGENT_TIMEOUT_MS;
    const res = (await this.call((signal) => client.messages.create(body, { signal }), timeoutMs, 'anthropic chat')) as
      | Anthropic.Message
      | undefined;
    if (!res || !Array.isArray(res.content)) throw new LlmUnavailableError('Răspuns Anthropic invalid (fără conținut)');
    return fromAnthropicMessage(res);
  }

  private async chatFeatherless(o: ChatOptions, cfg: AppConfig): Promise<ChatResult> {
    if (!cfg.FEATHERLESS_API_KEY) throw new LlmUnavailableError('LLM dezactivat: FEATHERLESS_API_KEY lipsește');
    const client = this.getClient();
    // AGENT_THINKING is for the agent only: the fast model (short JSON classifications) never thinks.
    const thinking = o.model === 'agent' && cfg.AGENT_THINKING;
    const messages = thinking ? o.messages : withNoThink(o.messages);
    const body: Record<string, unknown> = {
      model: o.model === 'agent' ? cfg.AGENT_MODEL : cfg.FAST_MODEL,
      messages,
      max_tokens: o.maxTokens ?? (o.model === 'agent' ? 1024 : 200),
      temperature: o.temperature ?? 0.3,
    };
    // Qwen3.5+ ignore /no_think and, with thinking on, often return empty content: switch it off in the template.
    if (!thinking) body.chat_template_kwargs = { enable_thinking: false };
    if (o.tools?.length) body.tools = o.tools;
    const timeoutMs = o.timeoutMs ?? (o.model === 'agent' ? cfg.AGENT_TIMEOUT_MS : cfg.FAST_TIMEOUT_MS);

    const res = (await this.call((signal) => client.chat.completions.create(body, { signal }), timeoutMs, 'chat')) as
      | OpenAI.Chat.ChatCompletion
      | undefined;
    const message = res?.choices?.[0]?.message;
    if (!message) throw new LlmUnavailableError('Răspuns LLM invalid (fără mesaj)');
    const toolCalls: ChatToolCall[] = [];
    for (const tc of message.tool_calls ?? []) {
      if (tc.type === 'function') {
        toolCalls.push({ id: tc.id, name: tc.function.name, arguments: tc.function.arguments ?? '{}' });
      }
    }
    return { content: stripThinking(message.content), toolCalls };
  }

  async embed(texts: string[]): Promise<number[][]> {
    const cfg = config();
    if (!cfg.FEATHERLESS_API_KEY) throw new LlmUnavailableError('LLM dezactivat: FEATHERLESS_API_KEY lipsește');
    if (texts.length === 0) return [];
    const client = this.getClient();
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += EMBED_BATCH) {
      const batch = texts.slice(i, i + EMBED_BATCH);
      const res = (await this.call(
        (signal) =>
          client.embeddings.create(
            // Matryoshka models (Qwen3-Embedding-4B is 2560-d natively) truncate to the vector(1024) column.
            { model: cfg.EMBEDDING_MODEL, input: batch, encoding_format: 'float', dimensions: EMBEDDING_DIM },
            { signal },
          ),
        cfg.EMBED_TIMEOUT_MS,
        'embed',
      )) as OpenAI.CreateEmbeddingResponse | undefined;
      const data = [...(res?.data ?? [])].sort((a, b) => a.index - b.index);
      if (data.length !== batch.length) {
        throw new LlmUnavailableError(`Embeddings: așteptat ${batch.length}, primit ${data.length}`);
      }
      for (const d of data) {
        if (!Array.isArray(d.embedding) || d.embedding.length !== EMBEDDING_DIM) {
          throw new LlmUnavailableError(`Embedding cu dimensiune greșită (așteptat ${EMBEDDING_DIM})`);
        }
        out.push(d.embedding);
      }
    }
    return out;
  }

  /** Runs a request with a hard timeout; retries once on 429/5xx; maps every failure to LlmUnavailableError. */
  private async call<T>(fn: (signal: AbortSignal) => Promise<T>, timeoutMs: number, label: string): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.withTimeout(fn, timeoutMs);
      } catch (err) {
        if (attempt === 0 && isRetryable(err)) {
          this.logger.warn(`LLM ${label}: status ${statusOf(err)}, retrying once`);
          await new Promise((r) => setTimeout(r, 500));
          continue;
        }
        if (err instanceof LlmUnavailableError) throw err;
        const status = statusOf(err);
        throw new LlmUnavailableError(
          `LLM ${label} indisponibil${status ? ` (status ${status})` : ''}: ${(err as Error)?.message ?? err}`,
          { cause: err },
        );
      }
    }
  }

  private withTimeout<T>(fn: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<T> {
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new LlmUnavailableError(`LLM timeout după ${timeoutMs} ms`));
      }, timeoutMs);
    });
    return Promise.race([fn(controller.signal), timeout]).finally(() => clearTimeout(timer));
  }
}
