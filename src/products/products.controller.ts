import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiProperty, ApiPropertyOptional, ApiQuery, ApiTags } from '@nestjs/swagger';
import { IsInt, IsNumber, IsOptional, IsPositive, Max, Min } from 'class-validator';
import { Public } from '../auth/decorators';
import { config } from '../config/config';
import { Projection, simulate } from '../finance/projection';
import { CatalogProduct } from './catalog.types';
import { ProductsService } from './products.service';

export class SimulateBody {
  @ApiProperty({ example: 10000 })
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  @Max(1_000_000_000)
  amount!: number;

  @ApiPropertyOptional({ example: 12 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(600)
  termMonths?: number;

  @ApiPropertyOptional({ example: 500 })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(1_000_000_000)
  monthlyContribution?: number;

  @ApiPropertyOptional({ example: 15000 })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  @Max(1_000_000_000)
  goalTarget?: number;
}

@ApiTags('products')
@ApiBearerAuth()
@Controller('products')
export class ProductsController {
  constructor(private readonly products: ProductsService) {}

  @Get()
  @Public()
  @ApiQuery({ name: 'category', required: false })
  @ApiQuery({ name: 'goodFor', required: false })
  @ApiOkResponse({ description: 'Raiffeisen product catalog, optionally filtered' })
  list(@Query('category') category?: string, @Query('goodFor') goodFor?: string): Promise<CatalogProduct[]> {
    return this.products.list({ category, goodFor });
  }

  @Get(':slug')
  @Public()
  @ApiOkResponse({ description: 'One catalog product' })
  get(@Param('slug') slug: string): Promise<CatalogProduct> {
    return this.products.get(slug);
  }

  @Post(':slug/simulate')
  @Public()
  @HttpCode(200)
  @ApiOkResponse({ description: 'Deterministic projection (interest, tax, final amount) for this product' })
  async simulate(@Param('slug') slug: string, @Body() body: SimulateBody): Promise<Projection> {
    const product = await this.products.get(slug);
    return simulate({
      product,
      amount: body.amount,
      termMonths: body.termMonths,
      monthlyContribution: body.monthlyContribution,
      goalTarget: body.goalTarget,
      interestTaxRate: config().INTEREST_TAX_RATE,
    });
  }
}
