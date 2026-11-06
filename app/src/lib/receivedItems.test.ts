import { test } from 'node:test';
import assert from 'node:assert/strict';

import { receivedLabel, type ItemLookup } from './receivedItems';

const T = 'ab'.repeat(32);
const K = 'cd'.repeat(32);
const lookup = (tokens: Record<string, { name: string | null; symbol: string | null }>, nfts: Record<string, string> = {}): ItemLookup => ({
  token: (id) => tokens[id] ?? null,
  nft: (c, s) => (nfts[`${c}:${s}`] ? { name: nfts[`${c}:${s}`]! } : null),
});
const tokenRow = { direction: 'token_in' as const, itemId: T, itemUnits: '3000000', itemCount: 1 };

test('received tokens: amount and checked ticker, or nothing that could pass for NOID', () => {
  assert.equal(receivedLabel(tokenRow, lookup({ [T]: { name: 'Ignotus Nemo', symbol: 'NEMO' } })), 'Received 3 NEMO');
  assert.equal(receivedLabel(tokenRow, lookup({ [T]: { name: 'Ignotus Nemo', symbol: 'NEMO' } }), { hidden: true }), 'Received NEMO', 'hidden: no amount');
  assert.equal(receivedLabel(tokenRow, lookup({})), 'Received a token', 'unknown to this phone');
  for (const fake of [{ name: 'NOID', symbol: 'NOID' }, { name: 'Free coins', symbol: 'N0ID' }, { name: 'Nоid', symbol: 'X' }]) {
    assert.equal(receivedLabel(tokenRow, lookup({ [T]: fake })), 'Received a token (not NOID)', JSON.stringify(fake));
  }
  assert.equal(receivedLabel({ ...tokenRow, itemUnits: null }, lookup({ [T]: { name: 'A', symbol: 'AAA' } })), 'Received a token');
});

test('received NFTs: their checked name, a count, or plainly "an NFT"', () => {
  const row = { direction: 'nft_in' as const, itemId: K, itemUnits: '7', itemCount: 1 };
  assert.equal(receivedLabel(row, lookup({}, { [`${K}:7`]: 'Night Garden #7' })), 'Received NFT: Night Garden #7');
  assert.equal(receivedLabel(row, lookup({})), 'Received an NFT');
  assert.equal(receivedLabel(row, lookup({}, { [`${K}:7`]: '1000 NOID' })), 'Received an NFT', 'a name that reads as NOID is not shown');
  assert.equal(receivedLabel({ ...row, itemCount: 3 }, lookup({})), 'Received 3 NFTs');
  assert.equal(receivedLabel(row, lookup({}, { [`${K}:7`]: '50,000 USDT' })), 'Received NFT: 50,000 USDT', 'never reads as a payment');
});
