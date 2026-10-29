import { Module } from '@nestjs/common';
import { ActionsModule } from '../actions/actions.module';
import { AgentModule } from '../agent/agent.module';
import { BankingModule } from '../banking/banking.module';
import { GoalsModule } from '../goals/goals.module';
import { KnowledgeModule } from '../knowledge/knowledge.module';
import { MandatesModule } from '../mandates/mandates.module';
import { MoneyMapModule } from '../money-map/money-map.module';
import { OffersModule } from '../offers/offers.module';
import { ProductsModule } from '../products/products.module';
import { UsersModule } from '../users/users.module';
import { McpController } from './mcp.controller';

@Module({
  imports: [UsersModule, BankingModule, GoalsModule, OffersModule, MoneyMapModule, KnowledgeModule, ProductsModule, AgentModule, ActionsModule, MandatesModule],
  controllers: [McpController],
})
export class McpModule {}
