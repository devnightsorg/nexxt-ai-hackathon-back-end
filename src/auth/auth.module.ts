import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { config } from '../config/config';
import { AuthController } from './auth.controller';
import { AuthGuard } from './auth.guard';
import { AuthService } from './auth.service';

@Module({
  imports: [JwtModule.registerAsync({ useFactory: () => ({ secret: config().JWT_SECRET }) })],
  controllers: [AuthController],
  providers: [AuthService, AuthGuard, { provide: APP_GUARD, useExisting: AuthGuard }],
  exports: [AuthService, JwtModule],
})
export class AuthModule {}
