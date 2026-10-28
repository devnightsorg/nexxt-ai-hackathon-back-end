import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import type { Request } from 'express';
import { Principal, Scope } from './principal';

export const IS_PUBLIC_KEY = 'auth:isPublic';
export const REQUIRED_SCOPES_KEY = 'auth:requiredScopes';
export const USER_ONLY_KEY = 'auth:userOnly';
export const ADMIN_ONLY_KEY = 'auth:adminOnly';

export type AuthedRequest = Request & { principal?: Principal };

/** No authentication required. */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

/** Principal must hold every listed scope (JWT users hold all scopes). */
export const RequireScopes = (...scopes: Scope[]) => SetMetadata(REQUIRED_SCOPES_KEY, scopes);

/** Only a directly logged-in user (JWT); API-key principals get 403. */
export const UserOnly = () => SetMetadata(USER_ONLY_KEY, true);

/** Only principals with role admin. */
export const AdminOnly = () => SetMetadata(ADMIN_ONLY_KEY, true);

export const CurrentPrincipal = createParamDecorator((_data: unknown, ctx: ExecutionContext): Principal => {
  const req = ctx.switchToHttp().getRequest<AuthedRequest>();
  return req.principal as Principal;
});
