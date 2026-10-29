import { Controller, ForbiddenException, HttpCode, NotFoundException, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { CurrentPrincipal, UserOnly } from '../auth/decorators';
import { Principal } from '../auth/principal';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../security/audit/audit.service';
import { PERSONAS } from './personas';
import { SeedService } from './seed.service';

/** Demo helpers for the PWA (hackathon only). */
@ApiTags('demo')
@ApiBearerAuth()
@UserOnly()
@Controller('demo')
export class DemoController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly seed: SeedService,
    private readonly audit: AuditService,
  ) {}

  /** Resets the signed-in demo persona to its seeded state. The user id changes: the caller must sign in again. */
  @Post('reset')
  @HttpCode(200)
  @ApiOkResponse({ description: '{ persona }: the persona key that was reset' })
  async reset(@CurrentPrincipal() p: Principal): Promise<{ persona: string }> {
    const user = await this.prisma.user.findUnique({ where: { id: p.userId }, select: { email: true } });
    if (!user) throw new NotFoundException('Utilizatorul nu există');
    const persona = PERSONAS.find((x) => x.email === user.email);
    if (!persona) throw new ForbiddenException('Doar personele demo pot fi resetate');
    await this.seed.resetPersonas([persona.key]);
    await this.audit.record({ actorType: 'user', actorId: p.userId, userId: p.userId, action: 'demo.reset', details: { persona: persona.key } });
    return { persona: persona.key };
  }
}
