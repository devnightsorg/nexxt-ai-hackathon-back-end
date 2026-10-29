import { Body, Controller, Get, HttpCode, Post, Query, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { randomBytes } from 'node:crypto';
import type { Response } from 'express';
import { Public } from '../auth/decorators';
import { config } from '../config/config';
import { clientIdFor, MandatesService } from './mandates.service';

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

/**
 * Just enough OAuth 2.1 for claude.ai custom connectors (demo flow, no real security): discovery metadata,
 * dynamic client registration without a client store, an authorize step that hands the browser to the PWA's
 * mandate screen, and a token step that swaps the one-time code for the mandate's API key. PKCE is not verified.
 */
@ApiExcludeController()
@Public()
@Controller()
export class OauthController {
  constructor(private readonly mandates: MandatesService) {}

  @Get(['.well-known/oauth-protected-resource', '.well-known/oauth-protected-resource/mcp'])
  protectedResource(): Record<string, unknown> {
    const base = config().PUBLIC_URL;
    return {
      resource: `${base}/mcp`,
      authorization_servers: [base],
      bearer_methods_supported: ['header'],
      resource_name: 'Raiffeisen Bank România',
    };
  }

  @Get(['.well-known/oauth-authorization-server', '.well-known/openid-configuration'])
  authorizationServer(): Record<string, unknown> {
    const base = config().PUBLIC_URL;
    return {
      issuer: base,
      authorization_endpoint: `${base}/oauth/authorize`,
      token_endpoint: `${base}/oauth/token`,
      registration_endpoint: `${base}/oauth/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: ['mandate'],
    };
  }

  @Post('oauth/register')
  @HttpCode(201)
  register(@Body() body: Record<string, unknown>): Record<string, unknown> {
    const clientName = str(body?.client_name) ?? 'Agent AI';
    return {
      client_id: clientIdFor(clientName),
      client_id_issued_at: Math.floor(Date.now() / 1000),
      client_name: clientName,
      redirect_uris: Array.isArray(body?.redirect_uris) ? body.redirect_uris : [],
      grant_types: ['authorization_code'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    };
  }

  /** The customer reviews and signs the mandate in the PWA; it posts to /mandates/authorize and redirects back. */
  @Get('oauth/authorize')
  authorize(@Query() q: Record<string, unknown>, @Res() res: Response): void {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(q ?? {})) if (typeof v === 'string') params.set(k, v);
    res.redirect(302, `${config().PUBLIC_URL}/connect/authorize?${params.toString()}`);
  }

  @Post('oauth/token')
  async token(@Body() body: Record<string, unknown>, @Res() res: Response): Promise<void> {
    res.setHeader('Cache-Control', 'no-store');
    if (str(body?.grant_type) !== 'authorization_code') {
      res.status(400).json({ error: 'unsupported_grant_type' });
      return;
    }
    const code = str(body?.code);
    const issued = code ? await this.mandates.exchangeCode(code, str(body?.redirect_uri)) : null;
    if (!issued) {
      res.status(400).json({ error: 'invalid_grant', error_description: 'Codul de autorizare este invalid sau a expirat' });
      return;
    }
    res.status(200).json({
      access_token: issued.accessToken,
      token_type: 'Bearer',
      expires_in: issued.expiresIn,
      scope: 'mandate',
      // Unused by this server; some clients expect one. Refresh is not supported: reconnect signs a new mandate.
      refresh_token: randomBytes(24).toString('base64url'),
    });
  }
}
