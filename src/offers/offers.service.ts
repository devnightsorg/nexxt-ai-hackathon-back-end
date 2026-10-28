import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { AccountType, Offer, Prisma } from '@prisma/client';
import { ActionsService, ProposalDto } from '../actions/actions.service';
import type { ProposeInput } from '../actions/policy';
import { actorFromPrincipal, Principal } from '../auth/principal';
import { AccountsService } from '../banking/accounts.service';
import { StatsService } from '../banking/stats.service';
import { toMoney } from '../common/money';
import { config } from '../config/config';
import { Projection } from '../finance/projection';
import { GoalsService } from '../goals/goals.service';
import { LlmService } from '../llm/llm.service';
import { PrismaService } from '../prisma/prisma.service';
import { CatalogProduct, termMonthsOf } from '../products/catalog.types';
import { ProductsService } from '../products/products.service';
import { AuditService } from '../security/audit/audit.service';
import { creditPrecheck } from './credit-precheck';
import { generateOfferCandidates, OfferCandidate, RuleId } from './offer-rules';
import { planOfferSync, StoredOffer } from './offer-sync';

export interface OfferDto {
  id: string;
  ruleId: RuleId;
  kind: 'product' | 'tip';
  productSlug: string | null;
  productName: string | null;
  title: string;
  terms: {
    suggestedAmount: number | null;
    monthlyContribution: number | null;
    termMonths: number | null;
    projection: Projection | null;
    /** Goal the offer is for; accepting and confirming it counts toward that goal. */
    goalId?: string | null;
  };
  reasoning: string;
  citations: { title: string; sourceUrl: string }[];
  score: number;
  actionable: boolean;
  status: string;
  expiresAt: Date;
}

const OFFER_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const OFFER_NOT_FOUND = 'Oferta nu există';
const OFFER_NOT_ACTIVE = 'Oferta nu mai este activă';
const NO_CURRENT_ACCOUNT = 'Nu ai un cont curent activ din care să deschidem produsul';
const CREDIT_CATEGORIES = ['personal_loan', 'mortgage', 'credit_card'];
const EXPLAIN_PROMPT =
  'Reformulează explicația unei oferte bancare într-un ton prietenos, în limba română, în maximum 3 propoziții. ' +
  'Păstrează EXACT toate cifrele, sumele, procentele și numele produselor. Nu adăuga cifre noi. Răspunde doar cu textul.';

type Terms = OfferDto['terms'];

