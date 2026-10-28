import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsDefined, IsIn, IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';

/** Flat body for `POST /actions`; per-type required fields and the amount are checked by the service/policy. */
export class ProposeActionDto {
  @ApiProperty({ enum: ['transfer', 'open_product'] })
  @IsIn(['transfer', 'open_product'])
  type!: 'transfer' | 'open_product';

  @ApiProperty()
  @IsString()
  @MaxLength(64)
  fromAccountId!: string;

  @ApiPropertyOptional({ description: 'transfer: one of your own accounts (exclusive with toIban)' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  toAccountId?: string;

  @ApiPropertyOptional({ description: 'transfer: external IBAN (exclusive with toAccountId)' })
  @IsOptional()
  @IsString()
  @MaxLength(42)
  toIban?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  beneficiaryName?: string;

  @ApiPropertyOptional({ description: 'open_product: catalog slug', example: 'depozit-termen-lei' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  productSlug?: string;

  @ApiPropertyOptional({ example: 12 })
  @IsOptional()
  @IsInt()
  @Min(1)
  termMonths?: number;

  /** Validated by the policy engine (AMOUNT_INVALID) so the error stays structured. */
  @ApiProperty({ example: 1000, type: Number })
  @IsDefined()
  amount!: unknown;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(300)
  reason?: string;
}

export class ListActionsQueryDto {
  @ApiPropertyOptional({ enum: ['pending', 'rejected', 'executed', 'failed', 'expired'] })
  @IsOptional()
  @IsIn(['pending', 'rejected', 'executed', 'failed', 'expired'])
  status?: string;
}
