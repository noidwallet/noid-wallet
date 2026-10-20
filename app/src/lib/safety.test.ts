import { test } from 'node:test';
import assert from 'node:assert/strict';

import { checkAddress, fiat, groupAddress } from './safety';

const REAL = 'o1tseu9yag3yuz0tlfcuvleqppl9q4adr0pql3tqdyugsztj9e46dqqyfj6z';
const FAKE = 'o1tseuxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxqyfj6z';
const OTHER = 'o1s32s5m9ughjv2ktvxm8m7y0gmu0swys5t0ufkdnyhv02nudc23cqg7y34s';

test('contacts, known, new and look-alike addresses', () => {
  const contacts = [{ name: 'Tolu', address: REAL }];
  assert.deepEqual(checkAddress(REAL, contacts, []), { kind: 'contact', name: 'Tolu' });
  assert.deepEqual(checkAddress(FAKE, contacts, []), { kind: 'lookalike', similarTo: REAL, name: 'Tolu' });
  assert.deepEqual(checkAddress(FAKE, [], [REAL]), { kind: 'lookalike', similarTo: REAL, name: null });
  assert.deepEqual(checkAddress(OTHER, contacts, [OTHER]), { kind: 'known' });
  assert.deepEqual(checkAddress(OTHER, contacts, []), { kind: 'new' });
});

test('look-alikes beyond exact 4+4: partial ends, long prefix, poisoned contacts', () => {
  // 3 of the first 6 and 3 of the last 6 match by position.
  // 'tseu9y' -> 'tsxuxy' (4 of 6 kept) and 'qyfj6z' -> 'qxfxxz' (3 of 6 kept), middle all different.
  const partial = 'o1tsxuxy' + 'x'.repeat(REAL.length - 14) + 'qxfxxz';
  assert.equal(checkAddress(partial, [], [REAL]).kind, 'lookalike');
  // Only the start matches, but for 4+ characters.
  assert.equal(checkAddress('o1tseu' + 'z'.repeat(REAL.length - 6), [], [REAL]).kind, 'lookalike');
  const prefix = 'o1tseu9zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz';
  assert.equal(checkAddress(prefix, [], [REAL]).kind, 'lookalike');
  // A saved contact that imitates another contact is still flagged.
  const contacts = [{ name: 'Tolu', address: REAL }, { name: 'Tolu 2', address: FAKE }];
  assert.equal(checkAddress(FAKE, contacts, []).kind, 'lookalike');
  // Unrelated random addresses are not flagged.
  assert.equal(checkAddress(OTHER, [{ name: 'Tolu', address: REAL }], [REAL]).kind, 'new');
});

test('address grouping', () => {
  assert.equal(groupAddress('o1abcdefgh'), 'o1ab cdef gh');
});

test('fiat display', () => {
  const price = { usd: 0.02, ngn: 30 };
  assert.equal(fiat(4_900_000, price, 'usd'), '≈ $0.10');
  assert.equal(fiat(4_900_000, price, 'ngn'), '≈ ₦147');
  assert.equal(fiat(1_000_000_000, price, 'ngn'), '≈ ₦30,000');
  assert.equal(fiat(1_000, price, 'usd'), '< $0.01');
  assert.equal(fiat(4_900_000, price, 'none'), null);
  assert.equal(fiat(4_900_000, null, 'usd'), null);
  assert.equal(fiat(4_900_000, { usd: 0.02, ngn: null }, 'ngn'), null);
});
