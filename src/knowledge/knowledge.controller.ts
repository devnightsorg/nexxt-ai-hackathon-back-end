import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsInt, IsOptional, IsString, IsUrl, Max, MaxLength, Min, MinLength } from 'class-validator';
import { AdminOnly } from '../auth/decorators';
import { KbHit, KnowledgeService } from './knowledge.service';

export class SearchKnowledgeQuery {
  @ApiProperty({ description: 'Search query' })
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  q!: string;

  @ApiPropertyOptional({ default: 5, minimum: 1, maximum: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(20)
  k?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(64)
  category?: string;
}

export class AddDocumentDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title!: string;

  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  category!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  productSlug?: string;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsUrl({}, { each: true })
  sourceUrls?: string[];

  @ApiProperty({ description: 'Markdown content' })
  @IsString()
  @MinLength(1)
  @MaxLength(200_000)
  content!: string;
}

@ApiTags('knowledge')
@ApiBearerAuth()
@Controller('knowledge')
export class KnowledgeController {
  constructor(private readonly knowledge: KnowledgeService) {}

  @Get('search')
  @ApiOkResponse({ description: 'Knowledge base hits (cosine similarity, full-text fallback)' })
  search(@Query() q: SearchKnowledgeQuery): Promise<KbHit[]> {
    return this.knowledge.search(q.q, { k: q.k, category: q.category });
  }

  @Post('documents')
  @AdminOnly()
  @ApiOkResponse({ description: 'Document added and chunked' })
  add(@Body() dto: AddDocumentDto): Promise<{ id: string; chunks: number }> {
    return this.knowledge.addDocument(dto);
  }
}
