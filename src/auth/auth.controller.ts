import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiProperty, ApiTags, ApiUnauthorizedResponse } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { AuthService, LoginResult } from './auth.service';
import { Public } from './decorators';

export class LoginDto {
  @ApiProperty({ example: 'ana.popescu@example.ro' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(254)
  email!: string;

  @ApiProperty({ example: 'Parola123!' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  password!: string;
}

@ApiTags('auth')
@ApiBearerAuth()
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('login')
  @HttpCode(200)
  @ApiOkResponse({ description: 'JWT access token and the logged-in user' })
  @ApiUnauthorizedResponse({ description: 'Email sau parolă incorectă' })
  login(@Body() dto: LoginDto): Promise<LoginResult> {
    return this.auth.login(dto.email, dto.password);
  }
}
