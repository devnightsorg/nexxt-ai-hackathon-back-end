import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiNoContentResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { CurrentPrincipal, RequireScopes } from '../auth/decorators';
import { Principal } from '../auth/principal';
import { CreateGoalBody, GoalDto, UpdateGoalBody } from './dto';
import { GoalsService } from './goals.service';

@ApiTags('goals')
@ApiBearerAuth()
@Controller('goals')
export class GoalsController {
  constructor(private readonly goals: GoalsService) {}

  @Get()
  @RequireScopes('goals:read')
  @ApiOkResponse({ description: 'Financial goals of the authenticated user, with progress' })
  list(@CurrentPrincipal() p: Principal): Promise<GoalDto[]> {
    return this.goals.list(p.userId);
  }

  @Post()
  @RequireScopes('goals:write')
  create(@CurrentPrincipal() p: Principal, @Body() body: CreateGoalBody): Promise<GoalDto> {
    return this.goals.create(p.userId, body);
  }

  @Patch(':id')
  @RequireScopes('goals:write')
  update(@CurrentPrincipal() p: Principal, @Param('id') id: string, @Body() body: UpdateGoalBody): Promise<GoalDto> {
    return this.goals.update(p.userId, id, body);
  }

  @Delete(':id')
  @HttpCode(204)
  @RequireScopes('goals:write')
  @ApiNoContentResponse()
  remove(@CurrentPrincipal() p: Principal, @Param('id') id: string): Promise<void> {
    return this.goals.remove(p.userId, id);
  }
}
