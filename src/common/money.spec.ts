import { BadRequestException } from '@nestjs/common';
import { formatRon, parseAmount, toMoney } from './money';

describe('money', () => {
  it('rounds to 2 decimals', () => expect(toMoney('10.005')).toBe(10.01));

  it('rounds half-up from numbers and Decimals too', () => {
    expect(toMoney(2.675)).toBe(2.68);
    expect(toMoney(parseAmount(99.99))).toBe(99.99);
  });

  it.each([-5, 0, 10.555, '100', 1e12, NaN, null])('parseAmount rejects %p', (v) =>
    expect(() => parseAmount(v)).toThrow(BadRequestException),
  );

  it('parseAmount rejects with the Romanian message', () =>
    expect(() => parseAmount(-1)).toThrow('Suma trebuie să fie un număr pozitiv cu maximum 2 zecimale'));

  it.each([Infinity, undefined, { amount: 5 }])('parseAmount rejects %p', (v) =>
    expect(() => parseAmount(v)).toThrow(BadRequestException),
  );

  it('parseAmount accepts 2000.5', () => expect(parseAmount(2000.5).toString()).toBe('2000.5'));

  it('parseAmount accepts the 1,000,000,000 ceiling and rejects just above it', () => {
    expect(parseAmount(1_000_000_000).toString()).toBe('1000000000');
    expect(() => parseAmount(1_000_000_000.01)).toThrow(BadRequestException);
  });

  it('formats RON', () => expect(formatRon(2000)).toBe('2.000,00'));

  it('formats RON with grouping and 2 decimals', () => {
    expect(formatRon(1234567.891)).toBe('1.234.567,89');
    expect(formatRon(0.5)).toBe('0,50');
  });
});
