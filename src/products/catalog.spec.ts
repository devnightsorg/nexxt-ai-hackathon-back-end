import { resolve } from 'node:path';
import { PRODUCT_CATEGORIES, termMonthsOf } from './catalog.types';
import { loadCatalogFrom } from './products.service';

const catalog = loadCatalogFrom(resolve(__dirname, '../../seed/knowledge'));

describe('product catalog (seed/knowledge/products.json)', () => {
  it('has ≥ 12 products with unique slugs', () => {
    expect(catalog.length).toBeGreaterThanOrEqual(12);
    expect(new Set(catalog.map((p) => p.slug)).size).toBe(catalog.length);
  });

  it('every item has a valid category, ≥1 source_url, arrays present', () => {
    for (const p of catalog) {
      expect(PRODUCT_CATEGORIES).toContain(p.category);
      expect(p.source_urls.length).toBeGreaterThanOrEqual(1);
      for (const k of ['key_features', 'fees', 'eligibility', 'currencies', 'terms', 'good_for'] as const) {
        expect(Array.isArray(p[k])).toBe(true);
      }
    }
  });

  // housing_savings dropped: the product is discontinued (no catalog item exists).
  it('covers savings_account, term_deposit, investment_fund, private_pension, current_account', () => {
    const cats = new Set(catalog.map((p) => p.category));
    for (const c of ['savings_account', 'term_deposit', 'investment_fund', 'private_pension', 'current_account']) {
      expect(cats).toContain(c);
    }
  });

  it('carries enrichment fields on every item', () => {
    for (const p of catalog) {
      expect(typeof p.openable_via_transfer).toBe('boolean');
      expect(typeof p.rule_eligible).toBe('boolean');
      expect(Array.isArray(p.rates_by_term)).toBe(true);
    }
    const lei = catalog.find((p) => p.slug === 'depozit-termen-lei')!;
    expect(lei.rates_by_term).toEqual([
      { months: 3, ratePct: 4.7 },
      { months: 12, ratePct: 5.2 },
      { months: 24, ratePct: 6.4 },
    ]);
    expect(catalog.find((p) => p.slug === 'plateste-si-economisesti')!.openable_via_transfer).toBe(false);
    expect(catalog.find((p) => p.slug === 'depozit-fresh-money')!.rule_eligible).toBe(false);
  });

  it('termMonthsOf parses ["1 lună","3 luni","12 luni","1 an"] → [1,3,12]', () => {
    expect(termMonthsOf({ terms: ['1 lună', '3 luni', '12 luni', '1 an'] })).toEqual([1, 3, 12]);
    expect(termMonthsOf({ terms: ['3 months', '12 months', '24 months'] })).toEqual([3, 12, 24]);
    expect(termMonthsOf({ terms: ['2 years'] })).toEqual([24]);
  });
});
