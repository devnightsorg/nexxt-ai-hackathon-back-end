import { Module } from '@nestjs/common';
import { BankingModule } from '../banking/banking.module';
import { ProductsModule } from '../products/products.module';
import { ActionsController } from './actions.controller';
import { ActionsService } from './actions.service';

@Module({
  imports: [BankingModule, ProductsModule],
  controllers: [ActionsController],
  providers: [ActionsService],
  exports: [ActionsService],
})
export class ActionsModule {}
