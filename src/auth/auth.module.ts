import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { ThrottlerModule } from '@nestjs/throttler';
import { config } from '../config/config';
import { DEFAULT_THROTTLE, PrincipalThrottlerGuard } from '../security/principal-throttler.guard';
import { ApiKeysController } from './api-keys.controller';
import { ApiKeysService } from './api-keys.service';
import { AuthController } from './auth.controller';
import { AuthGuard } from './auth.guard';
import { AuthService } from './auth.service';

@Module({
  imports: [
    JwtModule.registerAsync({ useFactory: () => ({ secret: config().JWT_SECRET }) }),
    ThrottlerModule.forRoot({ throttlers: [{ name: 'default', ...DEFAULT_THROTTLE.default }] }),
  ],
  controllers: [AuthController, ApiKeysController],
  providers: [
    AuthService,
    ApiKeysService,
    AuthGuard,
    // Order matters: AuthGuard resolves the principal first, then the throttler keys on it.
    { provide: APP_GUARD, useExisting: AuthGuard },
    { provide: APP_GUARD, useClass: PrincipalThrottlerGuard },
  ],
  exports: [AuthService, ApiKeysService, JwtModule],
})
export class AuthModule {}
