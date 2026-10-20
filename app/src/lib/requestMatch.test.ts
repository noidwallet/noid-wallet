import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { HistoryItem } from './api';
import { matchRequestPayment } from './requestMatch';

const h = (txid: string, amount: number, direction: HistoryItem['direction'] = 'received', height = 10, counterparty = 'o1payer'): HistoryItem => ({
  txid,
  height,
  time: height * 25,
  direction,
  amount,
  fee: 0,
  counterparty,
});

test('request: waiting until a new incoming payment arrives', () => {
  const known = new Set(['old']);
  const at = { afterHeight: 5 };
  assert.equal(matchRequestPayment([h('old', 100_000)], { amount: 100_000, knownTxids: known, ...at }).status, 'waiting');
  assert.equal(matchRequestPayment([h('s', 100_000, 'sent')], { amount: 100_000, knownTxids: known, ...at }).status, 'waiting');
  assert.equal(matchRequestPayment([h('m', 100_000, 'mined')], { amount: 100_000, knownTxids: known, ...at }).status, 'waiting');
  // The history was empty/stale when the request was made: a payment from an
  // earlier block still never counts.
  assert.equal(matchRequestPayment([h('earlier', 100_000, 'received', 5)], { amount: 100_000, knownTxids: new Set(), ...at }).status, 'waiting');
  assert.equal(matchRequestPayment([h('later', 100_000, 'received', 6)], { amount: 100_000, knownTxids: new Set(), ...at }).status, 'paid');
});

test('request: exact amount is paid; another amount is flagged', () => {
  const known = new Set<string>();
  const at = { afterHeight: 0 };
  const paid = matchRequestPayment([h('a', 100_000)], { amount: 100_000, knownTxids: known, ...at });
  assert.equal(paid.status, 'paid');
  const less = matchRequestPayment([h('b', 50_000)], { amount: 100_000, knownTxids: known, ...at });
  assert.equal(less.status, 'different');
  assert.equal(less.status === 'different' && less.item.amount, 50_000);
  // Exact match wins even if a different payment also arrived.
  assert.equal(
    matchRequestPayment([h('b', 50_000, 'received', 11), h('a', 100_000, 'received', 12)], { amount: 100_000, knownTxids: known, ...at }).status,
    'paid',
  );
});

test('request: any-amount request is paid by the first new payment; own gift claims are ignored', () => {
  const r = matchRequestPayment([h('x', 7, 'received', 12), h('y', 9, 'received', 11)], { amount: null, knownTxids: new Set(), afterHeight: 0 });
  assert.equal(r.status === 'paid' && r.item.txid, 'y');
  const gifts = new Set(['o1mygift']);
  assert.equal(
    matchRequestPayment([h('g', 100_000, 'received', 12, 'o1mygift')], { amount: 100_000, knownTxids: new Set(), ignoreFrom: gifts, afterHeight: 0 })
      .status,
    'waiting',
  );
});
