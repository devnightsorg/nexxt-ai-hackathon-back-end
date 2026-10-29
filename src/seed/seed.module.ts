import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { KnowledgeModule } from '../knowledge/knowledge.module';
import { ProductsModule } from '../products/products.module';
import { DemoController } from './demo.controller';
import { SeedService } from './seed.service';

@Module({
  imports: [ProductsModule, AuthModule, KnowledgeModule],
  controllers: [DemoController],
  providers: [SeedService],
  exports: [SeedService],
})
export class SeedModule {}