/** Transaction-scoped advisory lock on one user's offers. */
function lockUserOffers(tx: Prisma.TransactionClient, userId: string): Promise<number> {
  return tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`offers:${userId}`}))`;
}

function numbersIn(text: string): string[] {
  return text.match(/\d[\d.,]*\d|\d/g) ?? [];
}

/** Products the customer keeps adding money to: when they already hold one, an offer tops it up instead of opening another. */
const REUSABLE_CATEGORIES = ['savings_account', 'housing_savings'];

/**
 * What accepting an actionable offer proposes: a transfer into the customer's existing account of that product
 * (savings accounts, housing savings), else opening the product. Funded from `source`; keeps the goal link.
 */
export function offerProposalInput(
  product: CatalogProduct,
  terms: Terms,
  accounts: { id: string; type: string; status: string; productSlug: string | null }[],
  source: { id: string },
  amount: number,
  reason: string,
): ProposeInput {
  const goal = terms.goalId ? { goalId: terms.goalId } : {};
  const owned = REUSABLE_CATEGORIES.includes(product.category)
    ? accounts.find((a) => a.status === 'active' && a.productSlug === product.slug && a.id !== source.id)
    : undefined;
  if (owned) return { type: 'transfer', fromAccountId: source.id, toAccountId: owned.id, amount, reason, ...goal };
  return {
    type: 'open_product',
    productSlug: product.slug,
    fromAccountId: source.id,
    amount,
    ...(terms.termMonths ? { termMonths: terms.termMonths } : {}),
    reason,
    ...goal,
  };
}

@Injectable()
export class OffersService {
  private readonly logger = new Logger(OffersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly stats: StatsService,
    private readonly goals: GoalsService,
    private readonly products: ProductsService,
    private readonly accounts: AccountsService,
    private readonly actions: ActionsService,
    private readonly llm: LlmService,
    private readonly audit: AuditService,
  ) {}

  /** Regenerates the user's active offers from the rules and returns them. */
  async list(userId: string, o: { explain?: boolean } = {}): Promise<OfferDto[]> {
    const now = new Date();
    const [user, snapshot, goals, products, accounts] = await Promise.all([
      this.prisma.user.findUniqueOrThrow({ where: { id: userId } }),
      this.stats.snapshot(userId, now),
      this.goals.list(userId),
      this.products.getAll(),
      this.accounts.listForUser(userId),
    ]);
    const candidates = generateOfferCandidates({
      user: {
        age: user.age,
        riskProfile: user.riskProfile,
        monthlyIncome: user.monthlyIncome === null ? null : toMoney(user.monthlyIncome),
      },
      snapshot,
      goals,
      products,
      ownedAccountTypes: accounts.filter((a) => a.status === 'active').map((a) => a.type as AccountType),
      ownedProductSlugs: accounts.filter((a) => a.status === 'active' && a.productSlug).map((a) => a.productSlug as string),
      interestTaxRate: config().INTEREST_TAX_RATE,
      now,
    });

    // Upsert by (ruleId, productSlug) so ids survive regeneration (list → accept never races a new id).
    // The per-user lock serialises concurrent regenerations (UI, agent tool, MCP) and accept/dismiss.
    const expiresAt = new Date(now.getTime() + OFFER_TTL_MS);
    const saved = await this.prisma.$transaction(async (tx) => {
      await lockUserOffers(tx, userId);
      const rows = await tx.offer.findMany({
        where: { userId },
        select: { id: true, ruleId: true, productSlug: true, status: true, expiresAt: true, createdAt: true },
      });
      const existing = await this.markReleased(tx, userId, rows, now);
      const plan = planOfferSync(existing, candidates, now);
      if (plan.deleteIds.length) await tx.offer.deleteMany({ where: { userId, status: 'active', id: { in: plan.deleteIds } } });
      const out: Offer[] = [];
      for (const { candidate, rowId } of plan.upserts) {
        const data = this.toRow(userId, candidate, expiresAt);
        out.push(rowId ? await tx.offer.update({ where: { id: rowId }, data }) : await tx.offer.create({ data }));
      }
      return out;
    });

    const names = new Map(products.map((p) => [p.slug, p.name]));
    let dtos = saved.map((r) => this.toDto(r, names));
    if (o.explain) dtos = await Promise.all(dtos.map((d) => this.explain(d)));
    return dtos;
  }

  async accept(
    p: Principal,
    id: string,
  ): Promise<{ offer: OfferDto; proposal?: ProposalDto; precheck?: ReturnType<typeof creditPrecheck> }> {
    // Claimed first, so a concurrent accept or regeneration cannot propose it twice or reset it.
    const { before: row, after: updated } = await this.claim(p.userId, id, 'accepted');
    let product: CatalogProduct | null = null;
    let proposal: ProposalDto | undefined;
    let precheck: ReturnType<typeof creditPrecheck> | undefined;
    try {
      product = row.productSlug ? await this.products.get(row.productSlug) : null;
      const terms = row.terms as unknown as Terms;
      if (row.actionable && product) {
        const accounts = await this.accounts.listForUser(p.userId);
        const source = accounts.find((a) => a.type === 'current' && a.status === 'active');
        if (!source) throw new BadRequestException(NO_CURRENT_ACCOUNT);
        const amount = terms.suggestedAmount ?? terms.monthlyContribution ?? product.min_amount?.value;
        if (amount === undefined || amount === null) throw new BadRequestException('Suma nu poate fi determinată');
        proposal = await this.actions.propose(
          p,
          offerProposalInput(product, terms, accounts, source, amount, row.title.slice(0, 300)),
          { proposedVia: 'offer', offerId: row.id },
        );
      } else if (product && CREDIT_CATEGORIES.includes(product.category)) {
        const snapshot = await this.stats.snapshot(p.userId);
        const termsList = termMonthsOf(product);
        precheck = creditPrecheck(snapshot, {
          annualRatePct: product.interest_rate_or_return?.value ?? undefined,
          termMonths: termsList.length ? termsList[termsList.length - 1] : undefined,
        });
      }
    } catch (e) {
      // Nothing was proposed: the offer goes back to active with its original expiry.
      await this.prisma.offer.updateMany({
        where: { id, status: 'accepted' },
        data: { status: 'active', expiresAt: row.expiresAt },
      });
      throw e;
    }

    await this.audit.record({
      ...actorFromPrincipal(p),
      userId: p.userId,
      action: 'offer.accepted',
      resource: `offer:${id}`,
      details: { ruleId: row.ruleId, productSlug: row.productSlug, proposalId: proposal?.id ?? null },
    });
    const offer = this.toDto(updated, new Map(product ? [[product.slug, product.name]] : []));
    return { offer, ...(proposal ? { proposal } : {}), ...(precheck ? { precheck } : {}) };
  }

  async dismiss(p: Principal, id: string): Promise<OfferDto> {
    const { before: row, after: updated } = await this.claim(p.userId, id, 'dismissed');
    await this.audit.record({
      ...actorFromPrincipal(p),
      userId: p.userId,
      action: 'offer.dismissed',
      resource: `offer:${id}`,
      details: { ruleId: row.ruleId, productSlug: row.productSlug },
    });
    const name = row.productSlug ? await this.productName(row.productSlug) : null;
    return this.toDto(updated, new Map(name && row.productSlug ? [[row.productSlug, name]] : []));
  }

  /**
   * Flags accepted offers (inside their window) that have no live proposal: none pending or executed among
   * the proposals created from them in the last 7 days. Those stop hiding their key, so "Accept" followed by
   * "Not now" (or an expired/failed proposal, or a credit pre-check) leaves the offer available.
   */
  private async markReleased(tx: Prisma.TransactionClient, userId: string, rows: StoredOffer[], now: Date): Promise<StoredOffer[]> {
    const accepted = rows.filter((r) => r.status === 'accepted' && r.expiresAt > now).map((r) => r.id);
    if (!accepted.length) return rows;
    const live = await tx.actionProposal.findMany({
      where: {
        userId,
        offerId: { in: accepted },
        createdAt: { gte: new Date(now.getTime() - OFFER_TTL_MS) },
        OR: [{ status: 'executed' }, { status: 'pending', expiresAt: { gt: now } }],
      },
      select: { offerId: true },
    });
    const liveIds = new Set(live.map((l) => l.offerId));
    return rows.map((r) => (r.status === 'accepted' && accepted.includes(r.id) && !liveIds.has(r.id) ? { ...r, released: true } : r));
  }

  /**
   * Moves an active offer to accepted/dismissed under the user's offer lock. `expiresAt` becomes the end of
   * the 7-day window during which regeneration does not show that (ruleId, productSlug) again.
   */
  private claim(userId: string, id: string, status: 'accepted' | 'dismissed'): Promise<{ before: Offer; after: Offer }> {
    return this.prisma.$transaction(async (tx) => {
      await lockUserOffers(tx, userId);
      const before = await tx.offer.findFirst({ where: { id, userId } });
      if (!before) throw new NotFoundException(OFFER_NOT_FOUND);
      if (before.status !== 'active' || before.expiresAt <= new Date()) throw new ConflictException(OFFER_NOT_ACTIVE);
      const after = await tx.offer.update({ where: { id }, data: { status, expiresAt: new Date(Date.now() + OFFER_TTL_MS) } });
      return { before, after };
    });
  }

  private async productName(slug: string): Promise<string | null> {
    try {
      return (await this.products.get(slug)).name;
    } catch {
      return null;
    }
  }

  /** Fast-model rewrite of the reasoning; falls back to the template on any error or changed numbers. */
  private async explain(d: OfferDto): Promise<OfferDto> {
    try {
      const res = await this.llm.chat({
        model: 'fast',
        maxTokens: 300,
        messages: [
          { role: 'system', content: EXPLAIN_PROMPT },
          { role: 'user', content: d.reasoning },
        ],
      });
      const text = res.content.trim();
      if (!text) return d;
      const missing = numbersIn(d.reasoning).some((n) => !text.includes(n));
      const extra = numbersIn(text).some((n) => !d.reasoning.includes(n));
      if (missing || extra) return d;
      return { ...d, reasoning: text };
    } catch (e) {
      this.logger.warn(`offer explain failed: ${e instanceof Error ? e.message : String(e)}`);
      return d;
    }
  }

  private toRow(userId: string, c: OfferCandidate, expiresAt: Date): Prisma.OfferUncheckedCreateInput {
    const terms: Terms = {
      suggestedAmount: c.suggestedAmount,
      monthlyContribution: c.monthlyContribution,
      termMonths: c.termMonths,
      projection: c.projection,
      goalId: c.goalId,
    };
    return {
      userId,
      ruleId: c.ruleId,
      kind: c.kind,
      productSlug: c.productSlug,
      title: c.title,
      terms: terms as unknown as Prisma.InputJsonValue,
      reasoning: c.reasoning,
      citations: c.citations as unknown as Prisma.InputJsonValue,
      score: c.score,
      actionable: c.actionable,
      status: 'active',
      expiresAt,
    };
  }

  private toDto(r: Offer, names: Map<string, string>): OfferDto {
    return {
      id: r.id,
      ruleId: r.ruleId as RuleId,
      kind: r.kind,
      productSlug: r.productSlug,
      productName: r.productSlug ? (names.get(r.productSlug) ?? null) : null,
      title: r.title,
      terms: r.terms as unknown as Terms,
      reasoning: r.reasoning,
      citations: (r.citations ?? []) as unknown as OfferDto['citations'],
      score: r.score,
      actionable: r.actionable,
      status: r.status,
      expiresAt: r.expiresAt,
    };
  }
}
