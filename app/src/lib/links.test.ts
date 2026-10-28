import { test } from 'node:test';
import assert from 'node:assert/strict';

import { giftLink, parseLink, payLink, payUri } from './links';

const ADDR = 'o1tseu9yag3yuz0tlfcuvleqppl9q4adr0pql3tqdyugsztj9e46dqqyfj6z';
const KEY = 'ab'.repeat(32);
/** Right-to-left override, used to disguise text. */
const RLO = String.fromCharCode(0x202e);

test('gift links round-trip and keep the secret after #', () => {
  const link = giftLink('https://noidusa.com', { secretHex: KEY, amount: '2.5', message: 'Happy birthday, Tolu!', theme: 'birthday', from: 'David' });
  assert.ok(link.startsWith('https://noidusa.com/g#'));
  assert.ok(!link.split('#')[0]!.includes(KEY), 'secret never in the path or query');
  const p = parseLink(link);
  assert.deepEqual(p, { kind: 'gift', secretHex: KEY, amount: '2.5', message: 'Happy birthday, Tolu!', theme: 'birthday', from: 'David' });
  assert.equal(parseLink(`noid://g?k=${KEY}&a=1`)?.kind, 'gift');
});

test('gift links from other sites, bad keys and bare secrets are refused', () => {
  assert.equal(parseLink(`https://evil.example/g#k=${KEY}`), null);
  assert.equal(parseLink(`https://noidusa.com/g#k=${'zz'.repeat(32)}`), null);
  assert.equal(parseLink(`https://noidusa.com/g#k=${'0'.repeat(64)}`), null);
  assert.equal(parseLink(KEY), null, 'a raw 64-char secret is never treated as a gift');
  assert.equal(parseLink(`http://noidusa.com/g#k=${KEY}`), null, 'http is not accepted');
});

test('messages are cleaned: no control or bidi characters, capped length', () => {
  const p = parseLink(`https://noidusa.com/g#k=${KEY}&m=${encodeURIComponent(`hi${RLO}evil\n\tthere` + 'x'.repeat(300))}&t=nope`);
  assert.ok(p?.kind === 'gift');
  if (p?.kind !== 'gift') return;
  assert.ok(!p.message.includes(RLO) && !/[\n\t]/.test(p.message));
  assert.equal(p.message.length, 120);
  assert.equal(p.theme, 'vault', 'unknown theme falls back');
});

test('payment requests: web link, noid: URI and bare address', () => {
  const link = payLink('https://noidusa.com/', { address: ADDR, amount: '1.25', note: 'Jollof rice' });
  assert.deepEqual(parseLink(link), { kind: 'pay', address: ADDR, amount: '1.25', note: 'Jollof rice' });
  assert.deepEqual(parseLink(payUri({ address: ADDR, amount: '3' })), { kind: 'address', address: ADDR, amount: '3' });
  assert.deepEqual(parseLink(payUri({ address: ADDR, note: 'rent' })), { kind: 'pay', address: ADDR, amount: undefined, note: 'rent' });
  assert.deepEqual(parseLink(ADDR.toUpperCase()), { kind: 'address', address: ADDR, amount: undefined });
  assert.equal(parseLink(`noid:${ADDR}?amount=-1`)?.kind, 'address');
  assert.equal((parseLink(`noid:${ADDR}?amount=1.1234567`) as { amount?: string }).amount, undefined, 'over 6 decimals ignored');
  assert.equal(parseLink('hello'), null);
});

test('gift links: secret only from "#", apps adding their own query are fine', () => {
  const KEY2 = 'ab'.repeat(32);
  assert.equal(parseLink(`https://noidusa.com/g?fbclid=XYZ#v=1&k=${KEY2}&a=1`)?.kind, 'gift');
  assert.equal(parseLink(`https://noidusa.com/g?v=1&k=${KEY2}&a=1`), null, 'a secret in the query part is refused');
  assert.equal(parseLink('https://noidusa.com/pay?fbclid=1#to=o1e7mkgm5cm9ngrexup6wpgkzzy9qzp25fwl223epu2llkpa7ftz9sx0fcsx&a=1')?.kind, 'pay');
});
