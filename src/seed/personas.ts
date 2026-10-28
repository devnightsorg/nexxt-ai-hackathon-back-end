import { AccountType, GoalType, RiskProfile } from '@prisma/client';

export type PersonaKey = 'andrei' | 'maria' | 'ion' | 'elena';

export type TxnCategory =
  | 'salary'
  | 'groceries'
  | 'rent'
  | 'utilities'
  | 'transport'
  | 'dining'
  | 'entertainment'
  | 'shopping'
  | 'travel'
  | 'health'
  | 'subscriptions'
  | 'education'
  | 'transfer_internal'
  | 'savings'
  | 'cash'
  | 'other';

export interface AccountSpec {
  type: AccountType;
  productSlug: string;
  name: string;
  balance: number;
}

export interface GoalSpec {
  name: string;
  type: GoalType;
  targetAmount: number;
  /** Months after the anchor; null = no target date. */
  monthsFromAnchor: number | null;
}

/** A monthly booking on a fixed day (salary, rent, bills, subscriptions). */
export interface FixedFlow {
  kind: 'fixed';
  direction: 'in' | 'out';
  category: TxnCategory;
  counterparty: string;
  description: string;
  day: number;
  /** Exact amount or a [min, max] range drawn each month. */
  amount: number | [number, number];
  /** Only on even month offsets (0, 2, 4) of the window. */
  everyOtherMonth?: boolean;
}

/** N bookings on random days, merchant picked at random from the list. */
export interface RandomFlow {
  kind: 'random';
  category: TxnCategory;
  merchants: string[];
  count: [number, number];
  amount: [number, number];
  /** Probability that the flow happens at all in a given month (default 1). */
  probability?: number;
}

export type FlowSpec = FixedFlow | RandomFlow;

export interface PersonaSpec {
  key: PersonaKey;
  email: string;
  fullName: string;
  age: number;
  occupation: string;
  monthlyIncome: number;
  riskProfile: RiskProfile;
  accounts: AccountSpec[];
  goals: GoalSpec[];
  /** Current-account monthly flows. */
  flows: FlowSpec[];
}

export const DEMO_PASSWORD = 'Demo1234!';
export const ADMIN_EMAIL = 'admin@raiffeisen.demo';
export const ADMIN_NAME = 'Administrator Demo';

const sub = (counterparty: string, amount: number, day: number): FixedFlow => ({
  kind: 'fixed',
  direction: 'out',
  category: 'subscriptions',
  counterparty,
  description: `Abonament ${counterparty}`,
  day,
  amount,
});

const bill = (counterparty: string, amount: number | [number, number], day: number): FixedFlow => ({
  kind: 'fixed',
  direction: 'out',
  category: 'utilities',
  counterparty,
  description: `Factură ${counterparty}`,
  day,
  amount,
});

