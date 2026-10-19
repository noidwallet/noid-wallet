import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatNoid, parseNoid, shortAddress } from './amount';

test('parseNoid converts decimal NOID to integer μNOID without float error', () => {
  assert.equal(parseNoid('1'), 1_000_000);
  assert.equal(parseNoid('0.1'), 100_000);
  assert.equal(parseNoid('0.000001'), 1);
  assert.equal(parseNoid('1,5'), 1_500_000);
  assert.equal(parseNoid('1,500'), 1_500_000);
  assert.equal(parseNoid('12,345.67'), null);
  assert.equal(parseNoid('1,000,000'), null);
  assert.equal(parseNoid('.5'), 500_000);
  assert.equal(parseNoid('0.0000001'), null);
  assert.equal(parseNoid('abc'), null);
  assert.equal(parseNoid(''), null);
  assert.equal(parseNoid('1.2.3'), null);
});

test('formatNoid trims trailing zeros and groups thousands', () => {
  assert.equal(formatNoid(1_500_000), '1.5');
  assert.equal(formatNoid(9_000), '0.009');
  assert.equal(formatNoid(12_345_670_000), '12,345.67');
  assert.equal(formatNoid(0), '0');
  assert.equal(formatNoid(1_234_567, { maxDecimals: 2 }), '1.23');
});

test('shortAddress keeps both ends', () => {
  assert.equal(shortAddress('o1wrznmh6td3mgg9mu0a3kkxxn2lnfu827uykrnpaa90mex8su9zcs5sjxrk'), 'o1wrznmh…5sjxrk');
});
