import { Global, Module } from '@nestjs/common';
import { AuditService } from './audit/audit.service';

@Global()
@Module({
  providers: [AuditService],
  exports: [AuditService],
})
export class SecurityModule {}
