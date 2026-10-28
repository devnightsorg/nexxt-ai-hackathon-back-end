import { Injectable, NotFoundException } from '@nestjs/common';
import { toMoney } from '../common/money';
import { PrismaService } from '../prisma/prisma.service';

export interface UserProfile {
  id: string;
  email: string;
  fullName: string;
  role: 'customer' | 'admin';
  age: number | null;
  occupation: string | null;
  monthlyIncome: number | null;
  riskProfile: 'conservative' | 'balanced' | 'dynamic';
}

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  async getProfile(userId: string): Promise<UserProfile> {
    const u = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!u) throw new NotFoundException('Utilizatorul nu există');
    return {
      id: u.id,
      email: u.email,
      fullName: u.fullName,
      role: u.role,
      age: u.age,
      occupation: u.occupation,
      monthlyIncome: u.monthlyIncome === null ? null : toMoney(u.monthlyIncome),
      riskProfile: u.riskProfile,
    };
  }
}
