import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CURRENCIES, currencyInfo, fiatValue, moneyInputText, parseMoney, perNoid, priceIsFresh } from './currencies';

const price = { usd: 0.6, ngn: 800, rates: { EUR: 0.9, GBP: 0.8, NGN: 1333.33, JPY: 150, KES: 129 } };

test('currency list: unique codes and every style known', () => {
  const codes = CURRENCIES.map((c) => c.code);
  assert.equal(new Set(codes).size, codes.length);
  assert.ok(CURRENCIES.every((c) => /^[A-Z]{3}$/.test(c.code) && ['cents', 'big', 'whole'].includes(c.style)));
  assert.equal(currencyInfo('ngn')?.symbol, '₦');
  assert.equal(currencyInfo('none'), null);
  assert.equal(currencyInfo('xyz'), null);
});

test('value of 1 NOID per currency, with the old naira-only fallback', () => {
  assert.equal(perNoid(price, 'usd'), 0.6);
  assert.ok(Math.abs(perNoid(price, 'eur')! - 0.54) < 1e-9);
  assert.equal(perNoid(price, 'cad'), null, 'no rate, no value');
  assert.equal(perNoid({ usd: 0.6, ngn: 800 }, 'ngn'), 800);
  assert.equal(perNoid(null, 'usd'), null);
  assert.equal(perNoid({ usd: 0, ngn: null }, 'usd'), null);
});

test('formatting follows each currency', () => {
  assert.equal(fiatValue(10_000_000, price, 'usd'), '≈ $6.00');
  assert.equal(fiatValue(10_000_000, price, 'eur'), '≈ €5.40');
  assert.equal(fiatValue(10_000_000, price, 'jpy'), '≈ ¥900');
  assert.equal(fiatValue(10_000_000, price, 'ngn'), '≈ ₦8,000');
  assert.equal(fiatValue(100_000, price, 'ngn'), '≈ ₦80.00');
  assert.equal(fiatValue(1_000_000, price, 'kes'), '≈ KSh 77.40');
  assert.equal(fiatValue(1, price, 'jpy'), '< ¥1');
  assert.equal(fiatValue(1, price, 'gbp'), '< £0.01');
  assert.equal(fiatValue(10_000_000, price, 'none'), null);
});

test('typing amounts in a currency', () => {
  assert.equal(parseMoney('5000'), 5000);
  assert.equal(parseMoney('12.5'), 12.5);
  assert.equal(parseMoney('12,5'), 12.5);
  assert.equal(parseMoney('12,50'), 12.5);
  assert.equal(parseMoney('0.1234'), 0.1234);
  // Grouping that can only mean thousands, in either style.
  assert.equal(parseMoney('1,250,000'), 1250000);
  assert.equal(parseMoney('1.250.000'), 1250000);
  assert.equal(parseMoney('1,250,000.50'), 1250000.5);
  assert.equal(parseMoney('1.250.000,50'), 1250000.5);
  assert.equal(parseMoney('12,500.00'), 12500);
  // One separator + exactly three digits could mean either: refused, never guessed.
  assert.equal(parseMoney('5,000'), null);
  assert.equal(parseMoney('1.500'), null);
  assert.equal(parseMoney('50.000'), null);
  // Mid-typing.
  assert.equal(parseMoney('12.'), 12);
  assert.equal(parseMoney('.5'), 0.5);
  // Nonsense.
  assert.equal(parseMoney('1,5,0'), null);
  assert.equal(parseMoney('1,50.5'), null);
  assert.equal(parseMoney('1.2.3,4'), null);
  assert.equal(parseMoney('abc'), null);
  assert.equal(parseMoney('-5'), null);
  assert.equal(parseMoney('.'), null);
  assert.equal(parseMoney(''), null);
  assert.equal(moneyInputText(12.5, currencyInfo('usd')!), '12.5');
  assert.equal(moneyInputText(2607.4, currencyInfo('ngn')!), '2607');
  assert.equal(moneyInputText(12, currencyInfo('usd')!), '12');
});

test('typing in a currency needs a recent price (server age + time since it arrived)', () => {
  const now = 1_000_000_000;
  assert.equal(priceIsFresh(null, now), false);
  assert.equal(priceIsFresh({ usd: 1, ngn: null }, now), true, 'no timing info: treated as fresh');
  assert.equal(priceIsFresh({ usd: 1, ngn: null, ageMs: 60_000, receivedAt: now - 60_000 }, now), true);
  assert.equal(priceIsFresh({ usd: 1, ngn: null, ageMs: 14 * 60_000, receivedAt: now - 2 * 60_000 }, now), false);
  assert.equal(priceIsFresh({ usd: 1, ngn: null, ageMs: 0, receivedAt: now - 20 * 60_000 }, now), false);
});

test('"≈" values disappear when the price is old or distrusted', () => {
  const now = 10_000_000_000;
  const base = { usd: 0.6, ngn: null, rates: {}, source: 't', updatedAt: 0 };
  assert.equal(fiatValue(10_000_000, { ...base, receivedAt: now - 30 * 60_000, ageMs: 0 }, 'usd', now), '≈ $6.00');
  assert.equal(fiatValue(10_000_000, { ...base, receivedAt: now - 61 * 60_000, ageMs: 0 }, 'usd', now), null);
  assert.equal(fiatValue(10_000_000, { ...base, receivedAt: now, ageMs: 2 * 3600_000 }, 'usd', now), null);
  assert.equal(fiatValue(10_000_000, { ...base, receivedAt: now, typingOk: false }, 'usd', now), null);
});
