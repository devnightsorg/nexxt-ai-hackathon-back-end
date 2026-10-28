import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import bcrypt from 'bcryptjs';
import { config } from '../config/config';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../security/audit/audit.service';

export const BCRYPT_COST = 10;
const BAD_CREDENTIALS = 'Email sau parolă incorectă';

export interface LoginResult {
  accessToken: string;
  user: { id: string; email: string; fullName: string; role: 'customer' | 'admin' };
}

@Injectable()
export class AuthService {
  /** Compared against when the email is unknown, so response time does not reveal which emails exist. */
  private readonly dummyHash = bcrypt.hashSync('timing-equalizer', BCRYPT_COST);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly audit: AuditService,
  ) {}

  static hashPassword(password: string): Promise<string> {
    return bcrypt.hash(password, BCRYPT_COST);
  }

  async login(email: string, password: string): Promise<LoginResult> {
    const normalized = email.trim();
    const user = await this.prisma.user.findFirst({ where: { email: { equals: normalized, mode: 'insensitive' } } });
    const ok = await bcrypt.compare(password, user?.passwordHash ?? this.dummyHash);

    if (!user || !ok) {
      await this.audit.record({
        actorType: 'user',
        actorId: user?.id ?? null,
        userId: user?.id ?? null,
        action: 'auth.login_failed',
        verdict: 'blocked',
        details: { email: normalized },
      });
      throw new UnauthorizedException(BAD_CREDENTIALS);
    }

    await this.audit.record({ actorType: 'user', actorId: user.id, userId: user.id, action: 'auth.login' });
    const accessToken = await this.jwt.signAsync(
      { sub: user.id, role: user.role },
      { secret: config().JWT_SECRET, expiresIn: config().JWT_EXPIRES_IN as never },
    );
    return { accessToken, user: { id: user.id, email: user.email, fullName: user.fullName, role: user.role } };
  }
}
