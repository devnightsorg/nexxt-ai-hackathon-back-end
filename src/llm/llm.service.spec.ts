import { Logger } from '@nestjs/common';
import {
  AnthropicClient,
  ChatMessage,
  describeRouting,
  EMBEDDING_DIM,
  LlmClient,
  LlmService,
  LlmUnavailableError,
  usesTemplateThinkingSwitch,
} from './llm.service';
import { config } from '../config/config';

function completion(content: string) {
  return { choices: [{ message: { role: 'assistant', content, tool_calls: undefined } }] };
}

function mockClient(create: jest.Mock, embed: jest.Mock = jest.fn()): LlmClient {
  return { chat: { completions: { create } }, embeddings: { create: embed } };
}

function anthropicMessage(content: unknown[], stop_reason = 'end_turn') {
  return { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-haiku-5-5', content, stop_reason };
}

function mockAnthropic(create: jest.Mock): AnthropicClient {
  return { messages: { create } };
}

describe('LlmService', () => {
  const saved = { ...process.env };
  beforeEach(() => {
    process.env.FEATHERLESS_API_KEY = 'test-key';
    process.env.AGENT_THINKING = 'false';
    process.env.ANTHROPIC_API_KEY = '';
    delete process.env.AGENT_PROVIDER;
    delete process.env.AGENT_MODEL;
    delete process.env.FAST_MODEL;
    delete process.env.EMBEDDING_MODEL;
    delete process.env.ANTHROPIC_AGENT_MODEL;
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  it('removes <think> blocks from content', async () => {
    const create = jest.fn().mockResolvedValue(completion('<think>hmm, let me think</think>\n  Salut!  '));
    const svc = new LlmService();
    svc.setClient(mockClient(create));
    const r = await svc.chat({ model: 'fast', messages: [{ role: 'system', content: 'S' }, { role: 'user', content: 'hi' }] });
    expect(r).toEqual({ content: 'Salut!', toolCalls: [] });
    const body = create.mock.calls[0][0];
    expect(body.messages[0].content).toBe('S\n/no_think');
    expect(body.max_tokens).toBe(200);
    expect(body.temperature).toBe(0.3);
  });

  it('thinking off → chat_template_kwargs.enable_thinking=false (Qwen3.5+) plus /no_think (older Qwen3)', async () => {
    const create = jest.fn().mockResolvedValue(completion('{}'));
    const svc = new LlmService();
    svc.setClient(mockClient(create));
    await svc.chat({ model: 'fast', messages: [{ role: 'user', content: 'hi' }] });
    const body = create.mock.calls[0][0];
    expect(body.model).toBe('Qwen/Qwen3.8-27B');
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(body.messages[0]).toEqual({ role: 'system', content: '/no_think' });

    process.env.AGENT_THINKING = 'true';
    await svc.chat({ model: 'agent', messages: [{ role: 'user', content: 'hi' }] });
    const thinking = create.mock.calls[1][0];
    expect(thinking.model).toBe('deepseek-ai/DeepSeek-V4.1-Flash');
    expect(thinking.chat_template_kwargs).toBeUndefined();
    expect(thinking.messages).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it('original Qwen3 (Qwen3-32B) gets /no_think but never chat_template_kwargs (on Featherless it drops tool calls)', async () => {
    process.env.AGENT_MODEL = 'Qwen/Qwen3-32B';
    const create = jest.fn().mockResolvedValue(completion('{}'));
    const svc = new LlmService();
    svc.setClient(mockClient(create));
    const tools = [{ type: 'function' as const, function: { name: 'get_accounts', parameters: { type: 'object', properties: {} } } }];
    await svc.chat({ model: 'agent', messages: [{ role: 'system', content: 'S' }, { role: 'user', content: 'hi' }], tools });
    const body = create.mock.calls[0][0];
    expect(body.model).toBe('Qwen/Qwen3-32B');
    expect(body.chat_template_kwargs).toBeUndefined();
    expect(body.messages[0].content).toBe('S\n/no_think');
    expect(body.tools).toEqual(tools);

    process.env.AGENT_MODEL = 'zai-org/GLM-5.3-Flash';
    await svc.chat({ model: 'agent', messages: [{ role: 'user', content: 'hi' }], tools });
    expect(create.mock.calls[1][0].chat_template_kwargs).toEqual({ enable_thinking: false });
  });

  it('usesTemplateThinkingSwitch: only original Qwen3 releases are excluded', () => {
    expect(usesTemplateThinkingSwitch('Qwen/Qwen3-32B')).toBe(false);
    expect(usesTemplateThinkingSwitch('Qwen/Qwen3-8B')).toBe(false);
    expect(usesTemplateThinkingSwitch('Qwen/Qwen3.8-27B')).toBe(true);
    expect(usesTemplateThinkingSwitch('Qwen/Qwen3.5-122B-A10B')).toBe(true);
    expect(usesTemplateThinkingSwitch('moonshotai/Kimi-K2.6')).toBe(true);
    expect(usesTemplateThinkingSwitch('deepseek-ai/DeepSeek-V4.1-Flash')).toBe(true);
  });

  it('AGENT_THINKING=true applies to the agent only: the fast model still gets /no_think + enable_thinking=false', async () => {
    process.env.AGENT_THINKING = 'true';
    const create = jest.fn().mockResolvedValue(completion('{}'));
    const svc = new LlmService();
    svc.setClient(mockClient(create));
    await svc.chat({ model: 'fast', messages: [{ role: 'system', content: 'Clasifică.' }, { role: 'user', content: 'hi' }] });
    const body = create.mock.calls[0][0];
    expect(body.model).toBe('Qwen/Qwen3.8-27B');
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(body.messages[0]).toEqual({ role: 'system', content: 'Clasifică.\n/no_think' });
  });

  it('embeddings request dimensions=1024 from EMBEDDING_MODEL', async () => {
    const vec = new Array(EMBEDDING_DIM).fill(0.01);
    const embed = jest.fn().mockResolvedValue({ data: [{ index: 1, embedding: vec }, { index: 0, embedding: vec }] });
    const svc = new LlmService();
    svc.setClient(mockClient(jest.fn(), embed));
    const out = await svc.embed(['a', 'b']);
    expect(out).toHaveLength(2);
    expect(embed.mock.calls[0][0]).toEqual({
      model: 'Qwen/Qwen3-Embedding-4B',
      input: ['a', 'b'],
      encoding_format: 'float',
      dimensions: EMBEDDING_DIM,
    });

    embed.mockResolvedValueOnce({ data: [{ index: 0, embedding: new Array(2560).fill(0) }] });
    await expect(svc.embed(['x'])).rejects.toBeInstanceOf(LlmUnavailableError);
  });

  it('timeout → LlmUnavailableError; 503 then 200 → one retry succeeds', async () => {
    const hang = jest.fn().mockImplementation(() => new Promise(() => undefined));
    const svc = new LlmService();
    svc.setClient(mockClient(hang));
    await expect(svc.chat({ model: 'agent', messages: [{ role: 'user', content: 'x' }], timeoutMs: 30 })).rejects.toBeInstanceOf(
      LlmUnavailableError,
    );

    const flaky = jest
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('Service Unavailable'), { status: 503 }))
      .mockResolvedValueOnce(completion('gata'));
    const svc2 = new LlmService();
    svc2.setClient(mockClient(flaky));
    const r = await svc2.chat({ model: 'agent', messages: [{ role: 'user', content: 'x' }] });
    expect(r.content).toBe('gata');
    expect(flaky).toHaveBeenCalledTimes(2);
  });

  it('isEnabled() false when key empty and chat() throws LlmUnavailableError', async () => {
    process.env.FEATHERLESS_API_KEY = '';
    const svc = new LlmService();
    expect(svc.isEnabled()).toBe(false);
    await expect(svc.chat({ model: 'agent', messages: [{ role: 'user', content: 'x' }] })).rejects.toBeInstanceOf(
      LlmUnavailableError,
    );
    await expect(svc.embed(['x'])).rejects.toBeInstanceOf(LlmUnavailableError);
  });

  it('maps tool calls', async () => {
    const create = jest.fn().mockResolvedValue({
      choices: [
        {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{ id: 'c1', type: 'function', function: { name: 'list_goals', arguments: '{}' } }],
          },
        },
      ],
    });
    const svc = new LlmService();
    svc.setClient(mockClient(create));
    const r = await svc.chat({ model: 'agent', messages: [{ role: 'user', content: 'x' }] });
    expect(r).toEqual({ content: '', toolCalls: [{ id: 'c1', name: 'list_goals', arguments: '{}' }] });
  });

  describe('Anthropic agent provider', () => {
    beforeEach(() => {
      process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    });

    const tools = [
      {
        type: 'function' as const,
        function: { name: 'list_goals', description: 'Obiective', parameters: { type: 'object', properties: {} } },
      },
    ];

    it('routes agent → Anthropic and fast → Featherless when ANTHROPIC_API_KEY is set', async () => {
      const anthropicCreate = jest.fn().mockResolvedValue(anthropicMessage([{ type: 'text', text: 'Salut!' }]));
      const openaiCreate = jest.fn().mockResolvedValue(completion('{"injection":false}'));
      const svc = new LlmService();
      svc.setClient(mockClient(openaiCreate));
      svc.setAnthropicClient(mockAnthropic(anthropicCreate));

      const agent = await svc.chat({ model: 'agent', messages: [{ role: 'user', content: 'hi' }] });
      expect(agent).toEqual({ content: 'Salut!', toolCalls: [] });
      expect(anthropicCreate).toHaveBeenCalledTimes(1);
      expect(openaiCreate).not.toHaveBeenCalled();

      await svc.chat({ model: 'fast', messages: [{ role: 'user', content: 'hi' }] });
      expect(openaiCreate).toHaveBeenCalledTimes(1);
      expect(anthropicCreate).toHaveBeenCalledTimes(1);

      process.env.AGENT_PROVIDER = 'featherless';
      await svc.chat({ model: 'agent', messages: [{ role: 'user', content: 'hi' }] });
      expect(openaiCreate).toHaveBeenCalledTimes(2);
      expect(openaiCreate.mock.calls[1][0].model).toBe('deepseek-ai/DeepSeek-V4.1-Flash');
    });

    it('builds the Messages request: model, max_tokens, system, tools, thinking off, caching — no sampling params', async () => {
      const create = jest.fn().mockResolvedValue(
        anthropicMessage([{ type: 'tool_use', id: 'toolu_1', name: 'list_goals', input: {} }], 'tool_use'),
      );
      const svc = new LlmService();
      svc.setAnthropicClient(mockAnthropic(create));
      const r = await svc.chat({
        model: 'agent',
        messages: [
          { role: 'system', content: 'Ești asistentul băncii.' },
          { role: 'user', content: 'Ce obiective am?' },
        ],
        tools,
        temperature: 0.7,
      });
      expect(r).toEqual({ content: '', toolCalls: [{ id: 'toolu_1', name: 'list_goals', arguments: '{}' }] });

      const [body, opts] = create.mock.calls[0];
      expect(body).toEqual({
        model: 'claude-haiku-5-5',
        max_tokens: 4096,
        system: 'Ești asistentul băncii.',
        messages: [{ role: 'user', content: 'Ce obiective am?' }],
        tools: [{ name: 'list_goals', description: 'Obiective', input_schema: { type: 'object', properties: {} } }],
        thinking: { type: 'disabled' },
        cache_control: { type: 'ephemeral' },
      });
      expect(body).not.toHaveProperty('temperature');
      expect(body).not.toHaveProperty('top_p');
      expect(body).not.toHaveProperty('top_k');
      expect(body.system).not.toContain('/no_think');
      expect(opts.signal).toBeInstanceOf(AbortSignal);

      process.env.ANTHROPIC_AGENT_MODEL = 'claude-haiku-4-5';
      await svc.chat({ model: 'agent', messages: [{ role: 'user', content: 'x' }], maxTokens: 512 });
      expect(create.mock.calls[1][0]).toMatchObject({ model: 'claude-haiku-4-5', max_tokens: 512 });
    });

    it('final call without tools still declares replayed tools, with tool_choice none', async () => {
      const create = jest.fn().mockResolvedValue(anthropicMessage([{ type: 'text', text: 'Gata.' }]));
      const svc = new LlmService();
      svc.setAnthropicClient(mockAnthropic(create));
      await svc.chat({
        model: 'agent',
        messages: [
          { role: 'user', content: 'x' },
          { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'list_goals', arguments: '{}' } }] },
          { role: 'tool', tool_call_id: 'c1', content: '[]' },
        ],
      });
      const body = create.mock.calls[0][0];
      expect(body.tools).toEqual([{ name: 'list_goals', input_schema: { type: 'object', properties: {} } }]);
      expect(body.tool_choice).toEqual({ type: 'none' });
    });

    it('retries once on 429, times out, and maps failures and a missing key to LlmUnavailableError', async () => {
      process.env.FEATHERLESS_API_KEY = ''; // no failover target: Anthropic errors reach the caller
      const flaky = jest
        .fn()
        .mockRejectedValueOnce(Object.assign(new Error('rate_limit_error'), { status: 429 }))
        .mockResolvedValueOnce(anthropicMessage([{ type: 'text', text: 'ok' }]));
      const svc = new LlmService();
      svc.setAnthropicClient(mockAnthropic(flaky));
      expect((await svc.chat({ model: 'agent', messages: [{ role: 'user', content: 'x' }] })).content).toBe('ok');
      expect(flaky).toHaveBeenCalledTimes(2);

      const bad = jest.fn().mockRejectedValue(Object.assign(new Error('invalid_request_error'), { status: 400 }));
      svc.setAnthropicClient(mockAnthropic(bad));
      await expect(svc.chat({ model: 'agent', messages: [{ role: 'user', content: 'x' }] })).rejects.toBeInstanceOf(
        LlmUnavailableError,
      );
      expect(bad).toHaveBeenCalledTimes(1);

      svc.setAnthropicClient(mockAnthropic(jest.fn().mockImplementation(() => new Promise(() => undefined))));
      await expect(
        svc.chat({ model: 'agent', messages: [{ role: 'user', content: 'x' }], timeoutMs: 30 }),
      ).rejects.toThrow('timeout');

      process.env.ANTHROPIC_API_KEY = '';
      process.env.AGENT_PROVIDER = 'anthropic';
      await expect(svc.chat({ model: 'agent', messages: [{ role: 'user', content: 'x' }] })).rejects.toBeInstanceOf(
        LlmUnavailableError,
      );
    });

    describe('failover to the Featherless agent model', () => {
      let warn: jest.SpyInstance;
      beforeEach(() => {
        warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      });
      afterEach(() => warn.mockRestore());

      const messages: ChatMessage[] = [
        { role: 'system', content: 'Ești asistentul băncii.' },
        { role: 'user', content: 'Ce obiective am?' },
      ];

      it('Anthropic LlmUnavailableError → the same request is retried once on Featherless AGENT_MODEL, with a warning', async () => {
        const anthropicCreate = jest.fn().mockRejectedValue(Object.assign(new Error('overloaded'), { status: 400 }));
        const openaiCreate = jest.fn().mockResolvedValue({
          choices: [
            {
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [{ id: 'c1', type: 'function', function: { name: 'list_goals', arguments: '{}' } }],
              },
            },
          ],
        });
        const svc = new LlmService();
        svc.setAnthropicClient(mockAnthropic(anthropicCreate));
        svc.setClient(mockClient(openaiCreate));

        const r = await svc.chat({ model: 'agent', messages, tools });
        expect(r).toEqual({ content: '', toolCalls: [{ id: 'c1', name: 'list_goals', arguments: '{}' }] });
        expect(anthropicCreate).toHaveBeenCalledTimes(1);
        expect(openaiCreate).toHaveBeenCalledTimes(1);
        const body = openaiCreate.mock.calls[0][0];
        expect(body.model).toBe('deepseek-ai/DeepSeek-V4.1-Flash');
        expect(body.tools).toEqual(tools);
        expect(body.messages[1]).toEqual({ role: 'user', content: 'Ce obiective am?' });
        expect(body.max_tokens).toBe(1024);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('failing over to featherless deepseek-ai/DeepSeek-V4.1-Flash'));
      });

      it('also covers timeouts and a missing ANTHROPIC_API_KEY', async () => {
        const openaiCreate = jest.fn().mockResolvedValue(completion('din rezervă'));
        const svc = new LlmService();
        svc.setClient(mockClient(openaiCreate));
        svc.setAnthropicClient(mockAnthropic(jest.fn().mockImplementation(() => new Promise(() => undefined))));
        expect((await svc.chat({ model: 'agent', messages, timeoutMs: 30 })).content).toBe('din rezervă');

        process.env.ANTHROPIC_API_KEY = '';
        process.env.AGENT_PROVIDER = 'anthropic';
        expect((await svc.chat({ model: 'agent', messages })).content).toBe('din rezervă');
        expect(openaiCreate).toHaveBeenCalledTimes(2);
      });

      it('both providers failing → LlmUnavailableError (agent goes degraded)', async () => {
        const anthropicCreate = jest.fn().mockRejectedValue(Object.assign(new Error('api_error'), { status: 400 }));
        const openaiCreate = jest.fn().mockRejectedValue(Object.assign(new Error('Unauthorized'), { status: 401 }));
        const svc = new LlmService();
        svc.setAnthropicClient(mockAnthropic(anthropicCreate));
        svc.setClient(mockClient(openaiCreate));
        await expect(svc.chat({ model: 'agent', messages })).rejects.toThrow(/LLM chat indisponibil \(status 401\)/);
        expect(anthropicCreate).toHaveBeenCalledTimes(1);
        expect(openaiCreate).toHaveBeenCalledTimes(1);
      });

      it('no FEATHERLESS_API_KEY → no failover: the Anthropic error reaches the caller', async () => {
        process.env.FEATHERLESS_API_KEY = '';
        const anthropicCreate = jest.fn().mockRejectedValue(Object.assign(new Error('api_error'), { status: 400 }));
        const openaiCreate = jest.fn();
        const svc = new LlmService();
        svc.setAnthropicClient(mockAnthropic(anthropicCreate));
        svc.setClient(mockClient(openaiCreate));
        await expect(svc.chat({ model: 'agent', messages })).rejects.toThrow(/LLM anthropic chat indisponibil \(status 400\)/);
        expect(openaiCreate).not.toHaveBeenCalled();
        expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('failing over'));
      });
    });

    it('describeRouting names provider and model for agent, fast and embeddings', () => {
      expect(describeRouting(config()).summary).toBe(
        'LLM routing: agent → anthropic claude-haiku-5-5 | fast → featherless Qwen/Qwen3.8-27B | ' +
          'embeddings → featherless Qwen/Qwen3-Embedding-4B (1024 dims)',
      );
      process.env.ANTHROPIC_API_KEY = '';
      const fallback = describeRouting(config());
      expect(fallback.summary).toContain('agent → featherless deepseek-ai/DeepSeek-V4.1-Flash');
      expect(fallback.warnings).toEqual([]);

      process.env.AGENT_PROVIDER = 'anthropic';
      expect(describeRouting(config()).warnings).toEqual([
        'AGENT_PROVIDER=anthropic but ANTHROPIC_API_KEY is empty: every agent call will fail over to featherless deepseek-ai/DeepSeek-V4.1-Flash',
      ]);
    });
  });
});
