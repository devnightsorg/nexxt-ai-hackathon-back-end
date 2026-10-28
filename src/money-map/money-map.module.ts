import { Module } from '@nestjs/common';
import { BankingModule } from '../banking/banking.module';
import { GoalsModule } from '../goals/goals.module';
import { ProductsModule } from '../products/products.module';
import { MoneyMapController } from './money-map.controller';
import { MoneyMapService } from './money-map.service';

@Module({
  imports: [BankingModule, GoalsModule, ProductsModule],
  controllers: [MoneyMapController],
  providers: [MoneyMapService],
  exports: [MoneyMapService],
})
export class MoneyMapModule {}
