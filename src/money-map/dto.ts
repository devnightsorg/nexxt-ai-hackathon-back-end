import { applyDecorators } from '@nestjs/common';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsDefined, IsIn, IsObject, IsOptional, ValidateNested } from 'class-validator';
import { BUFFER_BANDS, BufferBand, SituationAnswers, Tri } from './types';

const TRI_VALUES: Tri[] = [true, false, 'unknown'];

const TriProp = () =>
  applyDecorators(
    ApiPropertyOptional({ oneOf: [{ type: 'boolean' }, { type: 'string', enum: ['unknown'] }] }),
    IsOptional(),
    IsIn(TRI_VALUES),
  );

export class SituationAnswersDto implements SituationAnswers {
  @TriProp() dependents?: Tri;
  @TriProp() has_children?: Tri;
  @TriProp() income_stable?: Tri;
  @TriProp() owns_home?: Tri;
  @TriProp() has_mortgage?: Tri;
  @TriProp() renting?: Tri;
  @TriProp() money_stress?: Tri;
  @TriProp() month_end_surplus?: Tri;
  @TriProp() relies_on_credit?: Tri;
  @TriProp() debt_ifn_bnpl?: Tri;
  @TriProp() card_revolving?: Tri;
  @TriProp() debt_bank_loan?: Tri;
  @TriProp() ins_life?: Tri;
  @TriProp() ins_home?: Tri;
  @TriProp() retirement_saving?: Tri;

  @ApiPropertyOptional({ enum: BUFFER_BANDS })
  @IsOptional()
  @IsIn(BUFFER_BANDS)
  buffer_band?: BufferBand;
}

export class PutSituationBody {
  @ApiProperty({ type: SituationAnswersDto })
  @IsDefined()
  @IsObject()
  @ValidateNested()
  @Type(() => SituationAnswersDto)
  answers!: SituationAnswersDto;
}
