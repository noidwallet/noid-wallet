import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createDirectPrice, DIRECT_SOURCE, noidUsdFromPaprika, PAPRIKA_MARKETS_URL } from './directPrice';

const T0 = Date.parse('2026-10-20T12:00:00Z');
const market = (pair: string, price: unknown, at: number, volume = 1000) => ({
  pair,
  last_updated: new Date(at).toISOString(),
  quotes: { USD: { price, volume_24h: volume } },
});

test('picks a recent NOID market, NOID/USDT first, and ignores stale or broken quotes', () => {
  assert.equal(
    noidUsdFromPaprika([market('NOID/BTC', 0.7, T0, 9999), market('NOID/USDT', 0.6, T0 - 60_000, 5)], T0),
    0.6,
  );
  assert.equal(noidUsdFromPaprika([market('NOID/USDT', 0.6, T0 - 3 * 3600_000)], T0), null, 'too old');
  assert.equal(noidUsdFromPaprika([market('NOID/USDT', 'x', T0), market('BTC/USDT', 1, T0)], T0), null);
  assert.equal(noidUsdFromPaprika([market('NOID/USDT', 0.6, T0 + 3600_000)], T0), null, 'from the future');
  assert.equal(noidUsdFromPaprika({ error: 'blocked' }, T0), null);
});

test('phone price: server rates, caching, age, and a one-off jump held back', async () => {
  let now = T0;
  let usd = 0.6;
  let paprikaCalls = 0;
  let fxCalls = 0;
  const dp = createDirectPrice({
    now: () => now,
    fetchJson: async (url) => {
      assert.equal(url, PAPRIKA_MARKETS_URL);
      paprikaCalls++;
      return [market('NOID/USDT', usd, now)];
    },
  });
  const fx = async () => {
    fxCalls++;
    return { rates: { NGN: 1500, EUR: 0.9, bad: 3, GBP: -1 } };
  };

  const p = await dp.get(fx);
  assert.equal(p?.usd, 0.6);
  assert.equal(p?.ngn, 900);
  assert.deepEqual(p?.rates, { NGN: 1500, EUR: 0.9 });
  assert.equal(p?.source, DIRECT_SOURCE);
  assert.equal(p?.ageMs, 0);

  // Within two minutes the same answer is reused, and its age grows.
  now += 60_000;
  const again = await dp.get(fx);
  assert.equal(paprikaCalls, 1);
  assert.equal(again?.ageMs, 60_000);

  // A doubled price is held back once, then accepted when seen again.
  usd = 1.2;
  now += 2 * 60_000;
  assert.equal((await dp.get(fx))?.usd, 0.6);
  now += 2 * 60_000;
  assert.equal((await dp.get(fx))?.usd, 1.2);
  assert.equal(fxCalls, 1, 'rates asked for once an hour');
});

test('phone price: no rates still gives USD; blocked source gives the last price for a while, then none', async () => {
  let now = T0;
  let down = false;
  const dp = createDirectPrice({
    now: () => now,
    fetchJson: async () => {
      if (down) throw new Error('HTTP 403');
      return [market('NOID/USDT', 0.5, now)];
    },
  });
  const noFx = async () => {
    throw new Error('not found');
  };
  const p = await dp.get(noFx);
  assert.equal(p?.usd, 0.5);
  assert.equal(p?.ngn, null);
  assert.deepEqual(p?.rates, {});

  down = true;
  now += 5 * 60_000;
  const stale = await dp.get(noFx);
  assert.equal(stale?.usd, 0.5);
  assert.equal(stale?.ageMs, 5 * 60_000);
  now += 30 * 60_000;
  assert.equal(await dp.get(noFx), null, 'too old: no price rather than a wrong one');
});
