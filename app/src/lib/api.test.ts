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
