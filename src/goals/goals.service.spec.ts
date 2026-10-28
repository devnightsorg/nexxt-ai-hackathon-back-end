import { Account, Goal, Prisma } from '@prisma/client';
import { toGoalDto } from './goals.service';

const NOW = new Date('2026-10-28T12:00:00Z');

function goal(g: Partial<Goal> = {}): Goal {
  return {
    id: 'g1',
    userId: 'u1',
    name: 'Dacia Spring',
    type: 'car',
    targetAmount: new Prisma.Decimal(8000),
    currency: 'RON',
    targetDate: new Date('2027-10-28T00:00:00Z'),
    linkedAccountId: null,
    savedAmount: new Prisma.Decimal(0),
    priority: 2,
    status: 'active',
    createdAt: NOW,
    ...g,
  };
}

const account = (balance: number) => ({ id: 'a1', balance: new Prisma.Decimal(balance) }) as unknown as Account;

describe('toGoalDto progress', () => {
  it('no linked account → savedAmount', () => {
    const dto = toGoalDto({ ...goal({ savedAmount: new Prisma.Decimal(400) }), linkedAccount: null }, NOW);
    expect(dto.currentAmount).toBe(400);
    expect(dto.progressPct).toBe(5);
  });

  it('linked account (opened for the goal) plus money put toward it elsewhere', () => {
    const dto = toGoalDto({ ...goal({ linkedAccountId: 'a1', savedAmount: new Prisma.Decimal(100) }), linkedAccount: account(500) }, NOW);
    expect(dto.currentAmount).toBe(600);
    expect(dto.progressPct).toBe(7.5);
    expect(dto.requiredMonthlySaving).toBe(616.67);
  });
});
