import { Global, Module } from '@nestjs/common';
import { AuditService } from './audit/audit.service';
import { GuardrailsService } from './guardrails/guardrails.service';

@Global()
@Module({
  providers: [AuditService, GuardrailsService],
  exports: [AuditService, GuardrailsService],
})
export class SecurityModule {}
