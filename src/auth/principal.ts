import { ActorType } from '@prisma/client';

export const SCOPES = [
  'profile:read',
  'accounts:read',
  'transactions:read',
  'goals:read',
  'goals:write',
  'offers:read',
  'agent:chat',
  'actions:propose',
  'actions:confirm',
] as const;

export type Scope = (typeof SCOPES)[number];

/** What the customer allowed an agent to do when signing the mandate in the app. */
export interface MandatePermissions {
  read: boolean;
  deposits: boolean;
  ownTransfers: boolean;
  externalPayments: boolean;
}

export const MANDATE_PERMISSIONS: readonly (keyof MandatePermissions)[] = ['read', 'deposits', 'ownTransfers', 'externalPayments'];

/** Signed mandate terms, stored on the API key the OAuth connect flow issues. Amounts in RON. */
export interface MandateTerms {
  clientName: string;
  permissions: MandatePermissions;
  /** Actions up to this amount execute without the customer's tap (external payments never do). */
  autoApproveUpTo: number;
  /** Cap on everything executed under the mandate. */
  totalLimit: number;
}

export interface Principal {
  userId: string;
  role: 'customer' | 'admin';
  kind: 'user' | 'api_key';
  apiKeyId?: string;
  scopes: Scope[];
  maxAmountPerAction: number | null;
  /** Present when the key is an agent mandate; `status` other than active means every MCP tool is refused. */
  mandate?: MandateTerms & { status: 'active' | 'revoked' | 'expired'; expiresAt: Date | null };
}

/** API scopes a mandate grants: reads with `read`, proposals with any money permission, never `actions:confirm`. */
export function scopesForMandate(p: MandatePermissions): Scope[] {
  const scopes: Scope[] = [];
  if (p.read) scopes.push('profile:read', 'accounts:read', 'transactions:read', 'goals:read', 'offers:read', 'agent:chat');
  if (p.deposits || p.ownTransfers || p.externalPayments) scopes.push('actions:propose');
  return scopes;
}

export function actorFromPrincipal(p: Principal): { actorType: ActorType; actorId: string } {
  if (p.kind === 'api_key') return { actorType: 'external_agent', actorId: p.apiKeyId ?? p.userId };
  return { actorType: 'user', actorId: p.userId };
}
