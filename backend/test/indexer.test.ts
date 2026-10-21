import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { classify, Indexer } from "../src/indexer.js";
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
