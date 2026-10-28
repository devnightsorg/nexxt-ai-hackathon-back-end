import { extractRates, guardOutput, INVESTMENT_DISCLAIMER } from './output-guard';

const ctx = { allowedRates: [4.5], catalogNames: ['Depozit la termen', 'Cont Super Acces'], recommendationCategories: [] as string[] };

describe('output guard', () => {
  it('extractRates("dobândă 4,50% pe an și 6 %") → [4.5, 6]', () => {
    expect(extractRates('dobândă 4,50% pe an și 6 %')).toEqual([4.5, 6]);
    expect(extractRates('randament 4.50 % p.a.')).toEqual([4.5]);
  });

  it('strips the sentence quoting 7% when allowed is [4.5]; keeps "economisește 30% din venit"', () => {
    const reply =
      'Depozitul are o dobândă de 4,5% pe an. Alt depozit oferă o dobândă de 7% pe an! Recomand: economisește 30% din venit.';
    const r = guardOutput(reply, ctx);
    expect(r.strippedSentences).toEqual(['Alt depozit oferă o dobândă de 7% pe an!']);
    expect(r.text).toBe('Depozitul are o dobândă de 4,5% pe an. Recomand: economisește 30% din venit.');
    expect(r.disclaimerAdded).toBe(false);
  });

  it('adds disclaimer for investment_fund recommendations only', () => {
    const fund = guardOutput('Îți recomand un fond.', { ...ctx, recommendationCategories: ['investment_fund'] });
    expect(fund.disclaimerAdded).toBe(true);
    expect(fund.text).toBe(`Îți recomand un fond.\n\n${INVESTMENT_DISCLAIMER}`);
    const dep = guardOutput('Îți recomand un depozit.', { ...ctx, recommendationCategories: ['deposit'] });
    expect(dep.disclaimerAdded).toBe(false);
    expect(dep.text).toBe('Îți recomand un depozit.');
  });

  it('warns on **Cont Super Economii X** when not in catalog', () => {
    const r = guardOutput('Deschide **Cont Super Economii X** sau **Depozit la termen**.', ctx);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toContain('Cont Super Economii X');
    expect(r.text).toContain('**Cont Super Economii X**');
  });
});
