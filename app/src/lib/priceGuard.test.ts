import { test } from 'node:test';
import assert from 'node:assert/strict';

import { judgePrice, type GuardState } from './priceGuard';

const H = 3600_000;

test('price guard: first price trusted, normal moves fine, a sudden 1000x drop refused', () => {
  let s: GuardState = {};
  let r = judgePrice(s, 'ngn', 750, 0);
  assert.equal(r.ok, true);
  s = r.next;
  r = judgePrice(s, 'ngn', 900, H);
  assert.equal(r.ok, true, '+20% is a normal move');
  s = r.next;
  r = judgePrice(s, 'ngn', 0.9, 2 * H);
  assert.equal(r.ok, false, 'a poisoned price is refused');
  assert.equal(r.next.ngn!.per, 750, 'the anchor stays');
});

test('price guard: stepping the price down each refresh does not move the anchor', () => {
  let s: GuardState = { usd: { per: 1, at: 0 } };
  let p = 1;
  let accepted = 1;
  for (let i = 1; i <= 20; i++) {
    p *= 0.6;
    const r = judgePrice(s, 'usd', p, i * 15_000);
    s = r.next;
    if (r.ok) accepted = p;
  }
  assert.ok(accepted >= 0.5, `never accepted below half the anchor (got ${accepted})`);
  assert.equal(s.usd!.per, 1);
});

test('price guard: the anchor follows normal moves once a day', () => {
  let s: GuardState = { usd: { per: 1, at: 0 } };
  let r = judgePrice(s, 'usd', 0.7, 25 * H);
  assert.equal(r.ok, true);
  assert.equal(r.next.usd!.per, 0.7, 're-anchored after a day');
  s = r.next;
  r = judgePrice(s, 'usd', 0.4, 26 * H);
  assert.equal(r.ok, true, 'within half of the new anchor');
  assert.equal(r.next.usd!.per, 0.7, 'but the anchor waits another day');
});

test('price guard: a real big move is believed after it holds for a day', () => {
  let s: GuardState = { usd: { per: 0.6, at: 0 } };
  let r = judgePrice(s, 'usd', 0.2, H);
  assert.equal(r.ok, false);
  s = r.next;
  r = judgePrice(s, 'usd', 0.21, 12 * H);
  assert.equal(r.ok, false, 'not yet');
  s = r.next;
  r = judgePrice(s, 'usd', 0.205, 25.5 * H);
  assert.equal(r.ok, true, 'held for over a day');
  assert.equal(r.next.usd!.per, 0.205);
  // A value that keeps jumping around never gets believed.
  s = { usd: { per: 0.6, at: 0 } };
  for (const [p, t] of [[0.2, 0], [0.05, 10], [0.2, 20], [0.05, 30]] as const) {
    r = judgePrice(s, 'usd', p, t * H);
    s = r.next;
    assert.equal(r.ok, false);
  }
  assert.equal(judgePrice(s, 'usd', Number.NaN, 0).ok, false);
});
