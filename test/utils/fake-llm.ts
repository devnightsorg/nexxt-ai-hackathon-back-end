import { createHash } from 'crypto';
import {
  ChatMessage,
  ChatOptions,
  ChatResult,
  EMBEDDING_DIM,
  LlmService,
  LlmUnavailableError,
  ToolDef,
} from '../../src/llm/llm.service';

export const DEFAULT_FAST_CONTENT = '{"injection":false,"offTopic":false,"reason":null}';

/** Deterministic unit vector of length 1024 derived from a hash of `text`. */
export function fakeEmbedding(text: string): number[] {
  let seed = createHash('sha256').update(text).digest().readUInt32LE(0) || 1;
  const v: number[] = new Array(EMBEDDING_DIM);
  let norm = 0;
  for (let i = 0; i < EMBEDDING_DIM; i++) {
    // mulberry32
    seed = (seed + 0x6d2b79f5) | 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    const r = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    v[i] = r * 2 - 1;
    norm += v[i] * v[i];
  }
  norm = Math.sqrt(norm);
  return v.map((x) => x / norm);
}

/**
 * Stand-in for LlmService in automated tests (no network).
 * `queue(...)` feeds model 'agent', `queueFast(...)` feeds model 'fast'.
 * Empty agent queue → `{ content: 'OK', toolCalls: [] }`; empty fast queue → a "clean" classifier JSON.
 */
export class FakeLlmService implements Pick<LlmService, 'isEnabled' | 'chat' | 'embed'> {
  enabled = true;
  failEmbeddings = false;
  calls: { model: 'agent' | 'fast'; messages: ChatMessage[]; tools?: ToolDef[] }[] = [];
  embedCalls: string[][] = [];
  private agentQueue: (ChatResult | Error)[] = [];
  private fastQueue: (ChatResult | Error)[] = [];

  queue(...r: (ChatResult | Error)[]): this {
    this.agentQueue.push(...r);
    return this;
  }

  queueFast(...r: (ChatResult | Error)[]): this {
    this.fastQueue.push(...r);
    return this;
  }

  reset(): void {
    this.calls = [];
    this.embedCalls = [];
    this.agentQueue = [];
    this.fastQueue = [];
    this.enabled = true;
    this.failEmbeddings = false;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  async chat(o: ChatOptions): Promise<ChatResult> {
    this.calls.push({ model: o.model, messages: o.messages, tools: o.tools });
    if (!this.enabled) throw new LlmUnavailableError('LLM dezactivat (fake)');
    const next = o.model === 'fast' ? this.fastQueue.shift() : this.agentQueue.shift();
    if (next instanceof Error) throw next;
    if (next) return next;
    return o.model === 'fast' ? { content: DEFAULT_FAST_CONTENT, toolCalls: [] } : { content: 'OK', toolCalls: [] };
  }

  async embed(texts: string[]): Promise<number[][]> {
    this.embedCalls.push(texts);
    if (!this.enabled || this.failEmbeddings) throw new LlmUnavailableError('Embeddings indisponibile (fake)');
    return texts.map(fakeEmbedding);
  }
}
