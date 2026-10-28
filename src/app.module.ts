import { Module } from '@nestjs/common';
import { AuthModule } from './auth/auth.module';
import { BankingModule } from './banking/banking.module';
import { GoalsModule } from './goals/goals.module';
import { HealthController } from './health/health.controller';
import { KnowledgeModule } from './knowledge/knowledge.module';
import { LlmModule } from './llm/llm.module';
import { PrismaModule } from './prisma/prisma.module';
import { ProductsModule } from './products/products.module';
import { SecurityModule } from './security/security.module';
import { UsersModule } from './users/users.module';

@Module({
  imports: [
    PrismaModule,
    SecurityModule,
    AuthModule,
    UsersModule,
    LlmModule,
    KnowledgeModule,
    ProductsModule,
    GoalsModule,
    BankingModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
