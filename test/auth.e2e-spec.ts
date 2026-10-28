import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { createTestApp } from './utils/app';
import { createUser, loginAs } from './utils/factory';
import { resetDb } from './utils/reset-db';

describe('auth', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
    await resetDb(prisma);
  });

  afterAll(async () => {
    await app.close();
  });

  it('login ok → accessToken; GET /me with it → 200 user data, no passwordHash', async () => {
    const { user, password } = await createUser(prisma, { fullName: 'Ana Popescu' });
    const token = await loginAs(app, user.email, password);
    const res = await request(app.getHttpServer()).get('/me').set('Authorization', `Bearer ${token}`).expect(200);
    expect(res.body).toEqual({
      id: user.id,
      email: user.email,
      fullName: 'Ana Popescu',
      role: 'customer',
      age: 30,
      occupation: 'inginer',
      monthlyIncome: 8000,
      riskProfile: 'conservative',
    });
    expect(res.body.passwordHash).toBeUndefined();
  });

  it('login wrong password → 401 and an auth.login_failed audit row', async () => {
    const { user } = await createUser(prisma);
    const res = await request(app.getHttpServer()).post('/auth/login').send({ email: user.email, password: 'gresit' }).expect(401);
    expect(res.body.message).toBe('Email sau parolă incorectă');
    const row = await prisma.auditLog.findFirst({ where: { action: 'auth.login_failed', userId: user.id } });
    expect(row).toMatchObject({ verdict: 'blocked', details: { email: user.email } });
  });

  it('GET /me without token → 401; with garbage token → 401', async () => {
    const none = await request(app.getHttpServer()).get('/me').expect(401);
    expect(none.body.message).toBe('Autentificare necesară');
    await request(app.getHttpServer()).get('/me').set('Authorization', 'Bearer garbage').expect(401);
    await request(app.getHttpServer()).get('/me').set('Authorization', 'Bearer rk_unknown').expect(401);
  });

  it('GET /health stays public', async () => {
    await request(app.getHttpServer()).get('/health').expect(200);
  });
});
