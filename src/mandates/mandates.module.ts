import { Module } from '@nestjs/common';
import { ActionsModule } from '../actions/actions.module';
import { AuthModule } from '../auth/auth.module';
import { MandatesController } from './mandates.controller';
import { MandatesService } from './mandates.service';
import { OauthController } from './oauth.controller';

@Module({
  imports: [AuthModule, ActionsModule],
  controllers: [OauthController, MandatesController],
  providers: [MandatesService],
  exports: [MandatesService],
})
export class MandatesModule {}
