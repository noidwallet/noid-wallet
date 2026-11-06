import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { classify, Indexer, nativeArrivals } from "../src/indexer.js";
import { openDb } from "../src/db.js";
import type { BlockTx } from "../src/rpc.js";

const A = "o1wrznmh6td3mgg9mu0a3kkxxn2lnfu827uykrnpaa90mex8su9zcs5sjxrk";
const B = "o1e7mkgm5cm9ngrexup6wpgkzzy9qzp25fwl223epu2llkpa7ftz9sx0fcsx";

const tx = (over: Partial<BlockTx>): BlockTx => ({
  position: 0,
  txid: "aa".repeat(32),
  fee_micronoid: 9000,
  coinbase: false,
  development_payout: false,
  contract: null,
  input_owner: A,
  input_sum_micronoid: "0",
  output_sum_micronoid: "0",
  outputs: [],
  ...over,
});

test("payment with change: sender pays amount + fee, recipient receives", () => {
  const rows = classify(
    tx({ outputs: [{ slot_index: 1, amount_micronoid: 1_000_000, owner: B }, { slot_index: 2, amount_micronoid: 991_000, owner: A }] }),
  );
  assert.deepEqual(rows, [
    { address: A, direction: "sent", amount: 1_000_000, fee: 9000, walletFee: 0, counterparty: B },
    { address: B, direction: "received", amount: 1_000_000, fee: 0, walletFee: 0, counterparty: A },
  ]);
});

test("consolidation is a self transfer that only costs the fee", () => {
  const rows = classify(tx({ fee_micronoid: 6000, outputs: [{ slot_index: 3, amount_micronoid: 5_000_000, owner: A }] }));
  assert.deepEqual(rows, [{ address: A, direction: "self", amount: 0, fee: 6000, walletFee: 0, counterparty: A }]);
});

test("coinbase is mined income", () => {
  const rows = classify(tx({ coinbase: true, input_owner: null, outputs: [{ slot_index: 4, amount_micronoid: 14_400_000, owner: B }] }));
  assert.deepEqual(rows, [{ address: B, direction: "mined", amount: 14_400_000, fee: 0, walletFee: 0, counterparty: null }]);
});

test("store + rollback keep history consistent", () => {
  const db = openDb(join(mkdtempSync(join(tmpdir(), "noididx-")), "t.sqlite"));
  const idx = new Indexer(db, { pollMs: 1000, log: () => {} });
  idx.store({
    header: { height: 10, hash: "h10", timestamp: 1_700_000_000 },
    retained: { transactions: [tx({ outputs: [{ slot_index: 1, amount_micronoid: 5, owner: B }] })] },
  });
  assert.equal(idx.indexedHeight, 10);
  assert.equal((db.prepare("SELECT COUNT(*) c FROM address_txs").get() as { c: number }).c, 2);
  (idx as unknown as { rollback(h: number): void }).rollback(10);
  assert.equal(idx.indexedHeight, -1);
  assert.equal((db.prepare("SELECT COUNT(*) c FROM address_txs").get() as { c: number }).c, 0);
});

test("contract calls are labelled as contract activity", () => {
  const rows = classify(tx({ contract: "call", outputs: [{ slot_index: 9, amount_micronoid: 700, owner: B }] }));
  assert.ok(rows.every((r) => r.direction === "contract"));
});

test("NOID wallet fee output is shown as the sender's wallet fee, not a second recipient", () => {
  const F = "o1feeaddressexample";
  const fees = new Set([F]);
  const pay = tx({
    fee_micronoid: 12_200,
    outputs: [
      { slot_index: 1, amount_micronoid: 1_000_000, owner: B },
      { slot_index: 2, amount_micronoid: 5_000, owner: F },
      { slot_index: 3, amount_micronoid: 900_000, owner: A },
    ],
  });
  assert.deepEqual(classify(pay, fees), [
    { address: A, direction: "sent", amount: 1_000_000, fee: 12_200, walletFee: 5_000, counterparty: B },
    { address: B, direction: "received", amount: 1_000_000, fee: 0, walletFee: 0, counterparty: A },
    { address: F, direction: "received", amount: 5_000, fee: 0, walletFee: 0, counterparty: A },
  ]);
  // Paying the fee address directly is a normal payment.
  const direct = classify(tx({ outputs: [{ slot_index: 4, amount_micronoid: 7, owner: F }] }), fees);
  assert.deepEqual(direct[0], { address: A, direction: "sent", amount: 7, fee: 9000, walletFee: 0, counterparty: F });
  // Without the fee address configured: two recipients, as before.
  assert.equal(classify(pay)[0]!.counterparty, null);
});

