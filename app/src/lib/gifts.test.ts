import { test } from 'node:test';
import assert from 'node:assert/strict';

import { giftDay, pickGiftIndex, sweepFeeTooHigh } from './gifts';
import type { GiftRecord } from './storage';

const DAY = 86_400_000;
const T = Date.UTC(2026, 9, 20, 12);

function rec(index: number): GiftRecord {
  return { index, address: `o1${index}`, amount: 1, message: '', theme: 'vault', from: '', createdAt: 0, fundTxid: null, status: 'funded' };
}

test('gift numbers are date based and never reused', () => {
  const day = giftDay(T);
  assert.equal(pickGiftIndex([], -1, T), day * 100, 'a fresh or restored wallet starts at today, not at 0');
  assert.equal(pickGiftIndex([rec(day * 100)], day * 100, T), day * 100 + 1);
  // Next day starts a new block of numbers.
  assert.equal(pickGiftIndex([rec(day * 100)], day * 100, T + DAY), (day + 1) * 100);
  // A clock set backwards never goes below the high-water mark.
  assert.equal(pickGiftIndex([], day * 100 + 5, T - 30 * DAY), day * 100 + 6);
  // Hidden or removed gifts still block their numbers (kept in the list as hidden).
  assert.equal(pickGiftIndex([rec(day * 100), rec(day * 100 + 1)], -1, T), day * 100 + 2);
});

test('sweep fees far above the network minimum are refused', () => {
  assert.equal(sweepFeeTooHigh(5_800, 1), false);
  assert.equal(sweepFeeTooHigh(20_000, 1), false);
  assert.equal(sweepFeeTooHigh(500_000, 1), true);
  assert.equal(sweepFeeTooHigh(56_100, 504), false, 'many coins legitimately cost more');
});
