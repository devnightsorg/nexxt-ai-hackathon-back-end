import type { CatalogProduct } from '../products/catalog.types';
import { offerProposalInput } from './offers.service';

const product = (slug: string, category: CatalogProduct['category']) => ({ slug, category }) as CatalogProduct;
const terms = { suggestedAmount: null, monthlyContribution: 500, termMonths: null, projection: null, goalId: 'g-home' };
const current = { id: 'acc-cur', type: 'current', status: 'active', productSlug: 'pachet-zero' };
const savings = { id: 'acc-sav', type: 'savings', status: 'active', productSlug: 'super-acces' };

describe('offerProposalInput', () => {
  it('tops up the savings account the customer already holds (keeps the goal link) instead of opening a duplicate', () => {
    const input = offerProposalInput(product('super-acces', 'savings_account'), terms, [current, savings], current, 500, 'Avans');
    expect(input).toEqual({ type: 'transfer', fromAccountId: 'acc-cur', toAccountId: 'acc-sav', amount: 500, reason: 'Avans', goalId: 'g-home' });
  });

  it('opens the product when the customer does not hold it (or it is a deposit)', () => {
    const open = offerProposalInput(product('super-acces', 'savings_account'), terms, [current], current, 500, 'Avans');
    expect(open).toMatchObject({ type: 'open_product', productSlug: 'super-acces', goalId: 'g-home' });
    const closed = { ...savings, status: 'closed' };
    expect(offerProposalInput(product('super-acces', 'savings_account'), terms, [current, closed], current, 500, 'x').type).toBe('open_product');
    const deposit = offerProposalInput(
      product('depozit', 'term_deposit'),
      { ...terms, termMonths: 12 },
      [current, { ...savings, productSlug: 'depozit' }],
      current,
      500,
      'x',
    );
    expect(deposit).toMatchObject({ type: 'open_product', productSlug: 'depozit', termMonths: 12 });
  });
});
