import { test } from 'node:test';
import assert from 'node:assert/strict';

import { formatUnits, looksLikeNoid, noidValue, nftKey, shortId, toBig, unitPrice } from './tokenMath';

test('token amounts format exactly, beyond JavaScript number range', () => {
  assert.equal(formatUnits('1500000'), '1.5');
  assert.equal(formatUnits('0'), '0');
  assert.equal(formatUnits('1'), '0.000001');
  assert.equal(formatUnits('1234000000'), '1,234');
  // 18,446,744,073,709.551615 tokens: u64::MAX base units.
  assert.equal(formatUnits('18446744073709551615'), '18,446,744,073,709.551615');
  assert.equal(formatUnits('1234567', { maxDecimals: 2 }), '1.23');
  assert.equal(formatUnits('-5'), '?');
  assert.equal(formatUnits('01'), '?');
  assert.equal(toBig('12a'), null);
});

test('token value in NOID uses the market price, rounded down', () => {
  // Launch start: 1/300 NOID per token. 300 tokens = 1 NOID.
  assert.equal(noidValue('300000000', '1', '300'), 1_000_000);
  assert.equal(noidValue('1', '1', '300'), 0);
  assert.equal(noidValue('5', '1', '0'), null);
  assert.equal(noidValue('18446744073709551615', '18446744073709551615', '1'), null, 'too large to show');
  // DEX: 400 NOID against 40,000 tokens = 0.01 NOID per token.
  assert.equal(unitPrice('400000000', '40000000000'), '0.01');
  assert.equal(unitPrice('1', '300'), '0.003333');
  assert.equal(unitPrice('1', '0'), null);
});

test('ids', () => {
  assert.equal(shortId('a'.repeat(64)), 'aaaaaaaa…aaaaaaaa');
  assert.equal(nftKey('ab', '3'), 'ab-3');
});

test('tokens that could pass for NOID are flagged', () => {
  for (const [name, symbol] of [
    ['NOID', 'NOIDX'],
    ['No1d Cash', 'NC'],
    ['N01D', 'N'],
    ['NOlD', 'X'],
    ['Parano1d Token', 'PT'],
    ['N\u043eID', 'X'], // Cyrillic o
    ['Wrapped N O I D', 'W'],
  ] as const) {
    assert.equal(looksLikeNoid(name, symbol), true, name);
  }
  assert.equal(looksLikeNoid('Moon Dog', 'MOON'), false);
  assert.equal(looksLikeNoid(null, null), false);
});
