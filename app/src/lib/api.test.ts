import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ApiError, appText, createApi, isAllowedServerUrl } from './api';

test('server URLs: https anywhere, http only to a private IP on your network (test builds)', () => {
  assert.equal(isAllowedServerUrl('https://api.noidusa.com'), true);
  assert.equal(isAllowedServerUrl('http://192.168.1.123:8787', true), true);
  assert.equal(isAllowedServerUrl('http://10.0.0.5:8787/', true), true);
  assert.equal(isAllowedServerUrl('http://localhost:8787', true), true);
  assert.equal(isAllowedServerUrl('http://192.168.1.123:8787', false), false, 'release builds: https only');
  assert.equal(isAllowedServerUrl('http://api.noidusa.com'), false);
  assert.equal(isAllowedServerUrl('http://127.0.0.1@evil.com'), false, 'no user@host tricks');
  assert.equal(isAllowedServerUrl('http://10.evil.com'), false, 'private ranges must be real IPs');
  assert.equal(isAllowedServerUrl('http://192.168.1.999'), false);
  assert.equal(isAllowedServerUrl('ftp://192.168.1.1'), false);
});

test('only known server refusals count as definitely not sent', () => {
  assert.equal(new ApiError('inputs_spent', 'x', 422).ambiguous, false);
  assert.equal(new ApiError('bad_request', 'x', 400).ambiguous, false);
  assert.equal(new ApiError('http_error', 'x', 404).ambiguous, true, 'a proxy 404 might have forwarded it');
  assert.equal(new ApiError('offline', 'x', 0).ambiguous, true);
  // Our server's busy on submit comes before relaying; a bare 503 might not.
  assert.equal(new ApiError('busy', 'x', 503, true).ambiguous, false);
  assert.equal(new ApiError('http_error', 'x', 503).ambiguous, true);
  assert.equal(new ApiError('busy', 'x', 503, false).ambiguous, true);
  assert.equal(new ApiError('unknown_status', 'x', 503).ambiguous, true);
});

test('server error text is the app\'s own, never the server\'s words', () => {
  assert.equal(appText('busy', 422), 'The network is busy. Try again in a minute.');
  assert.match(appText('send_all_to_x', 400), /could not do this right now/);
  assert.match(appText('busy', 429), /Too many requests/);
});

function withFetch(body: unknown, fn: () => Promise<void>) {
  const saved = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify(body), { status: 200 })) as typeof fetch;
  return fn().finally(() => {
    globalThis.fetch = saved;
  });
}

test('coin lists that do not add up are refused', async () => {
  const api = createApi('https://example.test');
  const a = 'o1abc';
  await withFetch({ address: a, balance: 7, utxos: [{ slotIndex: 1, value: 5, creationId: '9' }] }, async () => {
    await assert.rejects(api.utxos(a), (e: unknown) => e instanceof ApiError && e.code === 'bad_response');
  });
  await withFetch({ address: a, balance: 5, utxos: [{ slotIndex: 1, value: -5, creationId: '9' }] }, async () => {
    await assert.rejects(api.utxos(a), (e: unknown) => e instanceof ApiError && e.code === 'bad_response');
  });
  await withFetch({ address: a, balance: 5, utxos: [{ slotIndex: 1, value: 5, creationId: '9' }] }, async () => {
    assert.equal((await api.utxos(a)).balance, 5);
  });
});

test('history with fractional or negative amounts is refused', async () => {
  const api = createApi('https://example.test');
  const item = { txid: 'ab', height: 3, time: 1, direction: 'sent', amount: 1.5, fee: 0, counterparty: null };
  await withFetch({ items: [item], nextBefore: null, indexedFrom: 0 }, async () => {
    await assert.rejects(api.history('o1abc'), (e: unknown) => e instanceof ApiError && e.code === 'bad_response');
  });
});

