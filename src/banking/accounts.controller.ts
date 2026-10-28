import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiNotFoundResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { CurrentPrincipal, RequireScopes } from '../auth/decorators';
import { Principal } from '../auth/principal';
import { AccountsService } from './accounts.service';
import { AccountDto, TransactionDto, TransactionsQueryDto } from './dto';

@ApiTags('accounts')
@ApiBearerAuth()
@Controller('accounts')
export class AccountsController {
  constructor(private readonly accounts: AccountsService) {}

  @Get()
  @RequireScopes('accounts:read')
  @ApiOkResponse({ description: 'Accounts of the authenticated user' })
  list(@CurrentPrincipal() p: Principal): Promise<AccountDto[]> {
    return this.accounts.listForUser(p.userId);
  }

  @Get(':id/transactions')
  @RequireScopes('transactions:read')
  @ApiOkResponse({ description: 'Paginated transactions of one own account, newest first' })
  @ApiNotFoundResponse({ description: 'Contul nu există' })
  transactions(
    @CurrentPrincipal() p: Principal,
    @Param('id') id: string,
    @Query() q: TransactionsQueryDto,
  ): Promise<{ items: TransactionDto[]; total: number }> {
    return this.accounts.listTransactions(p.userId, id, q);
  }
}
