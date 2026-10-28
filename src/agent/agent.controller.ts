import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiNotFoundResponse, ApiOkResponse, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { CurrentPrincipal, RequireScopes } from '../auth/decorators';
import { Principal } from '../auth/principal';
import { AGENT_THROTTLE } from '../security/principal-throttler.guard';
import { AgentReply, AgentService, ConversationDetail, ConversationSummary } from './agent.service';

export class AgentChatDto {
  @ApiProperty({ example: 'Am bani în plus în contul curent. Ce să fac cu ei?', minLength: 1, maxLength: 4000 })
  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  message!: string;

  @ApiPropertyOptional({ description: 'Continue an existing conversation' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  conversationId?: string;
}

@ApiTags('agent')
@ApiBearerAuth()
@RequireScopes('agent:chat')
@Throttle(AGENT_THROTTLE)
@Controller('agent')
export class AgentController {
  constructor(private readonly agent: AgentService) {}

  @Post('chat')
  @HttpCode(200)
  @ApiOkResponse({ description: 'Agent reply with recommendations, pending proposals, citations and guardrail info' })
  chat(@CurrentPrincipal() p: Principal, @Body() body: AgentChatDto): Promise<AgentReply> {
    return this.agent.chat(p, { message: body.message, conversationId: body.conversationId }, 'web');
  }

  @Get('conversations')
  @ApiOkResponse({ description: 'Own conversations, most recent first' })
  list(@CurrentPrincipal() p: Principal): Promise<ConversationSummary[]> {
    return this.agent.listConversations(p);
  }

  @Get('conversations/:id')
  @ApiOkResponse({ description: 'User/assistant messages with PII restored' })
  @ApiNotFoundResponse({ description: 'Conversația nu există' })
  get(@CurrentPrincipal() p: Principal, @Param('id') id: string): Promise<ConversationDetail> {
    return this.agent.getConversation(p, id);
  }
}
