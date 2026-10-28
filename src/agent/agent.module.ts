import { Module } from '@nestjs/common';
import { ActionsModule } from '../actions/actions.module';
import { BankingModule } from '../banking/banking.module';
import { GoalsModule } from '../goals/goals.module';
import { KnowledgeModule } from '../knowledge/knowledge.module';
import { OffersModule } from '../offers/offers.module';
import { ProductsModule } from '../products/products.module';
import { AgentController } from './agent.controller';
import { AgentService } from './agent.service';

@Module({
  imports: [BankingModule, GoalsModule, ProductsModule, KnowledgeModule, OffersModule, ActionsModule],
  controllers: [AgentController],
  providers: [AgentService],
  exports: [AgentService],
})
export class AgentModule {}
