import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/main';
import { PrismaService } from '../../src/prisma/prisma.service';

export interface CreateTestAppOptions {
  /** LlmService replacement; wired in once LlmService exists (defaults to FakeLlmService). */
  llm?: unknown;
}

export async function createTestApp(
  opts: CreateTestAppOptions = {},
): Promise<{ app: INestApplication; prisma: PrismaService }> {
  void opts;
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication({ logger: ['error', 'warn'] });
  configureApp(app);
  await app.init();
  return { app, prisma: app.get(PrismaService) };
}
