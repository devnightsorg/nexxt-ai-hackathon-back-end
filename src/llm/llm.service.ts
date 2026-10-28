import { Injectable, Logger } from '@nestjs/common';
import OpenAI from 'openai';
import { config } from '../config/config';

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
  /** Default 1024 for agent, 200 for fast. */
  maxTokens?: number;
  /** Default 0.3. */
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

/** Minimal surface of the OpenAI client this service uses (lets unit tests inject a mock). */
export interface LlmClient {
  chat: { completions: { create(body: unknown, opts?: unknown): Promise<unknown> } };
  embeddings: { create(body: unknown, opts?: unknown): Promise<unknown> };
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

/** OpenAI-compatible client for Featherless (chat + embeddings). */
@Injectable()
export class LlmService {
  private readonly logger = new Logger(LlmService.name);
  private client: LlmClient | null = null;
  private clientKey = '';

  isEnabled(): boolean {
    return config().FEATHERLESS_API_KEY.length > 0;
  }

  /** Overridable in tests. */
  setClient(client: LlmClient): void {
    this.client = client;
    this.clientKey = '__injected__';
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

  async chat(o: ChatOptions): Promise<ChatResult> {
    if (!this.isEnabled()) throw new LlmUnavailableError('LLM dezactivat: FEATHERLESS_API_KEY lipsește');
    const cfg = config();
    const client = this.getClient();
    const messages = cfg.AGENT_THINKING ? o.messages : withNoThink(o.messages);
    const body: Record<string, unknown> = {
      model: o.model === 'agent' ? cfg.AGENT_MODEL : cfg.FAST_MODEL,
      messages,
      max_tokens: o.maxTokens ?? (o.model === 'agent' ? 1024 : 200),
      temperature: o.temperature ?? 0.3,
    };
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
    if (!this.isEnabled()) throw new LlmUnavailableError('LLM dezactivat: FEATHERLESS_API_KEY lipsește');
    if (texts.length === 0) return [];
    const cfg = config();
    const client = this.getClient();
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += EMBED_BATCH) {
      const batch = texts.slice(i, i + EMBED_BATCH);
      const res = (await this.call(
        (signal) =>
          client.embeddings.create(
            { model: cfg.EMBEDDING_MODEL, input: batch, encoding_format: 'float' },
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
