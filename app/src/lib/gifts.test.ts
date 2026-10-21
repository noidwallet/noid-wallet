import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { Api } from './api';
import { findLostGifts, giftDay, pickGiftIndex, sweepFeeTooHigh } from './gifts';
import { ApiError } from './api';
import type { GiftRecord } from './storage';

const DAY = 86_400_000;
const T = Date.UTC(2026, 9, 20, 12);

function rec(index: number): GiftRecord {
  return { index, address: `o1${index}`, amount: 1, message: '', theme: 'vault', from: '', createdAt: 0, fundTxid: null, status: 'funded' };
}

test('gift numbers are date based and never reused', () => {
  const day = giftDay(T);
  assert.equal(pickGiftIndex([], -1, T, () => 0), day * 100 + 50, 'a fresh or restored wallet starts halfway through today, not at 0');
  assert.equal(pickGiftIndex([], -1, T, () => 0.999), day * 100 + 89, 'plus a random spread of up to 39');
  for (let i = 0; i < 50; i++) {
    const n = pickGiftIndex([], -1, T) - day * 100;
    assert.ok(n >= 50 && n <= 89, `fresh start ${n} stays inside today's numbers`);
  }
  assert.equal(pickGiftIndex([rec(day * 100)], day * 100, T), day * 100 + 1);
  // Next day starts a new block of numbers.
  assert.equal(pickGiftIndex([rec(day * 100)], day * 100, T + DAY), (day + 1) * 100);
  // A clock set backwards never goes below the high-water mark.
  assert.equal(pickGiftIndex([], day * 100 + 5, T - 30 * DAY), day * 100 + 6);
  // Hidden or removed gifts still block their numbers (kept in the list as hidden).
  assert.equal(pickGiftIndex([rec(day * 100), rec(day * 100 + 1)], -1, T), day * 100 + 2, 'a phone with gifts continues its own numbers');
});

test('sweep fees far above the network minimum are refused', () => {
  assert.equal(sweepFeeTooHigh(5_800, 1), false);
  assert.equal(sweepFeeTooHigh(20_000, 1), false);
  assert.equal(sweepFeeTooHigh(500_000, 1), true);
  assert.equal(sweepFeeTooHigh(56_100, 504), false, 'many coins legitimately cost more');
});

test('find gifts: one request per day finds every funded gift, even after burned numbers', async () => {
  const now = Date.UTC(2026, 0, 11); // day 10
  const used = new Map<string, number>([
    ['a1000', 0], // claimed
    ['a1001', 0],
    ['a1003', 4_000], // after a burned number (1002)
    ['a1005', 7_000],
    ['a1057', 2_000], // made on a restored phone (starts at +50)
    ['a1100', 1_000], // tomorrow's range: today's 101st gift
    ['a0', 3_000], // day 0, long ago
  ]);
  let calls = 0;
  let busy = 1;
  const api = {
    addressesUsed: async (list: string[]) => {
      calls++;
      if (busy-- > 0) throw new ApiError('rate_limited', 'Too many requests', 429);
      return { used: list.filter((a) => used.has(a)) };
    },
    utxos: async (a: string) => ({ balance: used.get(a) ?? 0, utxos: [] }),
  } as unknown as Api;
  const found = await findLostGifts(
    api,
    async (start, count) => Array.from({ length: count }, (_, i) => ({ index: start + i, address: `a${start + i}` })),
    [],
    { nowMs: now, sleep: async () => {} },
  );
  assert.deepEqual(
    found.map((f) => [f.index, f.balance]).sort((a, b) => a[0]! - b[0]!),
    [
      [0, 3_000],
      [1003, 4_000],
      [1005, 7_000],
      [1057, 2_000],
      [1100, 1_000],
    ],
  );
  assert.equal(calls, 13, '12 days (incl. tomorrow) + one retry after a 429');
});

test('find gifts: older servers are asked address by address, past short gaps', async () => {
  const now = Date.UTC(2026, 0, 2); // day 1
  const used = new Map<string, number>([
    ['a100', 0],
    ['a103', 5_000],
    ['a0', 3_000],
    ['a85', 2_000], // made on a freshly restored phone (starts at 50 plus up to 39)
  ]);
  const api = {
    addressesUsed: async () => {
      throw new ApiError('not_found', 'Not found', 404);
    },
    history: async (a: string) => ({ items: used.has(a) ? [{}] : [], nextBefore: null, indexedFrom: 0 }),
    utxos: async (a: string) => ({ balance: used.get(a) ?? 0, utxos: [] }),
  } as unknown as Api;
  const found = await findLostGifts(
    api,
    async (start, count) => Array.from({ length: count }, (_, i) => ({ index: start + i, address: `a${start + i}` })),
    [],
    { nowMs: now, sleep: async () => {} },
  );
  assert.deepEqual(
    found.map((f) => [f.index, f.balance]),
    [
      [103, 5_000],
      [0, 3_000],
      [85, 2_000],
    ],
  );
});
