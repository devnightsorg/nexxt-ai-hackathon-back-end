import { INestApplication } from '@nestjs/common';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { config } from '../src/config/config';
import { PrismaService } from '../src/prisma/prisma.service';
import { demoApiKey } from '../src/seed/demo-keys';
import { DEMO_PASSWORD } from '../src/seed/personas';
import { SeedService } from '../src/seed/seed.service';
import { StatsService } from '../src/banking/stats.service';
import { createTestApp } from './utils/app';
import { loginAs } from './utils/factory';
import { FakeLlmService } from './utils/fake-llm';
import { resetDb } from './utils/reset-db';

type ToolRes = { isError?: boolean; content: { type: string; text: string }[] };

const ANDREI = 'andrei.popescu@demo.ro';
const EXTERNAL_IBAN = 'RO49AAAA1B31007593840000';

describe('mcp', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let llm: FakeLlmService;
  let baseUrl: string;
  let currentAccountId: string;
  let depositSlug: string;
  const apiKey = () => demoApiKey(config().JWT_SECRET, 'andrei');

  async function connect(key: string): Promise<Client> {
    const client = new Client({ name: 'e2e', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${key}` } },
    });
    await client.connect(transport);
    return client;
  }

  async function callTool(name: string, args: Record<string, unknown> = {}, key = apiKey()): Promise<ToolRes> {
    const client = await connect(key);
    try {
      return (await client.callTool({ name, arguments: args })) as ToolRes;
    } finally {
      await client.close();
    }
  }

  beforeAll(async () => {
    ({ app, prisma, llm } = await createTestApp());
    await resetDb(prisma);
    await app.get(SeedService).run({ ingestKnowledge: false });
    await app.listen(0);
    const { port } = app.getHttpServer().address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
    const user = await prisma.user.findUniqueOrThrow({ where: { email: ANDREI } });
    currentAccountId = (await prisma.account.findFirstOrThrow({ where: { userId: user.id, type: 'current' } })).id;
    depositSlug = (await prisma.product.findFirstOrThrow({ where: { category: 'term_deposit' } })).slug;
  });

  beforeEach(() => llm.reset());

  afterAll(async () => {
    await app.close();
  });

  it('lists the 13 tools and returns andrei’s financial snapshot', async () => {
    const client = await connect(apiKey());
    try {
      const { tools } = await client.listTools();
      expect(tools).toHaveLength(13);
      expect(tools.map((t) => t.name)).toContain('get_financial_snapshot');

      const res = (await client.callTool({ name: 'get_financial_snapshot', arguments: {} })) as ToolRes;
      expect(res.isError).toBeFalsy();
      const snapshot = JSON.parse(res.content[0].text);
      const user = await prisma.user.findUniqueOrThrow({ where: { email: ANDREI } });
      const expected = JSON.parse(JSON.stringify(await app.get(StatsService).snapshot(user.id)));
      expect({ ...snapshot, asOf: undefined }).toEqual({ ...expected, asOf: undefined });

      const audit = await prisma.auditLog.findFirst({ where: { action: 'mcp.tool_call' }, orderBy: { ts: 'desc' } });
      expect(audit).not.toBeNull();
    } finally {
      await client.close();
    }
  });

  it('ask_raiffeisen_agent with scripted FakeLlm returns an AgentReply JSON', async () => {
    llm.queue({ content: 'Salut! Te pot ajuta cu economiile.', toolCalls: [] });
    const res = await callTool('ask_raiffeisen_agent', { message: 'Cum pot economisi mai mult?' });
    expect(res.isError).toBeFalsy();
    const reply = JSON.parse(res.content[0].text);
    expect(reply.reply).toBe('Salut! Te pot ajuta cu economiile.');
    expect(reply.degraded).toBe(false);
    expect(Array.isArray(reply.recommendations)).toBe(true);
    expect(Array.isArray(reply.proposals)).toBe(true);
  });

  it('propose_action open_product 1 000 → pending; confirm_action → executed; 6 000 → isError API_KEY_LIMIT', async () => {
    const proposed = await callTool('propose_action', {
      type: 'open_product',
      productSlug: depositSlug,
      fromAccountId: currentAccountId,
      amount: 1000,
      termMonths: 12,
    });
    expect(proposed.isError).toBeFalsy();
    const proposal = JSON.parse(proposed.content[0].text);
    expect(proposal.status).toBe('pending');

    const status = await callTool('get_action_status', { proposalId: proposal.id });
    expect(JSON.parse(status.content[0].text).status).toBe('pending');

    const confirmed = await callTool('confirm_action', { proposalId: proposal.id });
    expect(confirmed.isError).toBeFalsy();
    expect(JSON.parse(confirmed.content[0].text).status).toBe('executed');

    const big = await callTool('propose_action', {
      type: 'open_product',
      productSlug: depositSlug,
      fromAccountId: currentAccountId,
      amount: 6000,
      termMonths: 12,
    });
    expect(big.isError).toBe(true);
    expect(big.content[0].text).toContain('API_KEY_LIMIT');
  });

  it('propose_action transfer to external IBAN → isError EXTERNAL_TRANSFER_NOT_ALLOWED_FOR_AGENT', async () => {
    const res = await callTool('propose_action', {
      type: 'transfer',
      fromAccountId: currentAccountId,
      toIban: EXTERNAL_IBAN,
      beneficiaryName: 'Proprietar',
      amount: 100,
    });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('EXTERNAL_TRANSFER_NOT_ALLOWED_FOR_AGENT');
  });

  it('key without offers:read → get_personalised_offers isError mentioning offers:read', async () => {
    const token = await loginAs(app, ANDREI, DEMO_PASSWORD);
    const created = await request(app.getHttpServer())
      .post('/api-keys')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'limited', scopes: ['accounts:read'] })
      .expect(201);
    const res = await callTool('get_personalised_offers', {}, created.body.key);
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('offers:read');
  });

  it('no Authorization → 401; GET /mcp → 405', async () => {
    await request(app.getHttpServer()).post('/mcp').send({}).expect(401);
    const res = await request(app.getHttpServer()).get('/mcp').set('Authorization', `Bearer ${apiKey()}`).expect(405);
    expect(res.body.jsonrpc).toBe('2.0');
  });
});
