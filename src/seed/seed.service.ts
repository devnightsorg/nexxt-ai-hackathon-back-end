import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { hashApiKey, ApiKeysService } from '../auth/api-keys.service';
import { AuthService } from '../auth/auth.service';
import { SCOPES } from '../auth/principal';
import { generateIban } from '../common/iban';
import { config } from '../config/config';
import { IngestSummary, KnowledgeService } from '../knowledge/knowledge.service';
import { PrismaService } from '../prisma/prisma.service';
import { ProductsService } from '../products/products.service';
import { DEMO_KEY_MAX_AMOUNT, DEMO_KEY_NAME, demoApiKey } from './demo-keys';
import { ADMIN_EMAIL, ADMIN_NAME, DEMO_PASSWORD, PERSONAS, PersonaSpec } from './personas';
import { generateReconciled } from './transactions';

export interface SeedCredential {
  email: string;
  password: string;
  apiKey: string | null;
}

export interface SeedSummary {
  products: number;
  usersCreated: number;
  accountsCreated: number;
  transactionsCreated: number;
  goalsCreated: number;
  apiKeysCreated: number;
  knowledge: IngestSummary | null;
  credentials: SeedCredential[];
}

export interface SeedRunOptions {
  anchor?: Date;
  ingestKnowledge?: boolean;
}

const BASE_SEED = 42;

function addMonths(d: Date, months: number): Date {
  const r = new Date(d.getTime());
  r.setUTCMonth(r.getUTCMonth() + months);
  return r;
}

@Injectable()
export class SeedService {
  private readonly logger = new Logger(SeedService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly products: ProductsService,
    private readonly apiKeys: ApiKeysService,
    private readonly knowledge: KnowledgeService,
  ) {}

  /** Idempotent: catalog always synced; users, accounts, history and demo keys created only when absent. */
  async run(opts: SeedRunOptions = {}): Promise<SeedSummary> {
    const anchor = opts.anchor ?? new Date();
    const summary: SeedSummary = {
      products: await this.products.syncCatalog(),
      usersCreated: 0,
      accountsCreated: 0,
      transactionsCreated: 0,
      goalsCreated: 0,
      apiKeysCreated: 0,
      knowledge: null,
      credentials: [],
    };

    const passwordHash = await AuthService.hashPassword(DEMO_PASSWORD);

    if (!(await this.prisma.user.findUnique({ where: { email: ADMIN_EMAIL } }))) {
      await this.prisma.user.create({ data: { email: ADMIN_EMAIL, passwordHash, fullName: ADMIN_NAME, role: 'admin' } });
      summary.usersCreated++;
    }
    summary.credentials.push({ email: ADMIN_EMAIL, password: DEMO_PASSWORD, apiKey: null });

    const jwtSecret = config().JWT_SECRET;
    for (const [index, persona] of PERSONAS.entries()) {
      let user = await this.prisma.user.findUnique({ where: { email: persona.email } });
      if (!user) {
        user = await this.createPersona(persona, index, passwordHash, anchor, summary);
        summary.usersCreated++;
      }

      const key = demoApiKey(jwtSecret, persona.key);
      if (!(await this.prisma.apiKey.findUnique({ where: { hash: hashApiKey(key) } }))) {
        await this.apiKeys.createWithKey(user.id, key, {
          name: DEMO_KEY_NAME,
          scopes: [...SCOPES],
          maxAmountPerAction: DEMO_KEY_MAX_AMOUNT,
        });
        summary.apiKeysCreated++;
      }
      summary.credentials.push({ email: persona.email, password: DEMO_PASSWORD, apiKey: key });
    }

    if (opts.ingestKnowledge !== false) {
      try {
        summary.knowledge = await this.knowledge.ingestDirectory();
      } catch (err) {
        this.logger.warn(`Knowledge ingestion failed, continuing without it: ${(err as Error).message}`);
      }
    }

    this.printCredentials(summary);
    return summary;
  }

  private async createPersona(p: PersonaSpec, index: number, passwordHash: string, anchor: Date, summary: SeedSummary) {
    return this.prisma.$transaction(
      async (tx) => {
        const user = await tx.user.create({
          data: {
            email: p.email,
            passwordHash,
            fullName: p.fullName,
            role: 'customer',
            age: p.age,
            occupation: p.occupation,
            monthlyIncome: new Prisma.Decimal(p.monthlyIncome),
            riskProfile: p.riskProfile,
          },
        });

        for (const [ai, acc] of p.accounts.entries()) {
          const iban = generateIban((index + 1) * 100 + ai + 1);
          const account = await tx.account.create({
            data: {
              userId: user.id,
              type: acc.type,
              productSlug: acc.productSlug,
              name: acc.name,
              iban,
              balance: new Prisma.Decimal(acc.balance),
              openedAt: addMonths(anchor, -24),
            },
          });
          summary.accountsCreated++;

          if (acc.type === 'current') {
            const history = generateReconciled(p, acc.balance, anchor, BASE_SEED + index * 1000);
            if (history.minBalance < 0) {
              this.logger.warn(`${p.key}: synthetic history dips to ${history.minBalance} RON (anchor ${anchor.toISOString()})`);
            }
            await tx.transaction.createMany({
              data: history.rows.map((r) => ({
                accountId: account.id,
                direction: r.direction,
                amount: new Prisma.Decimal(r.amount.toFixed(2)),
                category: r.category,
                counterpartyName: r.counterpartyName,
                description: r.description,
                bookedAt: r.bookedAt,
                balanceAfter: new Prisma.Decimal(r.balanceAfter.toFixed(2)),
              })),
            });
            summary.transactionsCreated += history.rows.length;
          }
        }

        for (const g of p.goals) {
          await tx.goal.create({
            data: {
              userId: user.id,
              name: g.name,
              type: g.type,
              targetAmount: new Prisma.Decimal(g.targetAmount),
              targetDate: g.monthsFromAnchor != null ? addMonths(anchor, g.monthsFromAnchor) : null,
            },
          });
          summary.goalsCreated++;
        }
        return user;
      },
      { timeout: 60_000 },
    );
  }

  private printCredentials(s: SeedSummary): void {
    const rows = s.credentials.map((c) => [c.email, c.password, c.apiKey ?? '-']);
    const header = ['email', 'password', 'demo API key'];
    const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
    const line = (cols: string[]) => '| ' + cols.map((c, i) => c.padEnd(widths[i])).join(' | ') + ' |';
    const sep = '+' + widths.map((w) => '-'.repeat(w + 2)).join('+') + '+';
    const table = [sep, line(header), sep, ...rows.map(line), sep].join('\n');
    this.logger.log(
      `Seed done: ${s.products} products, ${s.usersCreated} users, ${s.transactionsCreated} transactions, ` +
        `${s.apiKeysCreated} demo keys created${s.knowledge ? `, ${s.knowledge.documents} KB documents` : ''}`,
    );
    // Plain console output so the table survives log formatting in `docker compose logs`.
    console.log(`Demo credentials:\n${table}`);
  }
}
