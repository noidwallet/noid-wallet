import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CoinMismatch, dropReplaced, MAX_PER_ROUND, PROOF_TTL_MS, ProofShapeError, proveCoins, REPROVE_MS, summarize, toProve, type ProveDeps, type Records, type Suspects } from './coinProofs';
import type { Utxo } from './core';

const ME = 'o1wrznmh6td3mgg9mu0a3kkxxn2lnfu827uykrnpaa90mex8su9zcs5sjxrk';
const coins: Utxo[] = [
  { slotIndex: 9, value: 500, creationId: '9223372036854775809' },
  { slotIndex: 4, value: 1_000, creationId: '42' },
];

/** A fake node + core: proofs echo the asked slots, at block 300 (`b300`). */
function deps(over: Partial<ProveDeps> = {}) {
  const asked: number[][] = [];
  let syncs = 0;
  const d: ProveDeps = {
    slotProofs: async (indices) => {
      asked.push(indices);
      return { proofs: [{ slots: indices.map((i) => ({ slot_index: i })) }] };
    },
    verify: async (proof, indices) => ({
      status: 'proven',
      height: 300,
      blockId: 'b300',
      checked: false,
      slots: indices.map((i) => {
        const u = coins.find((c) => c.slotIndex === i)!;
        return { slotIndex: i, value: u.value, creationId: u.creationId, owner: ME, empty: false };
      }),
    }),
    syncChain: async () => {
      syncs++;
    },
    utxos: async () => coins,
    ...over,
  };
  return { d, asked, syncs: () => syncs };
}

test('prove: asks for unproven coins in slot order, records what the proofs show', async () => {
  const { d, asked } = deps();
  const r = await proveCoins(d, ME, coins, new Map(), new Map(), 1_000);
  assert.deepEqual(asked, [[4, 9]]);
  assert.deepEqual(r.get(9), { creationId: '9223372036854775809', value: 500, height: 300, blockId: 'b300', at: 1_000 });
  // Proven already: nothing asked again. A coin that changed (new creation id) is asked again.
  const again = deps();
  await proveCoins(again.d, ME, coins, r, new Map(), 1_000 + REPROVE_MS);
  assert.deepEqual(again.asked, []);
  // Old proofs are asked again (a coin spent since must not stay proven).
  const later = deps();
  await proveCoins(later.d, ME, coins, r, new Map(), 1_001 + REPROVE_MS);
  assert.deepEqual(later.asked, [[4, 9]]);
  const moved = [{ ...coins[0]!, creationId: '7' }, coins[1]!];
  const third = deps({ verify: async (_p, idx) => ({ status: 'proven', height: 301, blockId: 'b301', checked: false, slots: idx.map((i) => ({ slotIndex: i, value: 500, creationId: '7', owner: ME, empty: false })) }) });
  const r2 = await proveCoins(third.d, ME, moved, r, new Map(), 1_000);
  assert.deepEqual(third.asked, [[9]]);
  assert.equal(r2.get(9)!.creationId, '7');
  // Coins no longer listed are forgotten.
  const r3 = await proveCoins(deps().d, ME, [coins[1]!], r, new Map(), 1_000);
  assert.deepEqual([...r3.keys()], [4]);
});

test('prove: a coin the State contradicts, still listed, is a lie; one spent meanwhile is not', async () => {
  const lying = deps({
    verify: async (_p, idx) => ({ status: 'proven', height: 300, blockId: 'b300', checked: true, slots: idx.map((i) => ({ slotIndex: i, value: i === 9 ? 5 : 1_000, creationId: i === 9 ? '9223372036854775809' : '42', owner: ME, empty: false })) }),
  });
  await assert.rejects(proveCoins(lying.d, ME, coins, new Map()), (e) => e instanceof CoinMismatch && e.coins.length === 1 && e.coins[0]!.slotIndex === 9);
  // Someone else's coin, or an empty slot: also refused.
  for (const slot of [{ owner: 'o1s32s5m9ughjv2ktvxm8m7y0gmu0swys5t0ufkdnyhv02nudc23cqg7y34s', empty: false }, { owner: '', empty: true }]) {
    const other = deps({ verify: async (_p, idx) => ({ status: 'proven', height: 300, blockId: 'b300', checked: true, slots: idx.map((i) => ({ slotIndex: i, value: coins.find((c) => c.slotIndex === i)!.value, creationId: coins.find((c) => c.slotIndex === i)!.creationId, ...slot })) }) });
    await assert.rejects(proveCoins(other.d, ME, coins, new Map()), CoinMismatch);
  }
  // Spent between the list and the proof: the fresh list no longer has it. Fine, and nothing recorded for it.
  const spent = deps({
    verify: async (_p, idx) => ({ status: 'proven', height: 300, blockId: 'b300', checked: true, slots: idx.map((i) => (i === 9 ? { slotIndex: 9, value: 0, creationId: '0', owner: '', empty: true } : { slotIndex: 4, value: 1_000, creationId: '42', owner: ME, empty: false })) }),
    utxos: async () => [coins[1]!],
  });
  const r = await proveCoins(spent.d, ME, coins, new Map());
  assert.deepEqual([...r.keys()], [4]);
});

