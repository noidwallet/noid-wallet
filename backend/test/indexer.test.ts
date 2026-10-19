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
    { address: A, direction: "sent", amount: 1_000_000, fee: 9000, counterparty: B },
    { address: B, direction: "received", amount: 1_000_000, fee: 0, counterparty: A },
  ]);
});

test("consolidation is a self transfer that only costs the fee", () => {
  const rows = classify(tx({ fee_micronoid: 6000, outputs: [{ slot_index: 3, amount_micronoid: 5_000_000, owner: A }] }));
  assert.deepEqual(rows, [{ address: A, direction: "self", amount: 0, fee: 6000, counterparty: A }]);
});

test("coinbase is mined income", () => {
  const rows = classify(tx({ coinbase: true, input_owner: null, outputs: [{ slot_index: 4, amount_micronoid: 14_400_000, owner: B }] }));
  assert.deepEqual(rows, [{ address: B, direction: "mined", amount: 14_400_000, fee: 0, counterparty: null }]);
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
