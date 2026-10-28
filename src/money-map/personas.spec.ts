import { buildMoneyMap } from './money-map';
import { personaInput } from './persona-fixtures';
import { CREDIT_CATEGORIES } from './ranker';
import type { MoneyMap, StepStatus } from './types';

const ladder = (m: MoneyMap): StepStatus[] => m.ladder.map((s) => s.status);

function creditProductsIn(m: MoneyMap, key: Parameters<typeof personaInput>[0]): string[] {
  const bySlug = new Map(personaInput(key).products.map((p) => [p.slug, p.category]));
  return m.actions.filter((a) => a.product && CREDIT_CATEGORIES.includes(bySlug.get(a.product.slug)!)).map((a) => a.id);
}

/** The response contract the front-end depends on. */
function expectContract(m: MoneyMap): void {
  expect(Object.keys(m).sort()).toEqual(['actions', 'conflicts', 'currentStep', 'headline', 'ladder', 'pillars', 'situationComplete']);
  expect(m.headline.text).toMatch(/\d/);
  expect(m.pillars.map((p) => p.key)).toEqual(['spend', 'save', 'borrow', 'plan_protect']);
  expect(m.ladder.map((s) => s.key)).toEqual([
    'cash_flow',
    'starter_buffer',
    'expensive_debt',
    'protection',
    'emergency_fund',
    'goals',
    'long_term',
  ]);
  expect(m.actions.length).toBeLessThanOrEqual(3);
  for (const a of m.actions) {
    expect(Object.keys(a).sort()).toEqual(
      ['id', 'impactRonPerMonth', 'kind', 'product', 'reasoning', 'ruleId', 'step', 'stepLabel', 'title'].sort(),
    );
    if (a.kind !== 'product') expect(a.product).toBeNull();
  }
}

describe('money map for the seed personas', () => {
  it('andrei: foundations green, goals and long-term amber', () => {
    const m = buildMoneyMap(personaInput('andrei'));
    expectContract(m);
    expect(ladder(m)).toEqual(['green', 'green', 'green', 'grey', 'green', 'amber', 'amber']);
    expect(m.currentStep).toBe(6);
    expect(m.actions[0].step).toBe(6);
  });

  it('maria: thin buffer and credit card debt', () => {
    const m = buildMoneyMap(personaInput('maria'));
    expectContract(m);
    expect(ladder(m)).toEqual(['green', 'red', 'red', 'grey', 'red', 'amber', 'grey']);
    expect(m.currentStep).toBe(2);
    expect(m.actions.map((a) => a.step)).toEqual([2, 3, 6]);
    expect(m.headline.facts).toContain('buffer_months=0.7');
  });

  it('maria: conflicting answers are reported and transactions win', () => {
    const m = buildMoneyMap(personaInput('maria', { card_revolving: false, buffer_band: '3_6', dependents: true, ins_life: false }));
    expect(m.situationComplete).toBe(true);
    expect(m.conflicts.map((c) => c.field).sort()).toEqual(['buffer_band', 'card_revolving']);
    expect(m.ladder[2].status).toBe('red');
    expect(m.ladder[3].status).toBe('red');
  });

  it('ion: everything green up to long-term, pension suggested', () => {
    const m = buildMoneyMap(personaInput('ion'));
    expectContract(m);
    expect(ladder(m)).toEqual(['green', 'green', 'green', 'grey', 'green', 'green', 'amber']);
    expect(m.currentStep).toBe(7);
    expect(m.actions[0]).toMatchObject({ step: 7, ruleId: 'retirement', kind: 'product' });
  });

  it('elena: deficit plus IFN/BNPL debt; cash flow comes first and no credit is offered', () => {
    const m = buildMoneyMap(personaInput('elena'));
    expectContract(m);
    expect(ladder(m)).toEqual(['red', 'red', 'red', 'grey', 'red', 'amber', 'grey']);
    expect(m.currentStep).toBe(1);
    expect(m.ladder[2].reason).toContain('Provident');
    expect(m.ladder[2].reason).toContain('Mokka');
    expect(m.actions[0].step).toBe(1);
    expect(creditProductsIn(m, 'elena')).toEqual([]);
  });

  it('elena: denying the IFN/BNPL debt is a conflict, not a green step', () => {
    const m = buildMoneyMap(personaInput('elena', { debt_ifn_bnpl: false, money_stress: true }));
    expect(m.ladder[2].status).toBe('red');
    expect(m.conflicts).toEqual([expect.objectContaining({ field: 'debt_ifn_bnpl', answer: false })]);
    expect(m.actions[0].step).toBe(1);
  });

  it('no persona is offered a credit product while step 1 is red', () => {
    for (const key of ['andrei', 'maria', 'ion', 'elena'] as const) {
      for (const answers of [{}, { relies_on_credit: true }]) {
        const m = buildMoneyMap(personaInput(key, answers));
        if (m.ladder[0].status === 'red') expect(creditProductsIn(m, key)).toEqual([]);
      }
    }
  });
});
