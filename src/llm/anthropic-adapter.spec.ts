import type Anthropic from '@anthropic-ai/sdk';
import {
  ANTHROPIC_REFUSAL_TEXT,
  fromAnthropicMessage,
  historyToolStubs,
  toAnthropicRequest,
} from './anthropic-adapter';
import type { ChatMessage, ToolDef } from './llm.service';

function message(content: unknown[], stop_reason: Anthropic.StopReason = 'end_turn'): Anthropic.Message {
  return { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-haiku-5-5', content, stop_reason } as unknown as Anthropic.Message;
}

describe('toAnthropicRequest', () => {
  it('joins every system message into `system` and keeps the conversation user-first', () => {
    const r = toAnthropicRequest([
      { role: 'system', content: 'Ești asistentul băncii.' },
      { role: 'user', content: 'Salut' },
      { role: 'system', content: [{ type: 'text', text: 'Răspunde scurt.' }] },
      { role: 'assistant', content: 'Bună!' },
      { role: 'user', content: [{ type: 'text', text: 'Ce dobândă are depozitul?' }] },
    ]);
    expect(r.system).toBe('Ești asistentul băncii.\n\nRăspunde scurt.');
    expect(r.messages).toEqual([
      { role: 'user', content: 'Salut' },
      { role: 'assistant', content: [{ type: 'text', text: 'Bună!' }] },
      { role: 'user', content: 'Ce dobândă are depozitul?' },
    ]);
    expect(r.tools).toBeUndefined();
  });

  it('prepends a user turn when the trimmed history starts with the assistant', () => {
    const r = toAnthropicRequest([
      { role: 'system', content: 'S' },
      { role: 'assistant', content: 'Răspuns vechi' },
      { role: 'user', content: 'Întrebare nouă' },
    ]);
    expect(r.messages[0].role).toBe('user');
    expect(r.messages[1]).toEqual({ role: 'assistant', content: [{ type: 'text', text: 'Răspuns vechi' }] });
  });

  it('turns assistant tool_calls into tool_use blocks (text first, only when non-empty)', () => {
    const r = toAnthropicRequest([
      { role: 'user', content: 'Ce obiective am?' },
      {
        role: 'assistant',
        content: 'Mă uit imediat.',
        tool_calls: [
          { id: 'call_1', type: 'function', function: { name: 'list_goals', arguments: '{"status":"active"}' } },
          { id: 'call_2', type: 'function', function: { name: 'get_snapshot', arguments: '' } },
        ],
      },
      { role: 'tool', tool_call_id: 'call_1', content: '[]' },
      { role: 'tool', tool_call_id: 'call_2', content: '{}' },
    ]);
    expect(r.messages[1]).toEqual({
      role: 'assistant',
      content: [
        { type: 'text', text: 'Mă uit imediat.' },
        { type: 'tool_use', id: 'call_1', name: 'list_goals', input: { status: 'active' } },
        { type: 'tool_use', id: 'call_2', name: 'get_snapshot', input: {} },
      ],
    });

    const noText = toAnthropicRequest([
      { role: 'user', content: 'x' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'c', type: 'function', function: { name: 't', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'c', content: 'ok' },
    ]);
    expect(noText.messages[1]).toEqual({ role: 'assistant', content: [{ type: 'tool_use', id: 'c', name: 't', input: {} }] });
  });

  it('maps invalid or non-object JSON arguments to {}', () => {
    const r = toAnthropicRequest([
      { role: 'user', content: 'x' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'a', type: 'function', function: { name: 't', arguments: '{"broken": ' } },
          { id: 'b', type: 'function', function: { name: 't', arguments: '[1,2]' } },
          { id: 'c', type: 'function', function: { name: 't', arguments: 'null' } },
        ],
      },
    ]);
    const blocks = r.messages[1].content as Anthropic.ToolUseBlockParam[];
    expect(blocks.map((b) => b.input)).toEqual([{}, {}, {}]);
  });

  it('groups consecutive tool results into ONE user message, with a following user text appended after them', () => {
    const msgs: ChatMessage[] = [
      { role: 'system', content: 'S' },
      { role: 'user', content: 'Propune un transfer' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'c1', type: 'function', function: { name: 'list_accounts', arguments: '{}' } },
          { id: 'c2', type: 'function', function: { name: 'list_goals', arguments: '{}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'c1', content: '[{"id":"acc"}]' },
      { role: 'tool', tool_call_id: 'c2', content: [{ type: 'text', text: '[]' }] },
      { role: 'user', content: 'Și din economii?' },
    ];
    const r = toAnthropicRequest(msgs);
    expect(r.messages).toHaveLength(3);
    expect(r.messages[2]).toEqual({
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'c1', content: '[{"id":"acc"}]' },
        { type: 'tool_result', tool_use_id: 'c2', content: '[]' },
        { type: 'text', text: 'Și din economii?' },
      ],
    });
  });

  it('maps OpenAI function tools to name/description/input_schema', () => {
    const tools: ToolDef[] = [
      {
        type: 'function',
        function: {
          name: 'simulate_product',
          description: 'Simulează un produs',
          parameters: {
            type: 'object',
            properties: { slug: { type: 'string' }, amount: { type: 'number' } },
            required: ['slug'],
            additionalProperties: false,
          },
        },
      },
      { type: 'function', function: { name: 'get_profile' } },
    ];
    const r = toAnthropicRequest([{ role: 'user', content: 'x' }], tools);
    expect(r.tools).toEqual([
      {
        name: 'simulate_product',
        description: 'Simulează un produs',
        input_schema: {
          type: 'object',
          properties: { slug: { type: 'string' }, amount: { type: 'number' } },
          required: ['slug'],
          additionalProperties: false,
        },
      },
      { name: 'get_profile', input_schema: { type: 'object', properties: {} } },
    ]);
  });
});

describe('historyToolStubs', () => {
  it('declares every tool named in replayed tool_use blocks, once', () => {
    const r = toAnthropicRequest([
      { role: 'user', content: 'x' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'a', type: 'function', function: { name: 'list_goals', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'a', content: '[]' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'b', type: 'function', function: { name: 'list_goals', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'b', content: '[]' },
    ]);
    expect(historyToolStubs(r.messages)).toEqual([{ name: 'list_goals', input_schema: { type: 'object', properties: {} } }]);
    expect(historyToolStubs([{ role: 'user', content: 'x' }])).toEqual([]);
  });
});

describe('fromAnthropicMessage', () => {
  it('joins text blocks and maps tool_use blocks to ChatToolCalls', () => {
    const r = fromAnthropicMessage(
      message(
        [
          { type: 'text', text: 'Verific conturile.' },
          { type: 'tool_use', id: 'toolu_1', name: 'list_accounts', input: { type: 'current' } },
          { type: 'text', text: '  ' },
          { type: 'text', text: 'Revin imediat.' },
        ],
        'tool_use',
      ),
    );
    expect(r).toEqual({
      content: 'Verific conturile.\n\nRevin imediat.',
      toolCalls: [{ id: 'toolu_1', name: 'list_accounts', arguments: '{"type":"current"}' }],
    });
  });

  it('maps a refusal stop to a polite Romanian reply without tool calls', () => {
    const r = fromAnthropicMessage(
      message([{ type: 'tool_use', id: 't', name: 'propose_transfer', input: {} }, { type: 'text', text: 'partial' }], 'refusal'),
    );
    expect(r).toEqual({ content: ANTHROPIC_REFUSAL_TEXT, toolCalls: [] });
  });
});
