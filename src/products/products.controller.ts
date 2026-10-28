import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Public } from '../auth/decorators';
import { CatalogProduct } from './catalog.types';
import { ProductsService } from './products.service';

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
}
