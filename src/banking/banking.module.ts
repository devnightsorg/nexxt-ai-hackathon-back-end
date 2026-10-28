import { Module } from '@nestjs/common';
import { AccountsController } from './accounts.controller';
import { AccountsService } from './accounts.service';
import { LedgerService } from './ledger.service';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';
import { StatsController } from './stats.controller';
import { StatsService } from './stats.service';

@Module({
  controllers: [AccountsController, PaymentsController, StatsController],
  providers: [AccountsService, LedgerService, PaymentsService, StatsService],
  exports: [AccountsService, LedgerService, PaymentsService, StatsService],
})
export class BankingModule {}
