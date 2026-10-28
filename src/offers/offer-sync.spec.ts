import type { OfferCandidate, RuleId } from './offer-rules';
import { planOfferSync, StoredOffer } from './offer-sync';

const NOW = new Date('2026-10-28T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const days = (n: number) => new Date(NOW.getTime() + n * DAY);

function cand(ruleId: RuleId, productSlug: string | null, suggestedAmount = 1000): OfferCandidate {
  return {
    ruleId,
    kind: productSlug ? 'product' : 'tip',
    productSlug,
    title: ruleId,
    suggestedAmount,
    monthlyContribution: null,
    termMonths: null,
    projection: null,
    reasoning: '',
    citations: [],
    score: 1,
    actionable: !!productSlug,
    goalId: null,
  };
}

function row(
  id: string,
  ruleId: string,
  productSlug: string | null,
  status: StoredOffer['status'],
  o: Partial<StoredOffer> = {},
): StoredOffer {
  return { id, ruleId, productSlug, status, expiresAt: days(7), createdAt: days(-1), ...o };
}

describe('planOfferSync', () => {
  it('first run creates every candidate, in candidate order', () => {
    const plan = planOfferSync([], [cand('goal_term_deposit', 'depozit'), cand('subscriptions_tip', null)], NOW);
    expect(plan.upserts.map((u) => [u.candidate.ruleId, u.rowId])).toEqual([
      ['goal_term_deposit', null],
      ['subscriptions_tip', null],
    ]);
    expect(plan.deleteIds).toEqual([]);
  });

  it('a candidate that still applies keeps its id (fresh numbers go into the update); stale active rows are deleted', () => {
    const existing = [
      row('o-idle', 'idle_cash_savings', 'economii', 'active'),
      row('o-tip', 'subscriptions_tip', null, 'active'),
      row('o-gone', 'long_term_growth', 'fond-moderat', 'active'),
    ];
    const plan = planOfferSync(existing, [cand('idle_cash_savings', 'economii', 14_500), cand('subscriptions_tip', null)], NOW);
    expect(plan.upserts.map((u) => u.rowId)).toEqual(['o-idle', 'o-tip']);
    expect(plan.upserts[0].candidate.suggestedAmount).toBe(14_500);
    expect(plan.deleteIds).toEqual(['o-gone']);
  });

  it('same rule with a different product is a different offer', () => {
    const plan = planOfferSync([row('o1', 'goal_term_deposit', 'depozit-a', 'active')], [cand('goal_term_deposit', 'depozit-b')], NOW);
    expect(plan.upserts).toEqual([{ candidate: expect.objectContaining({ productSlug: 'depozit-b' }), rowId: null }]);
    expect(plan.deleteIds).toEqual(['o1']);
  });

  it('dismissed within 7 days → not shown and its row is left alone; after the window → same row reactivated', () => {
    const dismissed = row('o-d', 'idle_cash_savings', 'economii', 'dismissed', { expiresAt: days(3) });
    const within = planOfferSync([dismissed], [cand('idle_cash_savings', 'economii')], NOW);
    expect(within).toEqual({ upserts: [], deleteIds: [] });

    const after = planOfferSync([{ ...dismissed, expiresAt: days(-1) }], [cand('idle_cash_savings', 'economii')], NOW);
    expect(after.upserts.map((u) => u.rowId)).toEqual(['o-d']);
  });

  it('accepted offers keep their status while their window runs, even if the candidate still applies', () => {
    const accepted = row('o-a', 'goal_term_deposit', 'depozit', 'accepted', { expiresAt: days(5) });
    expect(planOfferSync([accepted], [cand('goal_term_deposit', 'depozit')], NOW)).toEqual({ upserts: [], deleteIds: [] });
  });

  it('released accepted offer (its proposal was rejected/expired, or a pre-check) is shown again with the same id', () => {
    const released = row('o-a', 'home_goal', 'economii', 'accepted', { expiresAt: days(6), released: true });
    const plan = planOfferSync([released], [cand('home_goal', 'economii')], NOW);
    expect(plan.upserts.map((u) => u.rowId)).toEqual(['o-a']);
    expect(plan.deleteIds).toEqual([]);
  });

  it('a released accepted row never un-hides a key that a dismissal still suppresses', () => {
    const existing = [
      row('o-a', 'home_goal', 'economii', 'accepted', { released: true, createdAt: days(-2) }),
      row('o-d', 'home_goal', 'economii', 'dismissed', { expiresAt: days(2), createdAt: days(-1) }),
    ];
    expect(planOfferSync(existing, [cand('home_goal', 'economii')], NOW)).toEqual({ upserts: [], deleteIds: [] });
  });

  it('accepted/dismissed offers that no longer apply are kept as history (never deleted)', () => {
    const existing = [
      row('o-a', 'retirement', 'pilon-3', 'accepted'),
      row('o-d', 'youth_package', 'pachet', 'dismissed', { expiresAt: days(-2) }),
    ];
    expect(planOfferSync(existing, [], NOW)).toEqual({ upserts: [], deleteIds: [] });
  });

  it('expired active offers that still apply are renewed in place', () => {
    const expired = row('o1', 'emergency_fund', 'economii', 'active', { expiresAt: days(-1) });
    const plan = planOfferSync([expired], [cand('emergency_fund', 'economii')], NOW);
    expect(plan.upserts.map((u) => u.rowId)).toEqual(['o1']);
    expect(plan.deleteIds).toEqual([]);
  });

  it('legacy duplicates: the newest active row wins, the other active copies are deleted, past rows untouched', () => {
    const existing = [
      row('old-active', 'idle_cash_savings', 'economii', 'active', { createdAt: days(-3) }),
      row('new-active', 'idle_cash_savings', 'economii', 'active', { createdAt: days(-1) }),
      row('old-accepted', 'idle_cash_savings', 'economii', 'accepted', { expiresAt: days(-1), createdAt: days(-10) }),
    ];
    const plan = planOfferSync(existing, [cand('idle_cash_savings', 'economii')], NOW);
    expect(plan.upserts.map((u) => u.rowId)).toEqual(['new-active']);
    expect(plan.deleteIds).toEqual(['old-active']);
  });

  it('active copy of a suppressed key is deleted (the key stays hidden)', () => {
    const existing = [
      row('o-d', 'idle_cash_savings', 'economii', 'dismissed', { expiresAt: days(2) }),
      row('o-a', 'idle_cash_savings', 'economii', 'active'),
    ];
    expect(planOfferSync(existing, [cand('idle_cash_savings', 'economii')], NOW)).toEqual({ upserts: [], deleteIds: ['o-a'] });
  });

  it('a duplicate candidate key is shown once', () => {
    const plan = planOfferSync([], [cand('subscriptions_tip', null), cand('subscriptions_tip', null)], NOW);
    expect(plan.upserts).toHaveLength(1);
  });
});
