import { Module } from '@nestjs/common';
import { AuthModule } from './auth/auth.module';
import { HealthController } from './health/health.controller';
import { PrismaModule } from './prisma/prisma.module';
import { SecurityModule } from './security/security.module';
import { SecurityController } from './security/security.controller';
import { UsersModule } from './users/users.module';

@Module({
  imports: [PrismaModule, SecurityModule, AuthModule, UsersModule],
  controllers: [HealthController, SecurityController],
})
export class AppModule {}
