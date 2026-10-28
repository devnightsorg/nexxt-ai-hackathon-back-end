import { Module } from '@nestjs/common';
import { ActionsModule } from '../actions/actions.module';
import { BankingModule } from '../banking/banking.module';
import { GoalsModule } from '../goals/goals.module';
import { ProductsModule } from '../products/products.module';
import { OffersController } from './offers.controller';
import { OffersService } from './offers.service';

@Module({
  imports: [BankingModule, GoalsModule, ProductsModule, ActionsModule],
  controllers: [OffersController],
  providers: [OffersService],
  exports: [OffersService],
})
export class OffersModule {}
