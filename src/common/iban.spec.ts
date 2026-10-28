import { generateIban, isValidIban } from './iban';

describe('iban', () => {
  it('generateIban(1..500) all valid, unique, start with RO and contain RZBR', () => {
    const ibans = Array.from({ length: 500 }, (_, i) => generateIban(i + 1));
    expect(new Set(ibans).size).toBe(500);
    for (const iban of ibans) {
      expect(iban).toMatch(/^RO\d{2}RZBR\d{16}$/);
      expect(isValidIban(iban)).toBe(true);
    }
  });

  it('isValidIban rejects a 1-digit change and accepts "RO49 AAAA 1B31 0075 9384 0000"', () => {
    expect(isValidIban('RO49 AAAA 1B31 0075 9384 0000')).toBe(true);
    const iban = generateIban(12345);
    const last = iban[iban.length - 1];
    const changed = iban.slice(0, -1) + String((Number(last) + 1) % 10);
    expect(isValidIban(changed)).toBe(false);
  });
});
