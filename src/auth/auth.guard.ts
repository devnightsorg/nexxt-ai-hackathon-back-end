import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { config } from '../config/config';
import { ApiKeysService } from './api-keys.service';
import { ADMIN_ONLY_KEY, AuthedRequest, IS_PUBLIC_KEY, REQUIRED_SCOPES_KEY, USER_ONLY_KEY } from './decorators';
import { Principal, Scope, SCOPES } from './principal';

export const AUTH_REQUIRED = 'Autentificare necesară';

interface JwtPayload {
  sub: string;
  role: 'customer' | 'admin';
}

/** Global guard: resolves the Principal from the Bearer token and enforces scope / user-only / admin-only rules. */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
    private readonly apiKeys: ApiKeysService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (ctx.getType() !== 'http') return true;
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets)) return true;

    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const principal = await this.authenticate(req);
    req.principal = principal;

    if (this.reflector.getAllAndOverride<boolean>(USER_ONLY_KEY, targets) && principal.kind !== 'user') {
      throw new ForbiddenException('Operațiune permisă doar utilizatorului autentificat direct');
    }
    if (this.reflector.getAllAndOverride<boolean>(ADMIN_ONLY_KEY, targets) && principal.role !== 'admin') {
      throw new ForbiddenException('Operațiune permisă doar administratorilor');
    }
    const required = this.reflector.getAllAndMerge<Scope[]>(REQUIRED_SCOPES_KEY, targets) ?? [];
    const missing = required.find((s) => !principal.scopes.includes(s));
    if (missing) throw new ForbiddenException(`Lipsește permisiunea ${missing}`);
    return true;
  }

  private async authenticate(req: AuthedRequest): Promise<Principal> {
    const header = req.headers.authorization;
    const match = typeof header === 'string' ? /^Bearer\s+(\S+)$/i.exec(header.trim()) : null;
    if (!match) throw new UnauthorizedException(AUTH_REQUIRED);
    const token = match[1];

    if (token.startsWith('rk_')) {
      const principal = await this.apiKeys.authenticate(token);
      if (!principal) throw new UnauthorizedException(AUTH_REQUIRED);
      return principal;
    }

    let payload: JwtPayload;
    try {
      payload = await this.jwt.verifyAsync<JwtPayload>(token, { secret: config().JWT_SECRET });
    } catch {
      throw new UnauthorizedException(AUTH_REQUIRED);
    }
    if (typeof payload?.sub !== 'string' || (payload.role !== 'customer' && payload.role !== 'admin')) {
      throw new UnauthorizedException(AUTH_REQUIRED);
    }
    return { userId: payload.sub, role: payload.role, kind: 'user', scopes: [...SCOPES], maxAmountPerAction: null };
  }
}
