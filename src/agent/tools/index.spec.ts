import { Principal, SCOPES } from '../../auth/principal';
import { AGENT_TOOLS, toToolDefs } from './index';

const EXPECTED: Record<string, string | null> = {
  get_financial_snapshot: 'accounts:read',
  get_accounts: 'accounts:read',
  get_transactions: 'transactions:read',
  get_spending_stats: 'transactions:read',
  list_goals: 'goals:read',
  create_goal: 'goals:write',
  list_products: null,
  get_product: null,
  search_knowledge_base: null,
  simulate_product: null,
  get_personalised_offers: 'offers:read',
  recommend_product: 'offers:read',
  credit_precheck: 'profile:read',
  propose_transfer: 'actions:propose',
  propose_open_product: 'actions:propose',
};

const principal = (scopes: Principal['scopes']): Principal => ({
  userId: 'u1',
  role: 'customer',
  kind: 'api_key',
  apiKeyId: 'k1',
  scopes,
  maxAmountPerAction: null,
});

describe('agent tool registry', () => {
  it('every tool has a unique name, a description and a JSON schema of type object', () => {
    const names = AGENT_TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    expect(Object.fromEntries(AGENT_TOOLS.map((t) => [t.name, t.scope]))).toEqual(EXPECTED);
    for (const def of toToolDefs(AGENT_TOOLS)) {
      expect(def.type).toBe('function');
      const fn = (def as { function: { name: string; description?: string; parameters?: Record<string, unknown> } }).function;
      expect(fn.description?.length).toBeGreaterThan(10);
      expect(fn.parameters?.type).toBe('object');
      expect(fn.parameters?.$schema).toBeUndefined();
    }
  });

  it('toToolDefs filters out tools whose scope the principal lacks', () => {
    const names = (p: Principal) =>
      toToolDefs(AGENT_TOOLS, p).map((d) => (d as { function: { name: string } }).function.name);
    const readOnly = names(principal(['agent:chat', 'accounts:read']));
    expect(readOnly).toEqual(
      expect.arrayContaining(['get_financial_snapshot', 'get_accounts', 'list_products', 'search_knowledge_base']),
    );
    expect(readOnly).not.toContain('propose_transfer');
    expect(readOnly).not.toContain('get_transactions');
    expect(readOnly).not.toContain('create_goal');
    expect(names(principal([...SCOPES]))).toHaveLength(AGENT_TOOLS.length);
  });

  it('schemas reject bad amounts and accept valid ones', () => {
    const transfer = AGENT_TOOLS.find((t) => t.name === 'propose_transfer')!;
    expect(transfer.schema.safeParse({ fromAccountId: 'a', toAccountId: 'b', amount: 10.5, reason: 'x' }).success).toBe(true);
    expect(transfer.schema.safeParse({ fromAccountId: 'a', amount: -1, reason: 'x' }).success).toBe(false);
    expect(transfer.schema.safeParse({ fromAccountId: 'a', amount: 1.234, reason: 'x' }).success).toBe(false);
    const tx = AGENT_TOOLS.find((t) => t.name === 'get_transactions')!;
    expect(tx.schema.safeParse({ limit: 51 }).success).toBe(false);
  });
});
