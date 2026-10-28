import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiTags,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import { CurrentPrincipal, RequireScopes } from '../auth/decorators';
import { Principal } from '../auth/principal';
import { ActionsService, ProposalDto } from './actions.service';
import { ListActionsQueryDto, ProposeActionDto } from './dto';
import { ProposeInput } from './policy';

@ApiTags('actions')
@ApiBearerAuth()
@Controller('actions')
export class ActionsController {
  constructor(private readonly actions: ActionsService) {}

  @Get()
  @RequireScopes('actions:propose')
  @ApiOkResponse({ description: 'Your action proposals, newest first' })
  list(@CurrentPrincipal() p: Principal, @Query() q: ListActionsQueryDto): Promise<ProposalDto[]> {
    return this.actions.list(p, q.status);
  }

  @Get(':id')
  @ApiOkResponse({ description: 'One proposal' })
  @ApiNotFoundResponse({ description: 'Propunerea nu există' })
  get(@CurrentPrincipal() p: Principal, @Param('id') id: string): Promise<ProposalDto> {
    return this.actions.get(p, id);
  }

  @Post()
  @RequireScopes('actions:propose')
  @ApiCreatedResponse({ description: 'Pending proposal awaiting confirmation' })
  @ApiUnprocessableEntityResponse({ description: 'PolicyDenied with violations[]' })
  propose(@CurrentPrincipal() p: Principal, @Body() dto: ProposeActionDto): Promise<ProposalDto> {
    return this.actions.propose(p, dto as unknown as ProposeInput, {
      proposedVia: p.kind === 'api_key' ? 'api_key' : 'rest',
    });
  }

  @Post(':id/confirm')
  @HttpCode(200)
  @RequireScopes('actions:confirm')
  @ApiOkResponse({ description: 'Executed proposal with result' })
  @ApiConflictResponse({ description: 'Propunerea nu mai poate fi confirmată' })
  @ApiUnprocessableEntityResponse({ description: 'PolicyDenied at confirmation time' })
  confirm(@CurrentPrincipal() p: Principal, @Param('id') id: string): Promise<ProposalDto> {
    return this.actions.confirm(p, id);
  }

  @Post(':id/reject')
  @HttpCode(200)
  @RequireScopes('actions:propose')
  @ApiOkResponse({ description: 'Rejected proposal' })
  reject(@CurrentPrincipal() p: Principal, @Param('id') id: string): Promise<ProposalDto> {
    return this.actions.reject(p, id);
  }
}
