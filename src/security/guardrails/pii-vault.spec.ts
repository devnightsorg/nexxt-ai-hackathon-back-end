import { PiiVault } from './pii-vault';

const IBAN = 'RO49AAAA1B31007593840000';

describe('PiiVault', () => {
  it('redacts IBAN/CNP/card/email/phone into numbered tokens and restores them', () => {
    const v = new PiiVault();
    const text = `IBAN ${IBAN}, CNP 1960523123456, card 4111 1111 1111 1111, email ion.pop@example.com, tel 0722 123 456.`;
    const red = v.redact(text);
    expect(red).toBe('IBAN [IBAN_1], CNP [CNP_1], card [CARD_1], email [EMAIL_1], tel [PHONE_1].');
    expect(v.redactionCount).toBe(5);
    expect(v.restore(red)).toBe(text);
  });

  it('same IBAN twice → same token; state round-trips through toJSON()', () => {
    const v = new PiiVault();
    expect(v.redact(`din ${IBAN}`)).toBe('din [IBAN_1]');
    expect(v.redact(`către RO49 AAAA 1B31 0075 9384 0000 RON`)).toBe('către [IBAN_1] RON');
    const v2 = new PiiVault(JSON.parse(JSON.stringify(v.toJSON())));
    expect(v2.redact(`iar ${IBAN} și +40733111222`)).toBe('iar [IBAN_1] și [PHONE_1]');
    expect(v2.restore('[IBAN_1]')).toBe(IBAN);
  });

  it('restore works inside nested tool-argument objects', () => {
    const v = new PiiVault();
    v.redact(`trimite la ${IBAN} pe ana@example.ro`);
    const args = { to: { iban: '[IBAN_1]' }, notes: ['email [EMAIL_1]', 5], amount: 100, flag: true };
    expect(v.restore(args)).toEqual({
      to: { iban: IBAN },
      notes: ['email ana@example.ro', 5],
      amount: 100,
      flag: true,
    });
  });

  it('does not redact amounts like 15000 or dates 2026-10-28', () => {
    const v = new PiiVault();
    const text = 'Am economisit 15000 RON până la 2026-10-28, adică 1.250,50 lei pe lună. Invalid: RO00AAAA1B31007593840000';
    expect(v.redact(text)).toBe(text);
    expect(v.redactionCount).toBe(0);
  });
});
