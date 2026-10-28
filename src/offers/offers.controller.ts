import { Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiConflictResponse, ApiNotFoundResponse, ApiOkResponse, ApiQuery, ApiTags } from '@nestjs/swagger';
import { CurrentPrincipal, RequireScopes } from '../auth/decorators';
import { Principal } from '../auth/principal';
import { OfferDto, OffersService } from './offers.service';

@ApiTags('offers')
@ApiBearerAuth()
@Controller('offers')
export class OffersController {
  constructor(private readonly offers: OffersService) {}

  @Get()
  @RequireScopes('offers:read')
  @ApiQuery({ name: 'explain', required: false, type: Boolean, description: 'Rewrite reasoning with the fast model' })
  @ApiOkResponse({ description: 'Active personalised offers, recomputed on each call; an offer keeps its id while it applies' })
  list(@CurrentPrincipal() p: Principal, @Query('explain') explain?: string): Promise<OfferDto[]> {
    return this.offers.list(p.userId, { explain: explain === 'true' || explain === '1' });
  }

  @Post(':id/accept')
  @HttpCode(200)
  @RequireScopes('actions:propose')
  @ApiOkResponse({ description: 'Accepted offer (not shown again for 7 days), plus a pending proposal (openable products) or a credit pre-check' })
  @ApiNotFoundResponse({ description: 'Oferta nu există' })
  @ApiConflictResponse({ description: 'Oferta nu mai este activă' })
  accept(@CurrentPrincipal() p: Principal, @Param('id') id: string) {
    return this.offers.accept(p, id);
  }

  @Post(':id/dismiss')
  @HttpCode(200)
  @RequireScopes('offers:read')
  @ApiOkResponse({ description: 'Dismissed offer (not regenerated for 7 days)' })
  @ApiNotFoundResponse({ description: 'Oferta nu există' })
  dismiss(@CurrentPrincipal() p: Principal, @Param('id') id: string): Promise<OfferDto> {
    return this.offers.dismiss(p, id);
  }
}
