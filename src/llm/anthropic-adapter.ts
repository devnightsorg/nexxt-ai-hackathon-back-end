import type Anthropic from '@anthropic-ai/sdk';
import type { ChatMessage, ChatResult, ChatToolCall, ToolDef } from './llm.service';

/** Reply used when Claude stops with `stop_reason: "refusal"` (safety classifier decline). */
export const ANTHROPIC_REFUSAL_TEXT = 'Nu pot ajuta cu această cerere.';

/** Placeholder first turn when the (trimmed) history starts with the assistant: the API needs a user turn first. */
const LEADING_USER_PLACEHOLDER = '(continuarea conversației)';

export interface AnthropicRequest {
  system: string;
  messages: Anthropic.MessageParam[];
  tools?: Anthropic.Tool[];
}

type UserBlock = Anthropic.TextBlockParam | Anthropic.ToolResultBlockParam;

/** Text of an OpenAI-style content value (string or parts); non-text parts are dropped. */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      const p = part as { type?: unknown; text?: unknown; refusal?: unknown };
      if (p?.type === 'text' && typeof p.text === 'string') return p.text;
      if (p?.type === 'refusal' && typeof p.refusal === 'string') return p.refusal;
      return '';
    })
    .join('');
}

function parseArguments(args: string | undefined): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(args ?? '');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function toAnthropicTool(t: ToolDef): Anthropic.Tool | null {
  if (t.type !== 'function') return null;
  const params = (t.function.parameters ?? {}) as Record<string, unknown>;
  const input_schema: Anthropic.Tool.InputSchema = { ...params, type: 'object' };
  if (input_schema.properties === undefined) input_schema.properties = {};
  const tool: Anthropic.Tool = { name: t.function.name, input_schema };
  if (t.function.description) tool.description = t.function.description;
  return tool;
}

/**
 * Converts the OpenAI-style conversation used across the app into a Messages API request.
 * System messages are joined into `system`; consecutive tool results (and a user text right after them)
 * become ONE user message; assistant tool calls become `tool_use` blocks.
 */
export function toAnthropicRequest(messages: ChatMessage[], tools?: ToolDef[]): AnthropicRequest {
  const system: string[] = [];
  const out: Anthropic.MessageParam[] = [];

  const pushUser = (blocks: UserBlock[]): void => {
    if (blocks.length === 0) return;
    const last = out[out.length - 1];
    if (last?.role === 'user') {
      const prev: Anthropic.ContentBlockParam[] =
        typeof last.content === 'string' ? [{ type: 'text', text: last.content }] : [...last.content];
      last.content = [...prev, ...blocks];
      return;
    }
    out.push({ role: 'user', content: blocks.length === 1 && blocks[0].type === 'text' ? blocks[0].text : blocks });
  };

  for (const m of messages) {
    switch (m.role) {
      case 'system':
      case 'developer': {
        const text = textOf(m.content).trim();
        if (text) system.push(text);
        break;
      }
      case 'user': {
        const text = textOf(m.content);
        if (text.trim()) pushUser([{ type: 'text', text }]);
        break;
      }
      case 'tool': {
        const content = textOf(m.content);
        const block: Anthropic.ToolResultBlockParam = { type: 'tool_result', tool_use_id: m.tool_call_id };
        if (content) block.content = content;
        pushUser([block]);
        break;
      }
      case 'assistant': {
        const blocks: Array<Anthropic.TextBlockParam | Anthropic.ToolUseBlockParam> = [];
        const text = textOf(m.content);
        if (text.trim()) blocks.push({ type: 'text', text });
        for (const tc of m.tool_calls ?? []) {
          if (tc.type !== 'function') continue;
          blocks.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input: parseArguments(tc.function.arguments) });
        }
        if (blocks.length > 0) out.push({ role: 'assistant', content: blocks });
        break;
      }
      default:
        break; // legacy 'function' role: not produced by this app
    }
  }

  if (out.length > 0 && out[0].role !== 'user') out.unshift({ role: 'user', content: LEADING_USER_PLACEHOLDER });

  const req: AnthropicRequest = { system: system.join('\n\n'), messages: out };
  const converted = (tools ?? []).map(toAnthropicTool).filter((t): t is Anthropic.Tool => t !== null);
  if (converted.length > 0) req.tools = converted;
  return req;
}

/**
 * Minimal tool definitions for every tool named in the history. A request that replays `tool_use` blocks
 * still has to declare those tools; pair these with `tool_choice: {type: 'none'}` for a final, tool-less answer.
 */
export function historyToolStubs(messages: Anthropic.MessageParam[]): Anthropic.Tool[] {
  const names = new Set<string>();
  for (const m of messages) {
    if (m.role !== 'assistant' || typeof m.content === 'string') continue;
    for (const b of m.content) if (b.type === 'tool_use') names.add(b.name);
  }
  return [...names].map((name) => ({ name, input_schema: { type: 'object', properties: {} } }));
}

/**
 * Maps a Messages API response back to the provider-neutral ChatResult. A `max_tokens` stop may have cut a
 * tool_use block short (its input incomplete), so tool calls are dropped and only the text is returned:
 * a truncated tool call must never execute.
 */
export function fromAnthropicMessage(msg: Anthropic.Message): ChatResult {
  if (msg.stop_reason === 'refusal') return { content: ANTHROPIC_REFUSAL_TEXT, toolCalls: [] };
  const truncated = msg.stop_reason === 'max_tokens';
  const texts: string[] = [];
  const toolCalls: ChatToolCall[] = [];
  for (const block of msg.content ?? []) {
    if (block.type === 'text') {
      if (block.text.trim()) texts.push(block.text.trim());
    } else if (block.type === 'tool_use' && !truncated) {
      toolCalls.push({ id: block.id, name: block.name, arguments: JSON.stringify(block.input ?? {}) });
    }
  }
  return { content: texts.join('\n\n'), toolCalls };
}
