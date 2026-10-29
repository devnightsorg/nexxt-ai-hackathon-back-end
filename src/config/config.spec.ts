import { config } from './config';

describe('config', () => {
  it('returns the documented defaults for an empty environment', () => {
    expect(config({})).toEqual({
      DATABASE_URL: 'postgresql://raiffeisen:raiffeisen@localhost:5433/raiffeisen',
      TEST_DATABASE_URL: 'postgresql://raiffeisen:raiffeisen@localhost:5433/raiffeisen_test',
      PORT: 3000,
      JWT_SECRET: 'dev-only-change-me',
      JWT_EXPIRES_IN: '2h',
      FEATHERLESS_API_KEY: '',
      FEATHERLESS_BASE_URL: 'https://api.featherless.ai/v1',
      ANTHROPIC_API_KEY: '',
      ANTHROPIC_AGENT_MODEL: 'claude-haiku-5-5',
      AGENT_PROVIDER: 'featherless',
      AGENT_MODEL: 'deepseek-ai/DeepSeek-V4.1-Flash',
      FAST_MODEL: 'Qwen/Qwen3.8-27B',
      EMBEDDING_MODEL: 'Qwen/Qwen3-Embedding-4B',
      AGENT_THINKING: false,
      AGENT_MAX_ITERATIONS: 6,
      AGENT_TIMEOUT_MS: 60000,
      FAST_TIMEOUT_MS: 15000,
      EMBED_TIMEOUT_MS: 30000,
      POLICY_MAX_PER_ACTION: 50000,
      POLICY_DAILY_LIMIT: 100000,
      ACTION_TTL_MINUTES: 15,
      INTEREST_TAX_RATE: 0.1,
      CORS_ORIGIN: '*',
      PUBLIC_URL: 'https://raiffeisen.desepticon.qzz.io',
      KNOWLEDGE_DIR: 'seed/knowledge',
      SEED_ON_START: true,
      THROTTLE_LIMIT: 120,
      AGENT_THROTTLE_LIMIT: 20,
    });
  });

  it('parses numbers and booleans from the environment', () => {
    const c = config({ PORT: '8080', INTEREST_TAX_RATE: '0.16', AGENT_THINKING: 'true', SEED_ON_START: '0' });
    expect(c.PORT).toBe(8080);
    expect(c.INTEREST_TAX_RATE).toBe(0.16);
    expect(c.AGENT_THINKING).toBe(true);
    expect(c.SEED_ON_START).toBe(false);
  });

  it('treats empty values as unset', () =>
    expect(config({ PORT: '', AGENT_MODEL: '' })).toMatchObject({ PORT: 3000, AGENT_MODEL: 'deepseek-ai/DeepSeek-V4.1-Flash' }));

  it('rejects malformed numbers, booleans and providers', () => {
    expect(() => config({ PORT: 'abc' })).toThrow('PORT');
    expect(() => config({ AGENT_THINKING: 'maybe' })).toThrow('AGENT_THINKING');
    expect(() => config({ AGENT_PROVIDER: 'openai' })).toThrow('AGENT_PROVIDER');
  });

  it('defaults AGENT_PROVIDER to anthropic only when ANTHROPIC_API_KEY is set; an explicit value wins', () => {
    expect(config({ ANTHROPIC_API_KEY: 'sk-ant-x' }).AGENT_PROVIDER).toBe('anthropic');
    expect(config({ ANTHROPIC_API_KEY: '  ' }).AGENT_PROVIDER).toBe('featherless');
    expect(config({ ANTHROPIC_API_KEY: 'sk-ant-x', AGENT_PROVIDER: 'Featherless' }).AGENT_PROVIDER).toBe('featherless');
    expect(config({ AGENT_PROVIDER: 'anthropic' }).AGENT_PROVIDER).toBe('anthropic');
  });

  it('reads process.env on every call (no caching)', () => {
    const before = process.env.THROTTLE_LIMIT;
    try {
      process.env.THROTTLE_LIMIT = '7';
      expect(config().THROTTLE_LIMIT).toBe(7);
      process.env.THROTTLE_LIMIT = '9';
      expect(config().THROTTLE_LIMIT).toBe(9);
    } finally {
      if (before === undefined) delete process.env.THROTTLE_LIMIT;
      else process.env.THROTTLE_LIMIT = before;
    }
  });
});
