import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { KnowledgeModule } from '../knowledge/knowledge.module';
import { ProductsModule } from '../products/products.module';
import { SeedService } from './seed.service';

@Module({
  imports: [ProductsModule, AuthModule, KnowledgeModule],
  providers: [SeedService],
  exports: [SeedService],
})
export class SeedModule {}
