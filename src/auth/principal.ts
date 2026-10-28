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

export interface Principal {
  userId: string;
  role: 'customer' | 'admin';
  kind: 'user' | 'api_key';
  apiKeyId?: string;
  scopes: Scope[];
  maxAmountPerAction: number | null;
}

export function actorFromPrincipal(p: Principal): { actorType: ActorType; actorId: string } {
  if (p.kind === 'api_key') return { actorType: 'external_agent', actorId: p.apiKeyId ?? p.userId };
  return { actorType: 'user', actorId: p.userId };
}
