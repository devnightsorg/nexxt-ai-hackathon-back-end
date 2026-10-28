import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { DEMO_PASSWORD } from '../src/seed/personas';
import { SeedService } from '../src/seed/seed.service';
import { createTestApp } from './utils/app';
import { loginAs } from './utils/factory';
import { resetDb } from './utils/reset-db';

const ANDREI = 'andrei.popescu@demo.ro';

interface OfferBody {
  id: string;
  ruleId: string;
  productSlug: string | null;
  actionable: boolean;
  status: string;
}

describe('offers (stable ids)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let token: string;
  let userId: string;

  const list = async (): Promise<OfferBody[]> =>
    (await request(app.getHttpServer()).get('/offers').set('Authorization', `Bearer ${token}`).expect(200)).body;
  const post = (path: string) => request(app.getHttpServer()).post(path).set('Authorization', `Bearer ${token}`);
  const ids = (offers: OfferBody[]) => offers.map((o) => o.id);

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
    await resetDb(prisma);
    await app.get(SeedService).run({ ingestKnowledge: false });
    token = await loginAs(app, ANDREI, DEMO_PASSWORD);
    userId = (await prisma.user.findUniqueOrThrow({ where: { email: ANDREI } })).id;
  });

  afterAll(async () => {
    await app.close();
  });

  it('concurrent first GET /offers calls agree on one set of rows; later calls keep the ids', async () => {
    await prisma.offer.deleteMany({ where: { userId } });
    const [a, b, c] = await Promise.all([list(), list(), list()]);
    expect(a.length).toBeGreaterThanOrEqual(2);
    expect(ids(b)).toEqual(ids(a));
    expect(ids(c)).toEqual(ids(a));
    expect(await prisma.offer.count({ where: { userId } })).toBe(a.length);
    expect(ids(await list())).toEqual(ids(a));
  });

  it('updates numbers in place and deletes only active offers that no longer apply', async () => {
    const before = await list();
    const target = before[0];
    await prisma.offer.update({ where: { id: target.id }, data: { terms: { stale: true }, expiresAt: new Date(Date.now() - 1000) } });
    const stale = await prisma.offer.create({
      data: {
        userId,
        ruleId: 'youth_package',
        kind: 'tip',
        productSlug: null,
        title: 'stale',
        terms: {},
        reasoning: 'stale',
        citations: [],
        score: 1,
        actionable: false,
        expiresAt: new Date(Date.now() + 60_000),
      },
    });

    const after = await list();
    expect(ids(after)).toEqual(ids(before));
    const refreshed = await prisma.offer.findUniqueOrThrow({ where: { id: target.id } });
    expect(refreshed.terms).not.toEqual({ stale: true });
    expect(refreshed.expiresAt.getTime()).toBeGreaterThan(Date.now() + 6 * 24 * 60 * 60 * 1000);
    expect(await prisma.offer.findUnique({ where: { id: stale.id } })).toBeNull();
  });

  it('dismissed: hidden for 7 days with its row kept, then the same id comes back', async () => {
    const before = await list();
    const target = before[before.length - 1];
    await post(`/offers/${target.id}/dismiss`).expect(200);

    const after = await list();
    expect(ids(after)).not.toContain(target.id);
    expect(ids(after)).toEqual(ids(before).filter((id) => id !== target.id));
    expect((await prisma.offer.findUniqueOrThrow({ where: { id: target.id } })).status).toBe('dismissed');

    await prisma.offer.update({ where: { id: target.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const back = await list();
    expect(ids(back)).toContain(target.id);
    expect(back.find((o) => o.id === target.id)?.status).toBe('active');
  });

  it('accepting an id from the list works after a regeneration in between; the offer then stays accepted', async () => {
    const offers = await list();
    const target = offers.find((o) => o.actionable);
    expect(target).toBeDefined();
    await list(); // e.g. a refetch on focus or an agent turn between list and accept

    const res = await post(`/offers/${target!.id}/accept`).expect(200);
    expect(res.body.offer).toMatchObject({ id: target!.id, status: 'accepted' });
    expect(res.body.proposal?.id).toBeDefined();

    expect(ids(await list())).not.toContain(target!.id);
    expect((await prisma.offer.findUniqueOrThrow({ where: { id: target!.id } })).status).toBe('accepted');
    await post(`/offers/${target!.id}/accept`).expect(409);
  });

  it('"Not now" on the proposal of an accepted offer brings the same offer back', async () => {
    const offers = await list();
    const target = offers.find((o) => o.actionable)!;
    const res = await post(`/offers/${target.id}/accept`).expect(200);
    expect(res.body.proposal.offerId).toBe(target.id);
    expect(ids(await list())).not.toContain(target.id);

    await post(`/actions/${res.body.proposal.id}/reject`).expect(200);
    const back = await list();
    expect(ids(back)).toContain(target.id);
    expect(back.find((o) => o.id === target.id)?.status).toBe('active');
  });

  it('an expired offer proposal releases the offer too; an executed one keeps it hidden', async () => {
    const offers = await list();
    const [a, b] = offers.filter((o) => o.actionable);
    const ra = await post(`/offers/${a.id}/accept`).expect(200);
    await prisma.actionProposal.update({ where: { id: ra.body.proposal.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect(ids(await list())).toContain(a.id);

    if (b) {
      const rb = await post(`/offers/${b.id}/accept`).expect(200);
      await post(`/actions/${rb.body.proposal.id}/confirm`).expect(200);
      expect(ids(await list())).not.toContain(b.id);
    }
  });

  it('a credit pre-check offer stays available after it is accepted', async () => {
    const maria = await loginAs(app, 'maria.ionescu@demo.ro', DEMO_PASSWORD);
    const get = async () =>
      (await request(app.getHttpServer()).get('/offers').set('Authorization', `Bearer ${maria}`).expect(200)).body as OfferBody[];
    const debt = (await get()).find((o) => o.ruleId === 'credit_card_debt')!;
    expect(debt).toBeDefined();
    const res = await request(app.getHttpServer())
      .post(`/offers/${debt.id}/accept`)
      .set('Authorization', `Bearer ${maria}`)
      .expect(200);
    expect(res.body.precheck).toBeDefined();
    const again = (await get()).find((o) => o.id === debt.id);
    expect(again?.status).toBe('active');
  });

  it('a refused accept leaves the offer active', async () => {
    const offers = await list();
    const target = offers.find((o) => o.actionable)!;
    await prisma.offer.update({
      where: { id: target.id },
      data: { terms: { suggestedAmount: 10_000_000, monthlyContribution: null, termMonths: null, projection: null } },
    });
    const res = await post(`/offers/${target.id}/accept`);
    expect(res.status).toBeGreaterThanOrEqual(400);
    const row = await prisma.offer.findUniqueOrThrow({ where: { id: target.id } });
    expect(row.status).toBe('active');
    expect(row.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });
});
