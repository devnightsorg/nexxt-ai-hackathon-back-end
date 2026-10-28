export interface AppConfig {
  DATABASE_URL: string;
  TEST_DATABASE_URL: string;
  PORT: number;
  JWT_SECRET: string;
  JWT_EXPIRES_IN: string;
  FEATHERLESS_API_KEY: string;
  FEATHERLESS_BASE_URL: string;
  ANTHROPIC_API_KEY: string;
  /** Claude model used for the agent when AGENT_PROVIDER is 'anthropic'. */
  ANTHROPIC_AGENT_MODEL: string;
  /** Who serves the main agent; the fast model and embeddings always use Featherless. */
  AGENT_PROVIDER: AgentProvider;
  /** Featherless agent model (used when AGENT_PROVIDER is 'featherless'). */
  AGENT_MODEL: string;
  FAST_MODEL: string;
  EMBEDDING_MODEL: string;
  AGENT_THINKING: boolean;
  AGENT_MAX_ITERATIONS: number;
  AGENT_TIMEOUT_MS: number;
  FAST_TIMEOUT_MS: number;
  EMBED_TIMEOUT_MS: number;
  POLICY_MAX_PER_ACTION: number;
  POLICY_DAILY_LIMIT: number;
  ACTION_TTL_MINUTES: number;
  INTEREST_TAX_RATE: number;
  CORS_ORIGIN: string;
  KNOWLEDGE_DIR: string;
  SEED_ON_START: boolean;
  THROTTLE_LIMIT: number;
  AGENT_THROTTLE_LIMIT: number;
}

export type AgentProvider = 'anthropic' | 'featherless';

type Env = Record<string, string | undefined>;

const TRUE_VALUES = ['true', '1', 'yes'];
const FALSE_VALUES = ['false', '0', 'no'];

function raw(env: Env, name: string): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

function str(env: Env, name: string, fallback: string): string {
  return raw(env, name) ?? fallback;
}

function num(env: Env, name: string, fallback: number): number {
  const value = raw(env, name);
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`Config ${name} must be a number, got "${value}"`);
  return parsed;
}

function bool(env: Env, name: string, fallback: boolean): boolean {
  const value = raw(env, name)?.toLowerCase();
  if (value === undefined) return fallback;
  if (TRUE_VALUES.includes(value)) return true;
  if (FALSE_VALUES.includes(value)) return false;
  throw new Error(`Config ${name} must be true or false, got "${value}"`);
}

/** Explicit AGENT_PROVIDER wins; otherwise Anthropic when ANTHROPIC_API_KEY is set, else Featherless. */
function agentProvider(env: Env): AgentProvider {
  const value = raw(env, 'AGENT_PROVIDER')?.toLowerCase();
  if (value === undefined) return raw(env, 'ANTHROPIC_API_KEY') ? 'anthropic' : 'featherless';
  if (value === 'anthropic' || value === 'featherless') return value;
  throw new Error(`Config AGENT_PROVIDER must be anthropic or featherless, got "${value}"`);
}

/** Reads the environment on every call (no caching), so tests can change values per app instance. */
export function config(env: Env = process.env): AppConfig {
  return {
    DATABASE_URL: str(env, 'DATABASE_URL', 'postgresql://raiffeisen:raiffeisen@localhost:5433/raiffeisen'),
    TEST_DATABASE_URL: str(env, 'TEST_DATABASE_URL', 'postgresql://raiffeisen:raiffeisen@localhost:5433/raiffeisen_test'),
    PORT: num(env, 'PORT', 3000),
    JWT_SECRET: str(env, 'JWT_SECRET', 'dev-only-change-me'),
    JWT_EXPIRES_IN: str(env, 'JWT_EXPIRES_IN', '2h'),
    FEATHERLESS_API_KEY: str(env, 'FEATHERLESS_API_KEY', ''),
    FEATHERLESS_BASE_URL: str(env, 'FEATHERLESS_BASE_URL', 'https://api.featherless.ai/v1'),
    ANTHROPIC_API_KEY: str(env, 'ANTHROPIC_API_KEY', ''),
    ANTHROPIC_AGENT_MODEL: str(env, 'ANTHROPIC_AGENT_MODEL', 'claude-haiku-5-5'),
    AGENT_PROVIDER: agentProvider(env),
    AGENT_MODEL: str(env, 'AGENT_MODEL', 'Qwen/Qwen3-32B'),
    FAST_MODEL: str(env, 'FAST_MODEL', 'Qwen/Qwen3.8-27B'),
    EMBEDDING_MODEL: str(env, 'EMBEDDING_MODEL', 'Qwen/Qwen3-Embedding-4B'),
    AGENT_THINKING: bool(env, 'AGENT_THINKING', false),
    AGENT_MAX_ITERATIONS: num(env, 'AGENT_MAX_ITERATIONS', 6),
    AGENT_TIMEOUT_MS: num(env, 'AGENT_TIMEOUT_MS', 60000),
    FAST_TIMEOUT_MS: num(env, 'FAST_TIMEOUT_MS', 15000),
    EMBED_TIMEOUT_MS: num(env, 'EMBED_TIMEOUT_MS', 30000),
    POLICY_MAX_PER_ACTION: num(env, 'POLICY_MAX_PER_ACTION', 50000),
    POLICY_DAILY_LIMIT: num(env, 'POLICY_DAILY_LIMIT', 100000),
    ACTION_TTL_MINUTES: num(env, 'ACTION_TTL_MINUTES', 15),
    INTEREST_TAX_RATE: num(env, 'INTEREST_TAX_RATE', 0.1),
    CORS_ORIGIN: str(env, 'CORS_ORIGIN', '*'),
    KNOWLEDGE_DIR: str(env, 'KNOWLEDGE_DIR', 'seed/knowledge'),
    SEED_ON_START: bool(env, 'SEED_ON_START', true),
    THROTTLE_LIMIT: num(env, 'THROTTLE_LIMIT', 120),
    AGENT_THROTTLE_LIMIT: num(env, 'AGENT_THROTTLE_LIMIT', 20),
  };
}
