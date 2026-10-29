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
    // SEED_RESET=andrei,maria: delete those demo personas (cascades to all their data) so the run recreates them fresh.
    const reset = (process.env.SEED_RESET ?? '').split(',').map((k) => k.trim()).filter(Boolean);
    if (reset.length) {
      const count = await app.get(SeedService).resetPersonas(reset);
      console.log(`seed: reset ${count} persona(s): ${reset.join(', ')}`);
    } else {
      await app.get(SeedService).run();
    }
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