test('prove: a re-proof that contradicts an old record drops it, even if the coin was spent meanwhile', async () => {
  const old: Records = new Map([[9, { creationId: '9223372036854775809', value: 500, height: 290, blockId: 'b290', at: 0 }]]);
  const spent = deps({
    verify: async (_p, idx) => ({ status: 'proven', height: 300, blockId: 'b300', checked: true, slots: idx.map((i) => (i === 9 ? { slotIndex: 9, value: 0, creationId: '0', owner: '', empty: true } : { slotIndex: 4, value: 1_000, creationId: '42', owner: ME, empty: false })) }),
    utxos: async () => [coins[1]!],
  });
  const r = await proveCoins(spent.d, ME, coins, old, new Map(), REPROVE_MS + 1);
  assert.equal(r.has(9), false);
});

test('prove: an unknown block means catch up once, then no verdict; answers must match the question', async () => {
  let calls = 0;
  const behind = deps({
    verify: async () => {
      calls++;
      return { status: 'unknown_block', height: 310, phoneTip: 305 };
    },
  });
  const r = await proveCoins(behind.d, ME, coins, new Map());
  assert.equal(calls, 2);
  assert.equal(behind.syncs(), 1);
  assert.equal(r.size, 0, 'no verdict, nothing recorded');
  for (const proofs of [[{ slots: [{ slot_index: 4 }] }], [{ slots: [{ slot_index: 9 }, { slot_index: 4 }] }], [{ slots: [{ slot_index: 4 }, { slot_index: 9 }, { slot_index: 11 }] }], [{ nope: 1 }]]) {
    const bad = deps({ slotProofs: async () => ({ proofs }) });
    await assert.rejects(proveCoins(bad.d, ME, coins, new Map()), ProofShapeError, JSON.stringify(proofs));
  }
  // A proof that fails in the core fails the round.
  const broken = deps({ verify: async () => Promise.reject(Object.assign(new Error('x'), { code: 'proof_invalid' })) });
  await assert.rejects(proveCoins(broken.d, ME, coins, new Map()), /x/);
});

test('summary: proven only in blocks the phone counts as checked; replaced blocks are proven again', () => {
  const records: Records = new Map([
    [4, { creationId: '42', value: 1_000, height: 300, blockId: 'b300', at: 0 }],
    [9, { creationId: '9223372036854775809', value: 500, height: 310, blockId: 'b310', at: 0 }],
  ]);
  const checked = (h: number, id: string) => (h <= 302 ? id === 'b300' || id === `b${h}` : null);
  assert.deepEqual(summarize(coins, records, checked, 0), { coins: 2, proven: 1, provenValue: 1_000, waiting: 1, unproven: 0, blocks: [300, 300] });
  const replaced = (h: number) => (h === 300 ? false : null);
  assert.deepEqual(summarize(coins, records, replaced, 0), { coins: 2, proven: 0, provenValue: 0, waiting: 1, unproven: 1, blocks: null });
  assert.deepEqual([...dropReplaced(records, replaced).keys()], [9]);
  // A record for a different coin in the same slot doesn't count.
  assert.equal(summarize([{ ...coins[1]!, creationId: '43' }], records, () => true, 0).proven, 0);
  // Big wallets: at most MAX_PER_ROUND per round.
  const many = Array.from({ length: 300 }, (_, i) => ({ slotIndex: 1_000 - i, value: 1, creationId: String(i) }));
  const first = toProve(many, new Map(), 0);
  assert.equal(first.length, MAX_PER_ROUND);
  assert.ok(first.every((v, k) => k === 0 || v > first[k - 1]!));
});

test('expiry: an old proof stops counting even if the re-proof never comes', () => {
  const records: Records = new Map([[4, { creationId: '42', value: 1_000, height: 300, blockId: 'b300', at: 0 }]]);
  assert.equal(summarize([coins[1]!], records, () => true, PROOF_TTL_MS).proven, 1);
  assert.equal(summarize([coins[1]!], records, () => true, PROOF_TTL_MS + 1).proven, 0);
  assert.ok(REPROVE_MS < PROOF_TTL_MS, 'asked again before it stops counting');
});

test('suspects: a coin hidden while checked and listed again is a lie', async () => {
  const suspects: Suspects = new Map();
  const hide = deps({
    verify: async (_p, idx) => ({ status: 'proven', height: 300, blockId: 'b300', checked: true, slots: idx.map((i) => (i === 9 ? { slotIndex: 9, value: 0, creationId: '0', owner: '', empty: true } : { slotIndex: 4, value: 1_000, creationId: '42', owner: ME, empty: false })) }),
    utxos: async () => [coins[1]!], // hidden from the second list
  });
  await proveCoins(hide.d, ME, coins, new Map(), suspects, 0);
  assert.equal(suspects.get(9), '9223372036854775809');
  // Next refresh lists it again: refused before any request.
  const next = deps();
  await assert.rejects(proveCoins(next.d, ME, coins, new Map(), suspects, 1), CoinMismatch);
  assert.deepEqual(next.asked, []);
});

test('partial answers: the server proves the first slots and names the rest', async () => {
  const part = deps({ slotProofs: async (indices) => ({ proofs: [{ slots: [{ slot_index: indices[0] }] }], rest: indices.slice(1) }) });
  const r = await proveCoins(part.d, ME, coins, new Map(), new Map(), 0);
  assert.deepEqual([...r.keys()], [4]);
  const wrongRest = deps({ slotProofs: async (indices) => ({ proofs: [{ slots: [{ slot_index: indices[0] }] }], rest: [77] }) });
  await assert.rejects(proveCoins(wrongRest.d, ME, coins, new Map(), new Map(), 0), ProofShapeError);
  const noRest = deps({ slotProofs: async (indices) => ({ proofs: [{ slots: [{ slot_index: indices[0] }] }] }) });
  await assert.rejects(proveCoins(noRest.d, ME, coins, new Map(), new Map(), 0), ProofShapeError);
});
