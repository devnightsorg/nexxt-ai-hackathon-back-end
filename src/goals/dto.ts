import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { GoalStatus, GoalType } from '@prisma/client';
import {
  IsDateString,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';

export interface GoalDto {
  id: string;
  name: string;
  type: GoalType;
  targetAmount: number;
  currency: string;
  targetDate: string | null;
  linkedAccountId: string | null;
  priority: number;
  status: GoalStatus;
  currentAmount: number;
  progressPct: number;
  monthsLeft: number | null;
  requiredMonthlySaving: number | null;
}

export class CreateGoalBody {
  @ApiProperty({ example: 'Excursie în Japonia' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name!: string;

  @ApiProperty({ enum: GoalType })
  @IsEnum(GoalType)
  type!: GoalType;

  @ApiProperty({ example: 15000 })
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  @Max(1_000_000_000)
  targetAmount!: number;

  @ApiPropertyOptional({ example: '2027-06-30' })
  @IsOptional()
  @IsDateString()
  targetDate?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  linkedAccountId?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 5, default: 2 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(5)
  priority?: number;
}

export class UpdateGoalBody {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name?: string;

  @ApiPropertyOptional({ enum: GoalType })
  @IsOptional()
  @IsEnum(GoalType)
  type?: GoalType;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  @Max(1_000_000_000)
  targetAmount?: number;

  @ApiPropertyOptional({ nullable: true, description: 'null clears the date' })
  @ValidateIf((o: UpdateGoalBody) => o.targetDate !== undefined && o.targetDate !== null)
  @IsDateString()
  targetDate?: string | null;

  @ApiPropertyOptional({ nullable: true, description: 'null unlinks the account' })
  @ValidateIf((o: UpdateGoalBody) => o.linkedAccountId !== undefined && o.linkedAccountId !== null)
  @IsUUID()
  linkedAccountId?: string | null;

  @ApiPropertyOptional({ minimum: 1, maximum: 5 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(5)
  priority?: number;

  @ApiPropertyOptional({ enum: GoalStatus })
  @IsOptional()
  @IsEnum(GoalStatus)
  status?: GoalStatus;

  @ApiPropertyOptional({ description: 'Savings toward the goal outside its linked account (added to that balance)' })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(1_000_000_000)
  savedAmount?: number;
}
