import { localhostHostValidation } from '@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express, { type Express } from 'express';
import { createAdminRouter } from './admin.js';
import { authenticateRequest } from './auth.js';
import type { AppContext } from './context.js';
import { createMcpServer } from './mcp.js';

const LOCAL_HOSTS = ['127.0.0.1', 'localhost', '::1'];

export function createApp(ctx: AppContext): Express {
  const app = express();
  app.disable('x-powered-by');
  // DNS-rebinding protection from the MCP SDK when bound to localhost. No CORS headers are sent,
  // so browsers on other origins cannot call the gateway.
  if (LOCAL_HOSTS.includes(ctx.config.host)) app.use(localhostHostValidation());

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', bank_adapter: ctx.bank.kind });
  });

  app.use('/admin', createAdminRouter(ctx));

  // Stateless Streamable HTTP: no server-initiated SSE stream, no sessions.
  app.get('/mcp', (_req, res) => {
    res.status(405).set('allow', 'POST').json({ error: 'Method not allowed' });
  });
  app.delete('/mcp', (_req, res) => {
    res.status(405).set('allow', 'POST').json({ error: 'Method not allowed' });
  });

  // Raw body is kept so the request signature can cover the exact bytes received.
  app.post('/mcp', express.raw({ type: () => true, limit: '256kb' }), async (req, res) => {
    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const auth = authenticateRequest(
      { method: req.method, path: req.originalUrl, headers: req.headers, rawBody },
      {
        registry: ctx.registry,
        trustedIssuers: () => ctx.issuer.trustedIssuers(),
        nonces: ctx.nonces,
        clockSkewSec: ctx.config.clockSkewSec,
        now: ctx.now,
      },
    );
    if (!auth.ok) {
      const ev = ctx.audit.record({
        event: 'auth.denied',
        result: 'deny',
        agent_id: auth.agent_id,
        owner_id: auth.owner_id,
        error_code: auth.code,
        reason: auth.reason,
      });
      const httpStatus = auth.code === 'AGENT_REVOKED' || auth.code === 'AGENT_NOT_APPROVED' ? 403 : 401;
      res.status(httpStatus).json({ status: 'denied', error_code: auth.code, reason: auth.reason, audit_id: ev.audit_id });
      return;
    }

    let parsedBody: unknown;
    try {
      parsedBody = JSON.parse(rawBody.toString('utf8'));
    } catch {
      res.status(400).json({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null });
      return;
    }

    const server = createMcpServer(ctx.gateway, auth.principal);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, parsedBody);
    } catch (err) {
      console.error('MCP request failed:', err instanceof Error ? err.message : err);
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
      }
    }
  });

  return app;
}
