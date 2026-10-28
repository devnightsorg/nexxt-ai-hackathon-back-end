import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { CurrentPrincipal, RequireScopes } from '../auth/decorators';
import { Principal } from '../auth/principal';
import { UserProfile, UsersService } from './users.service';

@ApiTags('users')
@ApiBearerAuth()
@Controller('me')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  @RequireScopes('profile:read')
  @ApiOkResponse({ description: 'Profile of the authenticated user' })
  me(@CurrentPrincipal() p: Principal): Promise<UserProfile> {
    return this.users.getProfile(p.userId);
  }
}
