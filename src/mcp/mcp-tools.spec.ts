import { NotFoundException } from '@nestjs/common';
import { PolicyDeniedException } from '../actions/policy';
import { Principal } from '../auth/principal';
import { MCP_INTERNAL_ERROR, MCP_TOOLS, McpDeps, runMcpTool, toolErrorText } from './mcp-tools';

const principal = (scopes: Principal['scopes']): Principal => ({
  userId: 'u1',
  role: 'customer',
  kind: 'api_key',
  apiKeyId: 'k1',
  scopes,
  maxAmountPerAction: 5000,
});

function fakeDeps(): { deps: McpDeps; audited: unknown[] } {
  const audited: unknown[] = [];
  const deps = {
    offers: { list: jest.fn().mockResolvedValue([{ id: 'o1' }]) },
    audit: { record: jest.fn(async (e: unknown) => void audited.push(e)) },
  } as unknown as McpDeps;
  return { deps, audited };
}

const tool = (name: string) => MCP_TOOLS.find((t) => t.name === name)!;

describe('mcp tools', () => {
  it('exposes the 12 tools', () => {
    expect(MCP_TOOLS.map((t) => t.name).sort()).toEqual(
      [
        'ask_raiffeisen_agent',
        'confirm_action',
        'create_goal',
        'get_action_status',
        'get_financial_snapshot',
        'get_personalised_offers',
        'get_profile_summary',
        'list_goals',
        'list_products',
        'propose_action',
        'search_knowledge_base',
        'simulate_product',
      ].sort(),
    );
  });

  it('toolErrorText joins policy violations and keeps plain messages', () => {
    expect(toolErrorText(new PolicyDeniedException(['API_KEY_LIMIT']))).toBe(
      'Acțiunea nu respectă regulile băncii: API_KEY_LIMIT',
    );
    expect(toolErrorText(new NotFoundException('Produsul nu există'))).toBe('Produsul nu există');
    expect(toolErrorText(new Error('boom'))).toBe(MCP_INTERNAL_ERROR);
  });

  it('missing scope → isError mentioning the scope, audited as blocked', async () => {
    const { deps, audited } = fakeDeps();
    const r = await runMcpTool(tool('get_personalised_offers'), deps, principal(['accounts:read']), {});
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('offers:read');
    expect(audited[0]).toMatchObject({ action: 'mcp.tool_call', verdict: 'blocked', details: { ok: false, apiKeyId: 'k1' } });
  });

  it('success → JSON text content, audited as allowed', async () => {
    const { deps, audited } = fakeDeps();
    const r = await runMcpTool(tool('get_personalised_offers'), deps, principal(['offers:read']), {});
    expect(r.isError).toBeUndefined();
    expect(JSON.parse(r.content[0].text)).toEqual([{ id: 'o1' }]);
    expect(audited[0]).toMatchObject({ details: { tool: 'get_personalised_offers', ok: true } });
  });
});
