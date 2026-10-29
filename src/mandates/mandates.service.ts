import { BadRequestException, ForbiddenException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { ApiKey } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { ActionsService, ProposalDto } from '../actions/actions.service';
import { ProposeInput } from '../actions/policy';
import { ApiKeysService } from '../auth/api-keys.service';
import { MANDATE_PERMISSIONS, MandatePermissions, MandateTerms, Principal } from '../auth/principal';
import { formatRon } from '../common/money';
import { config } from '../config/config';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../security/audit/audit.service';
import { AuthorizeMandateBody, MandateActionDto, MandateDto } from './dto';

/** Fixed demo presets shown read-only on the sign screen. */
export const MANDATE_AUTO_APPROVE_UP_TO = 2000;
export const MANDATE_TOTAL_LIMIT = 10000;
export const MANDATE_VALID_DAYS = 30;
const CODE_TTL_MS = 10 * 60_000;
const DAY_MS = 86_400_000;

const CLIENT_ID_PREFIX = 'c_';

interface PendingCode {
  userId: string;
  redirectUri: string;
  terms: MandateTerms;
  expiresAt: number;
}

type MandateKind = keyof Omit<MandatePermissions, 'read'>;

const KIND_LABELS: Record<MandateKind, string> = {
  deposits: 'deschiderea de depozite și conturi de economii',
  ownTransfers: 'transferuri între conturile proprii',
  externalPayments: 'plăți către alte persoane',
};

export interface MandateDecision {
  decision: 'executed_under_mandate' | 'needs_customer_approval';
  message: string;
  approvalUrl?: string;
  remainingLimit: number;
}

/** OAuth `client_id` handed out at registration; it carries the client's display name (no client store). */
export function clientIdFor(clientName: string): string {
  return CLIENT_ID_PREFIX + Buffer.from(clientName.slice(0, 60)).toString('base64url');
}

/** Display name of the agent: from the client_id, else from the redirect host. */
export function clientNameFor(clientId: string, redirectUri: string): string {
  if (clientId.startsWith(CLIENT_ID_PREFIX)) {
    const name = Buffer.from(clientId.slice(CLIENT_ID_PREFIX.length), 'base64url').toString('utf8').trim();
    if (name) return name;
  }
  const host = URL.canParse(redirectUri) ? new URL(redirectUri).hostname : '';
  return /(^|\.)(claude\.ai|anthropic\.com)$/.test(host) ? 'Claude' : 'Agent AI';
}

function readPermissions(raw: unknown): MandatePermissions {
  const src = (raw ?? {}) as Record<string, unknown>;
  return {
    read: src.read === true,
    deposits: src.deposits === true,
    ownTransfers: src.ownTransfers === true,
    externalPayments: src.externalPayments === true,
  };
}

const proposedVia = (apiKeyId: string): string => `mcp:${apiKeyId}`;

/**
 * Agent mandates: the customer signs limits and permissions in the app (OAuth connect flow), the agent gets an
 * API key bound to them. Under the mandate small actions execute at once; larger ones and every external payment
 * wait for the customer's tap in the app.
 */
@Injectable()
export class MandatesService {
  private readonly codes = new Map<string, PendingCode>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly apiKeys: ApiKeysService,
    private readonly actions: ActionsService,
    private readonly audit: AuditService,
  ) {}

  /** Customer signed the mandate: mint a one-time authorization code and send the browser back to the agent. */
  async authorize(p: Principal, body: AuthorizeMandateBody): Promise<{ redirectTo: string }> {
    if (!URL.canParse(body.redirectUri)) throw new BadRequestException('redirectUri invalid');
    const redirect = new URL(body.redirectUri);
    if (redirect.protocol !== 'https:' && redirect.protocol !== 'http:') throw new BadRequestException('redirectUri invalid');
    const permissions = readPermissions(body.permissions);
    if (!MANDATE_PERMISSIONS.some((k) => permissions[k])) throw new BadRequestException('Alege cel puțin o permisiune');

    const terms: MandateTerms = {
      clientName: clientNameFor(body.clientId, body.redirectUri),
      permissions,
      autoApproveUpTo: MANDATE_AUTO_APPROVE_UP_TO,
      totalLimit: MANDATE_TOTAL_LIMIT,
    };
    const code = randomBytes(24).toString('base64url');
    this.codes.set(code, { userId: p.userId, redirectUri: body.redirectUri, terms, expiresAt: Date.now() + CODE_TTL_MS });
    await this.audit.record({
      actorType: 'user',
      actorId: p.userId,
      userId: p.userId,
      action: 'mandate.signed',
      details: { ...terms },
    });

    redirect.searchParams.set('code', code);
    if (body.state) redirect.searchParams.set('state', body.state);
    return { redirectTo: redirect.toString() };
  }

  /** OAuth token exchange; null when the code is unknown, used, expired or for another redirect URI. */
  async exchangeCode(code: string, redirectUri?: string): Promise<{ accessToken: string; expiresIn: number } | null> {
    const entry = this.codes.get(code);
    this.codes.delete(code);
    if (!entry || entry.expiresAt < Date.now()) return null;
    if (redirectUri && redirectUri !== entry.redirectUri) return null;
    const expiresAt = new Date(Date.now() + MANDATE_VALID_DAYS * DAY_MS);
    const key = await this.apiKeys.createMandateKey(entry.userId, entry.terms, expiresAt);
    await this.audit.record({
      actorType: 'system',
      userId: entry.userId,
      action: 'mandate.issued',
      resource: `api_key:${key.id}`,
      details: { clientName: entry.terms.clientName, expiresAt: expiresAt.toISOString() },
    });
    return { accessToken: key.key, expiresIn: MANDATE_VALID_DAYS * 86_400 };
  }

  async list(userId: string): Promise<MandateDto[]> {
    const keys = (await this.prisma.apiKey.findMany({ where: { userId }, orderBy: { createdAt: 'desc' } })).filter(
      (k) => k.mandate != null,
    );
    if (keys.length === 0) return [];
    const rows = await this.prisma.actionProposal.findMany({
      where: { userId, proposedVia: { in: keys.map((k) => proposedVia(k.id)) } },
      orderBy: { createdAt: 'desc' },
    });
    return keys.map((k) => {
      const mine = rows.filter((r) => r.proposedVia === proposedVia(k.id));
      return this.toDto(k, mine);
    });
  }

  async revoke(p: Principal, id: string): Promise<MandateDto> {
    const key = await this.prisma.apiKey.findFirst({ where: { id, userId: p.userId } });
    if (!key || key.mandate == null) throw new NotFoundException('Mandatul nu există');
    if (!key.revokedAt) {
      await this.prisma.apiKey.update({ where: { id }, data: { revokedAt: new Date() } });
      await this.audit.record({
        actorType: 'user',
        actorId: p.userId,
        userId: p.userId,
        action: 'mandate.revoked',
        resource: `api_key:${id}`,
      });
    }
    const dto = (await this.list(p.userId)).find((m) => m.id === id);
    if (!dto) throw new NotFoundException('Mandatul nu există');
    return dto;
  }

  /** `propose_action` for an agent acting under a mandate: permission + total checks, then execute or ask the customer. */
  async propose(p: Principal, input: ProposeInput): Promise<ProposalDto & { mandate: MandateDecision }> {
    const m = p.mandate;
    if (!m || !p.apiKeyId) throw new ForbiddenException('Cheia nu are un mandat');
    const kind = await this.kindOf(p.userId, input);
    const auditBase = { actorType: 'external_agent' as const, actorId: p.apiKeyId, userId: p.userId };

    if (!m.permissions[kind]) {
      await this.audit.record({ ...auditBase, action: 'mandate.denied', verdict: 'blocked', details: { reason: 'SCOPE_DENIED', kind } });
      throw new ForbiddenException(`SCOPE_DENIED: mandatul semnat nu permite ${KIND_LABELS[kind]}`);
    }
    const amount = typeof input.amount === 'number' ? input.amount : Number.NaN;
    const used = await this.usedUnder(p.userId, p.apiKeyId);
    if (Number.isFinite(amount) && used + amount > m.totalLimit) {
      await this.audit.record({
        ...auditBase,
        action: 'mandate.denied',
        verdict: 'blocked',
        details: { reason: 'LIMIT_EXCEEDED', amount, used, totalLimit: m.totalLimit },
      });
      throw new UnprocessableEntityException(
        `LIMIT_EXCEEDED: mandatul are o limită totală de ${formatRon(m.totalLimit)} RON, din care s-au folosit ${formatRon(used)} RON`,
      );
    }

    const proposal = await this.actions.propose(p, input, { proposedVia: proposedVia(p.apiKeyId) });
    const auto = kind !== 'externalPayments' && amount <= m.autoApproveUpTo;
    if (auto) {
      const executed = await this.actions.confirm({ ...p, scopes: [...p.scopes, 'actions:confirm'] }, proposal.id);
      await this.audit.record({ ...auditBase, action: 'mandate.auto_executed', resource: `action:${proposal.id}`, details: { amount } });
      return {
        ...executed,
        mandate: {
          decision: 'executed_under_mandate',
          message: `Executat imediat: suma este în limita de ${formatRon(m.autoApproveUpTo)} RON pe care clientul a aprobat-o în mandat.`,
          remainingLimit: m.totalLimit - used - amount,
        },
      };
    }

    const approvalUrl = `${config().PUBLIC_URL}/approve/${proposal.id}`;
    const why =
      kind === 'externalPayments'
        ? 'Plățile către alte persoane cer mereu aprobarea clientului în aplicația Raiffeisen.'
        : `Suma depășește limita de ${formatRon(m.autoApproveUpTo)} RON pe care mandatul o execută fără confirmare.`;
    await this.audit.record({ ...auditBase, action: 'mandate.approval_requested', resource: `action:${proposal.id}`, details: { amount, kind } });
    return {
      ...proposal,
      mandate: {
        decision: 'needs_customer_approval',
        message: `${why} Arată-i clientului linkul approvalUrl ca să aprobe sau să respingă în aplicație, apoi verifică get_action_status.`,
        approvalUrl,
        remainingLimit: m.totalLimit - used,
      },
    };
  }

  // ---------------------------------------------------------------------------

  /** Which mandate permission an action needs; a transfer to one of the customer's own IBANs counts as own. */
  private async kindOf(userId: string, input: ProposeInput): Promise<MandateKind> {
    if (input.type === 'open_product') return 'deposits';
    if (input.toAccountId) return 'ownTransfers';
    const iban = input.toIban?.replace(/\s+/g, '').toUpperCase();
    if (!iban) return 'ownTransfers';
    const own = await this.prisma.account.findFirst({ where: { iban, userId }, select: { id: true } });
    return own ? 'ownTransfers' : 'externalPayments';
  }

  private async usedUnder(userId: string, apiKeyId: string): Promise<number> {
    const rows = await this.prisma.actionProposal.findMany({
      where: { userId, proposedVia: proposedVia(apiKeyId), status: 'executed' },
      select: { payload: true },
    });
    return rows.reduce((s, r) => s + amountOf(r.payload), 0);
  }

  private toDto(k: ApiKey, rows: { id: string; type: 'transfer' | 'open_product'; status: MandateActionDto['status']; payload: unknown; confirmedBy: string | null; createdAt: Date }[]): MandateDto {
    const terms = k.mandate as unknown as MandateTerms;
    const status = k.revokedAt ? 'revoked' : k.expiresAt && k.expiresAt <= new Date() ? 'expired' : 'active';
    return {
      id: k.id,
      clientName: terms.clientName,
      status,
      permissions: readPermissions(terms.permissions),
      autoApproveUpTo: terms.autoApproveUpTo,
      totalLimit: terms.totalLimit,
      used: rows.filter((r) => r.status === 'executed').reduce((s, r) => s + amountOf(r.payload), 0),
      expiresAt: k.expiresAt,
      createdAt: k.createdAt,
      lastUsedAt: k.lastUsedAt,
      recentActions: rows.slice(0, 3).map((r) => ({
        id: r.id,
        summary: typeof (r.payload as { summary?: unknown })?.summary === 'string' ? (r.payload as { summary: string }).summary : '',
        type: r.type,
        amount: amountOf(r.payload),
        status: r.status,
        autoApproved: r.confirmedBy?.startsWith('api_key:') ?? false,
        createdAt: r.createdAt,
      })),
    };
  }
}

function amountOf(payload: unknown): number {
  const a = (payload as { amount?: unknown } | null)?.amount;
  return typeof a === 'number' && Number.isFinite(a) ? a : 0;
}
