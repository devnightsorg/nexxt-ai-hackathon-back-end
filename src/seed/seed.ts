import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { LlmModule } from '../llm/llm.module';
import { PrismaModule } from '../prisma/prisma.module';
import { SecurityModule } from '../security/security.module';
import { SeedModule } from './seed.module';
import { SeedService } from './seed.service';

/** Minimal module graph for the seed CLI (no HTTP server). */
@Module({ imports: [PrismaModule, SecurityModule, LlmModule, SeedModule] })
class SeedCliModule {}

async function main(): Promise<void> {
  if (process.env.SEED_ON_START === 'false') {
    console.log('seed: skipped (SEED_ON_START=false)');
    return;
  }
  const app = await NestFactory.createApplicationContext(SeedCliModule, { logger: ['log', 'warn', 'error'] });
  try {
    await app.get(SeedService).run();
  } finally {
    await app.close();
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error('seed failed:', err);
    process.exit(1);
  },
);
