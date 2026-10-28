import { Controller, DefaultValuePipe, Get, ParseIntPipe, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiQuery, ApiTags } from '@nestjs/swagger';
import { AdminOnly, CurrentPrincipal } from '../auth/decorators';
import { Principal } from '../auth/principal';
import { AuditEntry, AuditService } from './audit/audit.service';

export const SECURITY_EVENT_PREFIXES = ['guardrail.', 'policy.', 'action.', 'ratelimit.', 'auth.login_failed', 'mcp.'];

@ApiTags('security')
@ApiBearerAuth()
@Controller('security')
export class SecurityController {
  constructor(private readonly audit: AuditService) {}

  @Get('events')
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiOkResponse({ description: 'Security-relevant audit events (admin: all users; customer: own)' })
  events(
    @CurrentPrincipal() p: Principal,
    @Query('limit', new DefaultValuePipe(100), ParseIntPipe) limit: number,
  ): Promise<AuditEntry[]> {
    return this.audit.list({ userId: scopeUser(p), actionPrefixes: SECURITY_EVENT_PREFIXES, limit });
  }

  @Get('audit')
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiOkResponse({ description: 'Audit trail (admin: all users; customer: own)' })
  auditLog(
    @CurrentPrincipal() p: Principal,
    @Query('limit', new DefaultValuePipe(100), ParseIntPipe) limit: number,
  ): Promise<AuditEntry[]> {
    return this.audit.list({ userId: scopeUser(p), limit });
  }

  @Get('audit/verify')
  @AdminOnly()
  @ApiOkResponse({ description: 'Verifies the audit hash chain' })
  verify() {
    return this.audit.verify();
  }
}

function scopeUser(p: Principal): string | undefined {
  return p.role === 'admin' ? undefined : p.userId;
}
