import type { OfferStatus } from '@prisma/client';
import type { OfferCandidate } from './offer-rules';

/** The columns of a stored offer the regeneration needs. */
export interface StoredOffer {
  id: string;
  ruleId: string;
  productSlug: string | null;
  status: OfferStatus;
  expiresAt: Date;
  createdAt: Date;
  /**
   * Accepted offer whose acceptance never turned into a live action: its proposal was rejected, expired
   * or failed, or there was none (credit pre-check, noted interest). It does not suppress its key.
   */
  released?: boolean;
}

export interface OfferSyncPlan {
  /** Candidates to show, in candidate (score) order; `rowId` is the row to update, null to create one. */
  upserts: { candidate: OfferCandidate; rowId: string | null }[];
  /** Active rows that no longer apply (or duplicate a kept row): delete them. */
  deleteIds: string[];
}

export const offerKey = (o: { ruleId: string; productSlug: string | null }): string => `${o.ruleId}|${o.productSlug ?? ''}`;

/** Dismissed offers, and accepted ones whose proposal is pending or executed, suppress their key until `expiresAt`. */
function suppresses(r: StoredOffer, now: Date): boolean {
  const hides = r.status === 'dismissed' || (r.status === 'accepted' && !r.released);
  return hides && r.expiresAt > now;
}

const newestFirst = (a: StoredOffer, b: StoredOffer): number => b.createdAt.getTime() - a.createdAt.getTime();

/**
 * Upsert plan keyed by (ruleId, productSlug), so offer ids stay stable across regenerations:
 * - a candidate whose key is suppressed (dismissed or accepted-and-not-released, window not over) is not shown
 *   and its row is untouched;
 * - a released accepted row (its proposal never executed) is shown again in place (same id);
 * - otherwise the newest active row for the key is updated in place (same id), else the newest past row
 *   (accepted/dismissed whose window ended, or expired) is reactivated, else a new row is created;
 * - every other active row (no candidate any more, suppressed key, duplicate) is deleted; past rows stay as history.
 */
export function planOfferSync(existing: StoredOffer[], candidates: OfferCandidate[], now: Date): OfferSyncPlan {
  const byKey = new Map<string, StoredOffer[]>();
  for (const r of existing) {
    const k = offerKey(r);
    byKey.set(k, [...(byKey.get(k) ?? []), r]);
  }

  const seen = new Set<string>();
  const kept = new Set<string>();
  const upserts: OfferSyncPlan['upserts'] = [];
  for (const candidate of candidates) {
    const k = offerKey(candidate);
    if (seen.has(k)) continue; // one offer per key
    seen.add(k);
    const rows = [...(byKey.get(k) ?? [])].sort(newestFirst);
    if (rows.some((r) => suppresses(r, now))) continue;
    const row = rows.find((r) => r.status === 'active') ?? rows.find((r) => r.status === 'accepted' && r.released) ?? rows[0] ?? null;
    if (row) kept.add(row.id);
    upserts.push({ candidate, rowId: row?.id ?? null });
  }

  const deleteIds = existing.filter((r) => r.status === 'active' && !kept.has(r.id)).map((r) => r.id);
  return { upserts, deleteIds };
}
