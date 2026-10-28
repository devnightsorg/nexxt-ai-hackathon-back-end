import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { CurrentPrincipal, RequireScopes } from '../auth/decorators';
import { Principal } from '../auth/principal';
import { CashflowQueryDto, parseDateParam, SpendingQueryDto } from './dto';
import { CashflowMonth, FinancialSnapshot, SpendingStats, StatsService } from './stats.service';

@ApiTags('stats')
@ApiBearerAuth()
@Controller('stats')
export class StatsController {
  constructor(private readonly stats: StatsService) {}

  @Get('spending')
  @RequireScopes('transactions:read')
  @ApiOkResponse({ description: 'Spending by category (default: current month)' })
  spending(@CurrentPrincipal() p: Principal, @Query() q: SpendingQueryDto): Promise<SpendingStats> {
    const now = new Date();
    const from = parseDateParam(q.from) ?? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const to = parseDateParam(q.to, true) ?? now;
    return this.stats.spending(p.userId, from, to);
  }

  @Get('cashflow')
  @RequireScopes('transactions:read')
  @ApiOkResponse({ description: 'Monthly income/spending/net, ascending' })
  cashflow(@CurrentPrincipal() p: Principal, @Query() q: CashflowQueryDto): Promise<CashflowMonth[]> {
    return this.stats.cashflow(p.userId, q.months ?? 6);
  }

  @Get('snapshot')
  @RequireScopes('transactions:read')
  @ApiOkResponse({ description: 'Financial snapshot computed in code (averages over last 3 complete months)' })
  snapshot(@CurrentPrincipal() p: Principal): Promise<FinancialSnapshot> {
    return this.stats.snapshot(p.userId);
  }
}
