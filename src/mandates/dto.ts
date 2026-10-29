import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsObject, IsOptional, IsString, MaxLength } from 'class-validator';
import { MandatePermissions } from '../auth/principal';

export interface MandateActionDto {
  id: string;
  summary: string;
  type: 'transfer' | 'open_product';
  amount: number;
  status: 'pending' | 'rejected' | 'executed' | 'failed' | 'expired';
  /** True when the mandate executed it without the customer's tap. */
  autoApproved: boolean;
  createdAt: Date;
}

export interface MandateDto {
  id: string;
  clientName: string;
  status: 'active' | 'revoked' | 'expired';
  permissions: MandatePermissions;
  autoApproveUpTo: number;
  totalLimit: number;
  /** RON executed under the mandate so far. */
  used: number;
  expiresAt: Date | null;
  createdAt: Date;
  lastUsedAt: Date | null;
  /** Last 3 actions the agent asked for. */
  recentActions: MandateActionDto[];
}

/** The customer signs the mandate on the PWA screen the OAuth authorize step redirected to. */
export class AuthorizeMandateBody {
  @ApiProperty({ description: 'OAuth client_id from the authorize request' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(512)
  clientId!: string;

  @ApiProperty({ example: 'https://claude.ai/api/mcp/auth_callback' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(2048)
  redirectUri!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  state?: string;

  @ApiPropertyOptional({ description: 'Accepted and ignored: the demo flow does not verify PKCE' })
  @IsOptional()
  @IsString()
  @MaxLength(256)
  codeChallenge?: string;

  @ApiProperty({ example: { read: true, deposits: true, ownTransfers: true, externalPayments: true } })
  @IsObject()
  permissions!: MandatePermissions;
}