test("a node that is behind (resync, reindex) never makes the indexer delete history", async () => {
  const db = openDb(join(mkdtempSync(join(tmpdir(), "noidbehind-")), "t.sqlite"));
  const idx = new Indexer(db, { pollMs: 1000, log: () => {} });
  for (let h = 80; h <= 100; h++) {
    idx.store({ header: { height: h, hash: `h${h}`, timestamp: 1_700_000_000 + h }, retained: { transactions: [] } });
  }
  let nodeHeight = 5;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
    const { method, params } = JSON.parse(String(init?.body)) as { method: string; params: number[] };
    const result =
      method === "paranoid_getChainInfo"
        ? { height: nodeHeight, best_hash: "x", active_slot_count: 0, log_slots: 24 }
        : method === "paranoid_getBlockHash"
          ? params[0]! <= nodeHeight
            ? `h${params[0]}`
            : null
          : null;
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    for (let i = 0; i < 6; i++) await idx.step();
    assert.equal(idx.indexedHeight, 100, "node far behind: nothing rolled back");
    nodeHeight = 98; // caught up partly: blocks above its tip are unknown, not reorged
    await idx.step();
    assert.equal(idx.indexedHeight, 100);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("v2.1 native finance: shown as contract activity, commitment-owned slots left out", () => {
  const rows = classify(
    tx({
      native: { operation: "curve_buy" },
      outputs: [
        { slot_index: 5, amount_micronoid: 2_000_000, owner: "o1commitment", native: true },
        { slot_index: 6, amount_micronoid: 300_000, owner: A },
      ],
    }),
  );
  assert.deepEqual(rows, [{ address: A, direction: "contract", amount: 300_000, fee: 9000, walletFee: 0, counterparty: null }]);
  // An ordinary payment in a v2.1 block is unchanged.
  const pay = classify(tx({ native: null, trades: [], outputs: [{ slot_index: 1, amount_micronoid: 1_000, owner: B, native: false }] }));
  assert.equal(pay[0]!.direction, "sent");
});

test("token transfer: the sender sees the NOID that left, not its change", () => {
  const FEE = "o155fsn6m5au9ardteuw0qc77agzzp6a99c8j5k60qumdwus5ajwesf9magf";
  const rows = classify(
    tx({
      input_owner: A,
      fee_micronoid: 12_000,
      input_sum_micronoid: "1000000",
      native: { operation: "transfer_token", token_outputs: [{ owner: B, units: "30" }, { owner: A, units: "70" }], nft_outputs: [] },
      outputs: [
        { slot_index: 1, amount_micronoid: 0, owner: "o1rootrecipient", native: true },
        { slot_index: 2, amount_micronoid: 0, owner: "o1rootchange", native: true },
        { slot_index: 3, amount_micronoid: 983_000, owner: A },
        { slot_index: 4, amount_micronoid: 5_000, owner: FEE },
      ],
    }),
    new Set([FEE]),
  );
  assert.deepEqual(rows.find((r) => r.address === A), { address: A, direction: "contract", amount: 17_000, fee: 12_000, walletFee: 5_000, counterparty: B });
  assert.equal(rows.find((r) => r.address === B), undefined);
});

test("token and NFT arrivals: the recipient and what they got, never the sender's change", () => {
  const C = "o1s32s5m9ughjv2ktvxm8m7y0gmu0swys5t0ufkdnyhv02nudc23cqg7y34s";
  const T = "ab".repeat(32);
  const K = "cd".repeat(32);
  const t = tx({
    input_owner: A,
    native: {
      operation: "transfer_token",
      token_outputs: [
        { owner: B, units: "30", asset_id: T },
        { owner: B, units: "12", asset_id: T },
        { owner: A, units: "70", asset_id: T },
        { owner: C, units: "0", asset_id: T },
      ],
      nft_outputs: [],
    },
  });
  assert.deepEqual(nativeArrivals(t), [{ address: B, kind: "token", itemId: T, units: "42", count: 1 }]);
  assert.equal(classify(t).find((r) => r.address === B), undefined);
  const nft = tx({
    input_owner: A,
    native: { operation: "transfer_nft", token_outputs: [], nft_outputs: [{ owner: C, collection_id: K, serial: 7 }, { owner: C, collection_id: K, serial: "18446744073709551615" }] },
  });
  assert.deepEqual(nativeArrivals(nft), [{ address: C, kind: "nft", itemId: K, units: "7", count: 2 }]);
  const big = tx({ input_owner: A, native: { operation: "transfer_nft", token_outputs: [], nft_outputs: [{ owner: C, collection_id: K, serial: "18446744073709551615" }] } });
  assert.equal(nativeArrivals(big)[0]!.units, "18446744073709551615");
  // Anything else (a trade, a mint, a malformed owner, ID or amount, an older node) gives nobody a row.
  for (const native of [
    { operation: "trade_batch", token_outputs: [{ owner: B, units: "5", asset_id: T }], nft_outputs: [] },
    { operation: "mint_nft", token_outputs: [], nft_outputs: [{ owner: B, collection_id: K, serial: 1 }] },
    { operation: "transfer_token", token_outputs: [{ owner: "not an address", units: "5", asset_id: T }, { owner: 7, units: "5", asset_id: T }], nft_outputs: [] },
    { operation: "transfer_token", token_outputs: [{ owner: B, units: "5", asset_id: "XY" }, { owner: B, units: "05", asset_id: T }], nft_outputs: [] },
    { operation: "transfer_nft", token_outputs: [], nft_outputs: [{ owner: B, collection_id: "nope", serial: 1 }] },
    null,
    undefined,
  ]) {
    assert.deepEqual(nativeArrivals(tx({ input_owner: A, native })), []);
  }
  assert.deepEqual(nativeArrivals({ ...t, input_owner: null }), [], "no sender known: nobody");
});

test("indexer: a token arrival is stored as its own row and notified once", () => {
  const db = openDb(join(mkdtempSync(join(tmpdir(), "noididx-")), "t.sqlite"));
  const idx = new Indexer(db, { pollMs: 1000, log: () => {} });
  const T = "ab".repeat(32);
  const block = {
    header: { height: 5, hash: "h5", timestamp: 1_700_000_005 },
    retained: {
      transactions: [
        tx({
          input_owner: A,
          fee_micronoid: 12_000,
          input_sum_micronoid: "1000000",
          native: { operation: "transfer_token", token_outputs: [{ owner: B, units: "30", asset_id: T }], nft_outputs: [] },
          outputs: [
            { slot_index: 1, amount_micronoid: 0, owner: "o1rootrecipient", native: true },
            { slot_index: 3, amount_micronoid: 988_000, owner: A },
          ],
        }),
      ],
    },
  };
  const rows = idx.store(block);
  assert.deepEqual(rows.find((r) => r.address === B), { address: B, txid: "aa".repeat(32), direction: "token_in", amount: 0 });
  const row = db.prepare("SELECT direction, amount, fee, wallet_fee, counterparty, item_id, item_units, item_count FROM address_txs WHERE address = ?").get(B);
  assert.deepEqual({ ...(row as object) }, { direction: "token_in", amount: 0, fee: 0, wallet_fee: 0, counterparty: A, item_id: T, item_units: "30", item_count: 1 });
  // Stored again (a reorg replaying the block): no second row, nothing new to notify.
  assert.equal(idx.store(block).find((r) => r.address === B), undefined);
});
