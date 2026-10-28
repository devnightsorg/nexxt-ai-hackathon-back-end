import { Body, Controller, Get, HttpCode, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { CurrentPrincipal, RequireScopes, UserOnly } from '../auth/decorators';
import { Principal } from '../auth/principal';
import { PutSituationBody } from './dto';
import { MoneyMapService } from './money-map.service';
import type { MoneyMap, SituationDto } from './types';

@ApiTags('money-map')
@ApiBearerAuth()
@Controller()
export class MoneyMapController {
  constructor(private readonly moneyMap: MoneyMapService) {}

  @Get('profile/situation')
  @RequireScopes('profile:read')
  @ApiOkResponse({ description: 'Onboarding situation answers ({} and completedAt null when never answered)' })
  getSituation(@CurrentPrincipal() p: Principal): Promise<SituationDto> {
    return this.moneyMap.getSituation(p.userId);
  }

  @Put('profile/situation')
  @HttpCode(200)
  @UserOnly()
  @ApiOkResponse({ description: 'Replaces the situation answers and marks onboarding complete' })
  putSituation(@CurrentPrincipal() p: Principal, @Body() body: PutSituationBody): Promise<SituationDto> {
    return this.moneyMap.putSituation(p.userId, { ...body.answers });
  }

  @Get('money-map')
  @RequireScopes('profile:read', 'accounts:read')
  @ApiOkResponse({ description: 'Ladder, pillars, headline and up to 3 ranked actions (deterministic)' })
  get(@CurrentPrincipal() p: Principal): Promise<MoneyMap> {
    return this.moneyMap.getMoneyMap(p.userId);
  }
}