export const PERSONAS: PersonaSpec[] = [
  {
    key: 'andrei',
    email: 'andrei.popescu@demo.ro',
    fullName: 'Andrei Popescu',
    age: 28,
    occupation: 'Software developer',
    monthlyIncome: 11500,
    riskProfile: 'dynamic',
    accounts: [{ type: 'current', productSlug: 'pachet-cont-curent-gold', name: 'Cont curent', balance: 38000 }],
    goals: [
      { name: 'Vacanță în Japonia', type: 'vacation', targetAmount: 15000, monthsFromAnchor: 8 },
      { name: 'Fond de urgență', type: 'emergency_fund', targetAmount: 30000, monthsFromAnchor: null },
    ],
    flows: [
      { kind: 'fixed', direction: 'in', category: 'salary', counterparty: 'TechNova SRL', description: 'Salariu', day: 10, amount: 11500 },
      { kind: 'fixed', direction: 'out', category: 'rent', counterparty: 'Chirie apartament', description: 'Chirie apartament', day: 1, amount: 2800 },
      bill('Enel', [150, 250], 15),
      bill('Engie', [80, 200], 16),
      bill('Digi', 60, 18),
      sub('Netflix', 55, 12),
      sub('Spotify', 26, 14),
      sub('World Class', 350, 3),
      { kind: 'random', category: 'groceries', merchants: ['Kaufland', 'Lidl', 'Mega Image', 'Carrefour'], count: [6, 10], amount: [80, 350] },
      { kind: 'random', category: 'dining', merchants: ['Glovo', 'Tazz', "Caru' cu Bere", 'Trattoria Il Calcio', 'Shift Pub'], count: [8, 12], amount: [40, 250] },
      { kind: 'random', category: 'transport', merchants: ['Bolt', 'Uber'], count: [10, 15], amount: [15, 60] },
      { kind: 'random', category: 'shopping', merchants: ['eMAG', 'Altex', 'Zara', 'IKEA'], count: [2, 4], amount: [100, 900] },
      { kind: 'random', category: 'travel', merchants: ['Wizz Air', 'Booking.com'], count: [1, 1], amount: [400, 2500], probability: 0.5 },
    ],
  },
  {
    key: 'maria',
    email: 'maria.ionescu@demo.ro',
    fullName: 'Maria Ionescu',
    age: 35,
    occupation: 'Profesoară',
    monthlyIncome: 4800,
    riskProfile: 'conservative',
    accounts: [
      { type: 'current', productSlug: 'pachet-cont-curent-zero-simplu', name: 'Cont curent', balance: 3200 },
      { type: 'credit_card', productSlug: 'card-credit-visa-standard', name: 'Card de credit', balance: -3800 },
    ],
    goals: [{ name: 'Avans apartament', type: 'home', targetAmount: 60000, monthsFromAnchor: 36 }],
    flows: [
      { kind: 'fixed', direction: 'in', category: 'salary', counterparty: 'Școala Gimnazială nr. 5', description: 'Salariu', day: 1, amount: 4800 },
      { kind: 'fixed', direction: 'out', category: 'rent', counterparty: 'Chirie apartament', description: 'Chirie apartament', day: 5, amount: 1700 },
      {
        kind: 'fixed',
        direction: 'out',
        category: 'transfer_internal',
        counterparty: 'Card de credit Raiffeisen',
        description: 'Rambursare card de credit',
        day: 6,
        amount: 500,
      },
      // Enel + Engie + Digi: 250–360 in total.
      bill('Enel', [100, 150], 15),
      bill('Engie', [90, 150], 16),
      bill('Digi', 60, 18),
      { kind: 'fixed', direction: 'out', category: 'transport', counterparty: 'STB / Metrorex', description: 'Abonament transport STB/Metrorex', day: 2, amount: 80 },
      sub('Netflix', 55, 8),
      sub('HBO Max', 30, 9),
      sub('Disney+', 35, 11),
      sub('Spotify', 26, 13),
      sub('YouTube Premium', 30, 17),
      sub('Voyo', 25, 20),
      { kind: 'random', category: 'groceries', merchants: ['Lidl', 'Profi', 'Kaufland'], count: [9, 10], amount: [50, 200] },
      { kind: 'random', category: 'dining', merchants: ['Glovo', 'Tazz', 'Ted’s Coffee'], count: [4, 5], amount: [30, 90] },
      { kind: 'random', category: 'shopping', merchants: ['eMAG', 'Pepco', 'H&M'], count: [2, 3], amount: [50, 200] },
      { kind: 'random', category: 'health', merchants: ['Catena', 'Dr. Max'], count: [1, 1], amount: [50, 200] },
    ],
  },
  {
    key: 'ion',
    email: 'ion.georgescu@demo.ro',
    fullName: 'Ion Georgescu',
    age: 52,
    occupation: 'Inginer',
    monthlyIncome: 13000,
    riskProfile: 'balanced',
    accounts: [
      { type: 'current', productSlug: 'pachet-cont-curent-premium', name: 'Cont curent', balance: 62000 },
      { type: 'savings', productSlug: 'cont-economii-super-acces-plus', name: 'Cont de economii', balance: 85000 },
    ],
    goals: [{ name: 'Pensie liniștită', type: 'retirement', targetAmount: 300000, monthsFromAnchor: 13 * 12 }],
    flows: [
      { kind: 'fixed', direction: 'in', category: 'salary', counterparty: 'Electrica SA', description: 'Salariu', day: 25, amount: 13000 },
      // Utilities 450–700 in total.
      bill('Enel', [180, 280], 15),
      bill('Engie', [200, 330], 16),
      bill('Digi', [70, 90], 18),
      { kind: 'random', category: 'groceries', merchants: ['Kaufland', 'Carrefour', 'Mega Image', 'Auchan'], count: [10, 14], amount: [100, 300] },
      { kind: 'random', category: 'transport', merchants: ['OMV', 'Petrom'], count: [3, 4], amount: [200, 350] },
      { kind: 'random', category: 'health', merchants: ['Regina Maria', 'Catena'], count: [1, 2], amount: [100, 400] },
      { kind: 'random', category: 'dining', merchants: ["Caru' cu Bere", 'Hanu’ lui Manuc', 'Trattoria Il Calcio'], count: [3, 5], amount: [80, 250] },
      { kind: 'random', category: 'shopping', merchants: ['eMAG', 'Dedeman', 'Altex', 'Decathlon'], count: [2, 3], amount: [150, 600] },
    ],
  },
  {
    key: 'elena',
    email: 'elena.dumitru@demo.ro',
    fullName: 'Elena Dumitru',
    age: 22,
    occupation: 'Studentă',
    monthlyIncome: 2500,
    riskProfile: 'conservative',
    accounts: [{ type: 'current', productSlug: 'pachet-cont-curent-zero-simplu', name: 'Cont curent', balance: 2600 }],
    goals: [{ name: 'Laptop nou', type: 'education', targetAmount: 5000, monthsFromAnchor: 6 }],
    flows: [
      { kind: 'fixed', direction: 'in', category: 'salary', counterparty: 'Cafeneaua Ozone', description: 'Salariu', day: 5, amount: 1800 },
      { kind: 'fixed', direction: 'in', category: 'other', counterparty: 'Universitatea din București', description: 'Bursă', day: 20, amount: 700 },
      { kind: 'fixed', direction: 'out', category: 'rent', counterparty: 'Chirie cămin', description: 'Chirie', day: 6, amount: 900 },
      { kind: 'fixed', direction: 'out', category: 'transport', counterparty: 'STB', description: 'Abonament STB', day: 7, amount: 40 },
      sub('Spotify', 13, 14),
      { kind: 'fixed', direction: 'out', category: 'education', counterparty: 'Udemy', description: 'Curs online Udemy', day: 12, amount: 50, everyOtherMonth: true },
      // Counts/amounts held at the upper part of the brief's ranges so the opening balance stays positive.
      { kind: 'random', category: 'groceries', merchants: ['Lidl', 'Profi', 'Penny'], count: [7, 8], amount: [50, 120] },
      { kind: 'random', category: 'dining', merchants: ['Glovo', "McDonald's", 'Starbucks'], count: [5, 6], amount: [25, 60] },
      { kind: 'random', category: 'entertainment', merchants: ['Cinema City', 'Steam', 'Control Club'], count: [4, 5], amount: [40, 80] },
      { kind: 'random', category: 'shopping', merchants: ['Zara', 'H&M', 'eMAG'], count: [2, 2], amount: [60, 150] },
      // Expensive debt for the money map (step 3 red): a non-bank (IFN) loan and a buy-now-pay-later plan.
      // Fixed amounts draw nothing from the RNG, so the rest of her history is unchanged.
      { kind: 'fixed', direction: 'out', category: 'other', counterparty: 'Provident Financial', description: 'Rată împrumut Provident', day: 8, amount: 210 },
      { kind: 'fixed', direction: 'out', category: 'other', counterparty: 'Mokka', description: 'Rată Mokka (laptop în rate)', day: 15, amount: 140 },
    ],
  },
];
