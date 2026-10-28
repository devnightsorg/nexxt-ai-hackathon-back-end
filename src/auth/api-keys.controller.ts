import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiOkResponse, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { ArrayNotEmpty, IsArray, IsIn, IsNotEmpty, IsNumber, IsOptional, IsPositive, IsString, MaxLength } from 'class-validator';
import { actorFromPrincipal, Principal, Scope, SCOPES } from './principal';
import { AuditService } from '../security/audit/audit.service';
import { ApiKeySummary, ApiKeysService, CreatedApiKey } from './api-keys.service';
import { CurrentPrincipal, UserOnly } from './decorators';

export class CreateApiKeyDto {
  @ApiProperty({ example: 'Agent extern' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name!: string;

  @ApiProperty({ enum: SCOPES, isArray: true, example: ['accounts:read'] })
  @IsArray()
  @ArrayNotEmpty()
  @IsIn(SCOPES, { each: true })
  scopes!: Scope[];

  @ApiPropertyOptional({ example: 500 })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  maxAmountPerAction?: number;
}

@ApiTags('api-keys')
@ApiBearerAuth()
@UserOnly()
@Controller('api-keys')
export class ApiKeysController {
  constructor(
    private readonly keys: ApiKeysService,
    private readonly audit: AuditService,
  ) {}

  @Post()
  @ApiCreatedResponse({ description: 'The new key; the raw key is returned only once' })
  async create(@CurrentPrincipal() p: Principal, @Body() dto: CreateApiKeyDto): Promise<CreatedApiKey> {
    const created = await this.keys.create(p.userId, dto);
    await this.audit.record({
      ...actorFromPrincipal(p),
      userId: p.userId,
      action: 'apikey.created',
      resource: `apikey:${created.id}`,
      details: { name: dto.name, prefix: created.prefix, scopes: created.scopes },
    });
    return created;
  }

  @Get()
  @ApiOkResponse({ description: 'API keys of the user (no secrets)' })
  list(@CurrentPrincipal() p: Principal): Promise<ApiKeySummary[]> {
    return this.keys.list(p.userId);
  }

  @Delete(':id')
  @ApiOkResponse({ description: 'Revoked key' })
  async revoke(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    const result = await this.keys.revoke(p.userId, id);
    await this.audit.record({
      ...actorFromPrincipal(p),
      userId: p.userId,
      action: 'apikey.revoked',
      resource: `apikey:${id}`,
    });
    return result;
  }
}
