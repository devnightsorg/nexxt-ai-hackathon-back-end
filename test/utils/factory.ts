import { INestApplication } from '@nestjs/common';
import { Prisma, User } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { PrismaService } from '../../src/prisma/prisma.service';

export interface UserOverrides extends Partial<Omit<Prisma.UserCreateInput, 'passwordHash'>> {
  password?: string;
}

/** Inserts a user (low bcrypt cost for speed; compare works regardless of cost). */
export async function createUser(prisma: PrismaService, over: UserOverrides = {}): Promise<{ user: User; password: string }> {
  const { password = 'Parola123!', ...rest } = over;
  const user = await prisma.user.create({
    data: {
      email: `user-${randomUUID().slice(0, 8)}@test.ro`,
      fullName: 'Ion Test',
      age: 30,
      occupation: 'inginer',
      monthlyIncome: 8000,
      ...rest,
      passwordHash: await bcrypt.hash(password, 4),
    },
  });
  return { user, password };
}

export async function loginAs(app: INestApplication, email: string, password: string): Promise<string> {
  const res = await request(app.getHttpServer()).post('/auth/login').send({ email, password }).expect(200);
  return res.body.accessToken as string;
}