test('the phone never takes server data it cannot read: creation ids, headers pages, block ids, used lists', async () => {
  const api = createApi('https://example.test');
  const a = 'o1abc';
  // A numeric creation id would fail inside the core later; refuse it at the door.
  await withFetch({ address: a, balance: 5, utxos: [{ slotIndex: 1, value: 5, creationId: 9 }] }, async () => {
    await assert.rejects(api.utxos(a), (e: ApiError) => e.code === 'bad_response');
  });
  const hex = 'ab'.repeat(212);
  await withFetch({ from: 10, tip: 12, headers: [hex, hex] }, async () => {
    assert.deepEqual((await api.headers(10, 2)).headers.length, 2);
  });
  for (const bad of [
    { from: 11, tip: 12, headers: [hex] }, // not the page asked for
    { from: 10, tip: 12, headers: [hex, hex, hex] }, // more than asked
    { from: 10, tip: 12, headers: [hex.slice(2)] }, // not 212 bytes
    { from: 10, tip: 12, headers: [hex.toUpperCase()] },
    { from: 10, tip: -1, headers: [] },
  ]) {
    await withFetch(bad, async () => {
      await assert.rejects(api.headers(10, 2), (e: ApiError) => e.code === 'bad_response');
    });
  }
  const txid = 'c'.repeat(64);
  await withFetch({ txid, status: 'confirmed', height: 5, confirmations: 1, blockHash: 'zz' }, async () => {
    await assert.rejects(api.tx(txid), (e: ApiError) => e.code === 'bad_response');
  });
  await withFetch({ txid, status: 'confirmed', height: 5, confirmations: 1, blockHash: 'd'.repeat(64) }, async () => {
    const r = await api.tx(txid);
    assert.equal(r.status === 'confirmed' && r.blockHash, 'd'.repeat(64));
  });
  await withFetch({ used: 'o1abc' }, async () => {
    await assert.rejects(api.addressesUsed([a]), (e: ApiError) => e.code === 'bad_response');
  });
});

test('history: received token and NFT rows must name what arrived, and only they may', async () => {
  const api = createApi('https://example.test');
  const tx = (c: string) => c.repeat(64);
  const T = 'ab'.repeat(32);
  const arrival = { txid: tx('a'), height: 3, time: 1, direction: 'token_in', amount: 0, fee: 0, counterparty: null, itemId: T, itemUnits: '30', itemCount: 1 };
  let url = '';
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (u: string) => {
    url = u;
    return new Response(JSON.stringify({ items: [arrival], nextBefore: null, indexedFrom: 0 }), { status: 200 });
  }) as typeof fetch;
  try {
    const r = await api.history('o1abc');
    assert.equal(r.items[0]!.itemUnits, '30');
    assert.match(url, /\/history\?native=1$/, 'asks for received token rows');
    await api.history('o1abc', `3:${tx('a')}`);
    assert.match(url, /\?native=1&before=3%3Aa{64}$/);
  } finally {
    globalThis.fetch = realFetch;
  }
  for (const bad of [
    { ...arrival, itemId: 'nothex' },
    { ...arrival, itemUnits: '1.5' },
    { ...arrival, itemCount: 0 },
    { ...arrival, amount: 5, }, // a received token never carries NOID
    { ...arrival, itemId: undefined },
    { txid: tx('b'), height: 3, time: 1, direction: 'received', amount: 5, fee: 0, counterparty: null, itemId: T }, // a payment names no item
  ]) {
    await withFetch({ items: [bad], nextBefore: null, indexedFrom: 0 }, async () => {
      await assert.rejects(api.history('o1abc'), (e: unknown) => e instanceof ApiError && e.code === 'bad_response', JSON.stringify(bad));
    });
  }
  // Rows from older servers (no item fields at all) still pass.
  await withFetch({ items: [{ txid: tx('c'), height: 3, time: 1, direction: 'received', amount: 5, fee: 0, counterparty: null }], nextBefore: null, indexedFrom: 0 }, async () => {
    assert.equal((await api.history('o1abc')).items.length, 1);
  });
});
