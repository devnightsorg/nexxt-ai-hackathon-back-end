import { Body, Controller, Post } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiTags,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import { CurrentPrincipal, UserOnly } from '../auth/decorators';
import { Principal } from '../auth/principal';
import { CreatePaymentDto } from './dto';
import { PaymentResult, PaymentsService } from './payments.service';

@ApiTags('payments')
@ApiBearerAuth()
@Controller('payments')
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Post()
  @UserOnly()
  @ApiCreatedResponse({ description: 'Payment executed' })
  @ApiBadRequestResponse({ description: 'Sumă sau IBAN invalid' })
  @ApiForbiddenResponse({ description: 'API keys cannot move money' })
  @ApiUnprocessableEntityResponse({ description: 'Fonduri insuficiente' })
  create(@CurrentPrincipal() p: Principal, @Body() dto: CreatePaymentDto): Promise<PaymentResult> {
    return this.payments.create(p, dto);
  }
}
