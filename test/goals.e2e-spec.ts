import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { DEMO_PASSWORD } from '../src/seed/personas';
import { SeedService } from '../src/seed/seed.service';
import { createTestApp } from './utils/app';
import { loginAs } from './utils/factory';
import { resetDb } from './utils/reset-db';

const ANDREI = 'andrei.popescu@demo.ro';
const MARIA = 'maria.ionescu@demo.ro';

describe('DELETE /goals/:id', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let andrei: string;
  let maria: string;
  let userId: string;

  const api = (token: string) => ({
    get: (path: string) => request(app.getHttpServer()).get(path).set('Authorization', `Bearer ${token}`),
    post: (path: string, body?: object) =>
      request(app.getHttpServer()).post(path).set('Authorization', `Bearer ${token}`).send(body),
    del: (path: string) => request(app.getHttpServer()).delete(path).set('Authorization', `Bearer ${token}`),
  });

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
    await resetDb(prisma);
    await app.get(SeedService).run({ ingestKnowledge: false });
    andrei = await loginAs(app, ANDREI, DEMO_PASSWORD);
    maria = await loginAs(app, MARIA, DEMO_PASSWORD);
    userId = (await prisma.user.findUniqueOrThrow({ where: { email: ANDREI } })).id;
  });

  afterAll(async () => {
    await app.close();
  });

  it('rejects pending proposals for the goal, unlinks its chats, keeps the money; confirm then gives 409', async () => {
    const goal = (await api(andrei).post('/goals', { name: 'Bicicletă', type: 'custom', targetAmount: 4000 }).expect(201)).body;
    const current = await prisma.account.findFirstOrThrow({ where: { userId, type: 'current' } });
    const savings = await prisma.account.findFirst({ where: { userId, type: 'savings' } });
    const target =
      savings ??
      (await prisma.account.create({
        data: { userId, type: 'savings', name: 'Economii test', iban: 'RO49AAAA1B31007593840001', balance: 0 },
      }));
    await request(app.getHttpServer())
      .patch(`/goals/${goal.id}`)
      .set('Authorization', `Bearer ${andrei}`)
      .send({ linkedAccountId: target.id, savedAmount: 250 })
      .expect(200);
    const chat = await prisma.conversation.create({ data: { userId, channel: 'web', goalId: goal.id } });

    // One proposal tagged with the goal, one made in its goal chat without a tag, one unrelated.
    const transfer = { type: 'transfer', fromAccountId: current.id, toAccountId: target.id, amount: 100 };
    const tagged = (await api(andrei).post('/actions', { ...transfer, goalId: goal.id }).expect(201)).body;
    const inChat = await prisma.actionProposal.create({
      data: {
        userId,
        conversationId: chat.id,
        type: 'transfer',
        payload: transfer,
        policyVerdict: { allowed: true, violations: [], riskLevel: 'low' },
        proposedVia: 'agent',
        expiresAt: new Date(Date.now() + 10 * 60_000),
      },
    });
    const unrelated = (await api(andrei).post('/actions', transfer).expect(201)).body;
    const balanceBefore = (await prisma.account.findUniqueOrThrow({ where: { id: target.id } })).balance.toNumber();

    await api(andrei).del(`/goals/${goal.id}`).expect(204);

    for (const id of [tagged.id, inChat.id]) {
      const row = await prisma.actionProposal.findUniqueOrThrow({ where: { id } });
      expect(row.status).toBe('rejected');
      expect(row.result).toEqual({ reason: 'goal_deleted', goalId: goal.id });
      const res = await api(andrei).post(`/actions/${id}/confirm`).expect(409);
      expect(res.body.message).toBe('This goal was deleted.');
    }
    expect((await prisma.actionProposal.findUniqueOrThrow({ where: { id: unrelated.id } })).status).toBe('pending');
    expect((await prisma.conversation.findUniqueOrThrow({ where: { id: chat.id } })).goalId).toBeNull();
    // Money stays put: the linked account is neither closed nor changed.
    const after = await prisma.account.findUniqueOrThrow({ where: { id: target.id } });
    expect(after.status).toBe('active');
    expect(after.balance.toNumber()).toBe(balanceBefore);

    const goals = (await api(andrei).get('/goals').expect(200)).body as { id: string }[];
    expect(goals.some((g) => g.id === goal.id)).toBe(false);
    // Deleting twice: 404 (the front-end treats it as already deleted).
    await api(andrei).del(`/goals/${goal.id}`).expect(404);
  });

  it("another user's goal → 404 and it survives", async () => {
    const goal = await prisma.goal.findFirstOrThrow({ where: { userId } });
    await api(maria).del(`/goals/${goal.id}`).expect(404);
    expect(await prisma.goal.findUnique({ where: { id: goal.id } })).not.toBeNull();
  });

  it('the money map stops counting a deleted goal', async () => {
    const before = (await api(andrei).get('/money-map').expect(200)).body;
    const goals = await prisma.goal.findMany({ where: { userId } });
    for (const g of goals) await api(andrei).del(`/goals/${g.id}`).expect(204);
    const after = (await api(andrei).get('/money-map').expect(200)).body;
    expect(before.ladder[5].status).not.toBe('grey');
    expect(after.ladder[5]).toMatchObject({ key: 'goals', status: 'grey' });
  });
});
