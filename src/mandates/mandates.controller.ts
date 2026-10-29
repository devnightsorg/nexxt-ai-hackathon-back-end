import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiNotFoundResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { CurrentPrincipal, UserOnly } from '../auth/decorators';
import { Principal } from '../auth/principal';
import { AuthorizeMandateBody, MandateDto } from './dto';
import { MandatesService } from './mandates.service';

/** The customer's side of agent mandates, used by the PWA: sign, list, revoke. */
@ApiTags('mandates')
@ApiBearerAuth()
@UserOnly()
@Controller('mandates')
export class MandatesController {
  constructor(private readonly mandates: MandatesService) {}

  @Post('authorize')
  @HttpCode(200)
  @ApiCreatedResponse({ description: '{ redirectTo }: the agent callback with a one-time code' })
  authorize(@CurrentPrincipal() p: Principal, @Body() body: AuthorizeMandateBody): Promise<{ redirectTo: string }> {
    return this.mandates.authorize(p, body);
  }

  @Get()
  @ApiOkResponse({ description: 'Your agent mandates, newest first' })
  list(@CurrentPrincipal() p: Principal): Promise<MandateDto[]> {
    return this.mandates.list(p.userId);
  }

  @Post(':id/revoke')
  @HttpCode(200)
  @ApiOkResponse({ description: 'The revoked mandate; the agent is refused from its next call' })
  @ApiNotFoundResponse({ description: 'Mandatul nu există' })
  revoke(@CurrentPrincipal() p: Principal, @Param('id') id: string): Promise<MandateDto> {
    return this.mandates.revoke(p, id);
  }
}
