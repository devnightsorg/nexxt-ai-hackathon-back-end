import { LlmClient, LlmService, LlmUnavailableError } from './llm.service';

function completion(content: string) {
  return { choices: [{ message: { role: 'assistant', content, tool_calls: undefined } }] };
}

function mockClient(create: jest.Mock): LlmClient {
  return { chat: { completions: { create } }, embeddings: { create: jest.fn() } };
}

describe('LlmService', () => {
  const saved = { ...process.env };
  beforeEach(() => {
    process.env.FEATHERLESS_API_KEY = 'test-key';
    process.env.AGENT_THINKING = 'false';
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
});
