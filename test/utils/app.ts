import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../../src/app.module';
import { LlmService } from '../../src/llm/llm.service';
import { configureApp } from '../../src/main';
import { PrismaService } from '../../src/prisma/prisma.service';
import { FakeLlmService } from './fake-llm';

export interface CreateTestAppOptions {
  /** LlmService replacement (defaults to a new FakeLlmService). */
  llm?: FakeLlmService;
}

export async function createTestApp(
  opts: CreateTestAppOptions = {},
): Promise<{ app: INestApplication; prisma: PrismaService; llm: FakeLlmService }> {
  const llm = opts.llm ?? new FakeLlmService();
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(LlmService)
    .useValue(llm)
    .compile();
  const app = moduleRef.createNestApplication({ logger: ['error', 'warn'] });
  configureApp(app);
  await app.init();
  return { app, prisma: app.get(PrismaService), llm };
}
