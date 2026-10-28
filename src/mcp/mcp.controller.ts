import { Controller, Delete, Get, Post, Req, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Request, Response } from 'express';
import { ActionsService } from '../actions/actions.service';
import { AgentService } from '../agent/agent.service';
import { CurrentPrincipal } from '../auth/decorators';
import { Principal } from '../auth/principal';
import { StatsService } from '../banking/stats.service';
import { GoalsService } from '../goals/goals.service';
import { KnowledgeService } from '../knowledge/knowledge.service';
import { OffersService } from '../offers/offers.service';
import { ProductsService } from '../products/products.service';
import { AuditService } from '../security/audit/audit.service';
import { AGENT_THROTTLE } from '../security/principal-throttler.guard';
import { UsersService } from '../users/users.service';
import { MoneyMapService } from '../money-map/money-map.service';
import { McpDeps, registerMcpTools } from './mcp-tools';

export const MCP_METHOD_NOT_ALLOWED = {
  jsonrpc: '2.0',
  error: { code: -32000, message: 'Metodă nepermisă: serverul MCP este stateless, folosește POST /mcp' },
  id: null,
};

/** Private MCP server (stateless Streamable HTTP) for customer-side agents; auth via `rk_` API key or JWT. */
@ApiTags('mcp')
@ApiBearerAuth()
@Throttle(AGENT_THROTTLE)
@Controller('mcp')
export class McpController {
  private readonly deps: McpDeps;

  constructor(
    users: UsersService,
    stats: StatsService,
    goals: GoalsService,
    offers: OffersService,
    knowledge: KnowledgeService,
    moneyMap: MoneyMapService,
    products: ProductsService,
    agent: AgentService,
    actions: ActionsService,
    audit: AuditService,
  ) {
    this.deps = { users, stats, goals, offers, knowledge, moneyMap, products, agent, actions, audit };
  }

  @Post()
  @ApiOkResponse({ description: 'JSON-RPC response (MCP Streamable HTTP, JSON mode)' })
  async handle(@CurrentPrincipal() p: Principal, @Req() req: Request, @Res() res: Response): Promise<void> {
    const server = new McpServer({ name: 'raiffeisen-agent', version: '1.0.0' });
    registerMcpTools(server, p, this.deps);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  }

  @Get()
  get(@Res() res: Response): void {
    res.status(405).json(MCP_METHOD_NOT_ALLOWED);
  }

  @Delete()
  remove(@Res() res: Response): void {
    res.status(405).json(MCP_METHOD_NOT_ALLOWED);
  }
}
