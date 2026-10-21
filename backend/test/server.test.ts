import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDb } from "../src/db.js";
import { Indexer } from "../src/indexer.js";
import { buildServer, classifySubmitError } from "../src/server.js";
import { parseNodeJson } from "../src/rpc.js";

const A = "o1wrznmh6td3mgg9mu0a3kkxxn2lnfu827uykrnpaa90mex8su9zcs5sjxrk";

test("64-bit creation_id survives node JSON parsing", () => {
  const parsed = parseNodeJson('{"result":[{"slot_index":7,"value":14400000,"creation_id":9223372036854917145,"owner":"x","empty":false}]}') as {
    result: { creation_id: string; value: number }[];
  };
  assert.equal(parsed.result[0]!.creation_id, "9223372036854917145");
  assert.equal(parsed.result[0]!.value, 14400000);
});

test("submit errors use exact node variants", () => {
  assert.deepEqual(classifySubmitError("already admitted: TxBodyHash(..)"), { kind: "accepted" });
  const fee = classifySubmitError("consensus: BelowMinFee: required=9000 actual=5000");
  assert.equal(fee.kind === "rejected" && fee.code, "fee_too_low");
  const spent = classifySubmitError("consensus: BadStateRoot");
  assert.ok(spent.kind === "rejected" && spent.code === "inputs_spent" && !spent.retryable);
  const anchor = classifySubmitError("consensus: BadEpochAnchor");
  assert.ok(anchor.kind === "rejected" && anchor.retryable);
  const bug = classifySubmitError("consensus: InvalidPagedSpend: bad bitmap");
  assert.ok(bug.kind === "rejected" && !bug.retryable && bug.code === "rejected");
});

test("history pages by (height, txid) without skipping rows in the same block", async () => {
  const db = openDb(join(mkdtempSync(join(tmpdir(), "noidsrv-")), "t.sqlite"));
  const ins = db.prepare(
    "INSERT INTO address_txs (address, txid, height, time, direction, amount, fee, counterparty) VALUES (?, ?, ?, 0, 'received', 1, 0, NULL)",
  );
  const ids = ["a", "b", "c", "d", "e"].map((c) => c.repeat(64));
  ins.run(A, ids[0], 10); ins.run(A, ids[1], 10); ins.run(A, ids[2], 10); ins.run(A, ids[3], 9); ins.run(A, ids[4], 8);
  const app = await buildServer(db, new Indexer(db, { pollMs: 1000, log: () => {} }), { trustProxy: false });
  const seen: string[] = [];
  let cursor: string | null = null;
  do {
    const res = await app.inject({ url: `/v1/address/${A}/history?limit=2${cursor ? `&before=${cursor}` : ""}` });
    const body = res.json() as { items: { txid: string }[]; nextBefore: string | null };
    seen.push(...body.items.map((i) => i.txid));
    cursor = body.nextBefore;
  } while (cursor);
  assert.deepEqual(seen, ids);
  const bad = await app.inject({ url: `/v1/address/${A}/history?limit=abc` });
  assert.equal(bad.statusCode, 400);
  await app.close();
});

test("node HTTP errors on submit are never reported as a definite refusal", async () => {
  const { RpcError } = await import("../src/rpc.js");
  const e = new RpcError("node HTTP 503", undefined, true);
  assert.equal(e.transport, true);
  assert.equal(new RpcError("consensus: BadStateRoot").transport, false);
});

test("addresses/used: which of a batch have history, validated and capped", async () => {
  const db = openDb(join(mkdtempSync(join(tmpdir(), "noidused-")), "t.sqlite"));
  db.prepare(
    "INSERT INTO address_txs (address, txid, height, time, direction, amount, fee, counterparty) VALUES (?, ?, 1, 0, 'received', 1, 0, NULL)",
  ).run(A, "f".repeat(64));
  const B = "o1e7mkgm5cm9ngrexup6wpgkzzy9qzp25fwl223epu2llkpa7ftz9sx0fcsx";
  const app = await buildServer(db, new Indexer(db, { pollMs: 1000, log: () => {} }), { trustProxy: false });
  const ok = await app.inject({ method: "POST", url: "/v1/addresses/used", payload: { addresses: [A, B, A] } });
  assert.equal(ok.statusCode, 200);
  assert.deepEqual((ok.json() as { used: string[] }).used, [A]);
  for (const addresses of [[], Array(201).fill(A), ["nope"], "x"]) {
    const bad = await app.inject({ method: "POST", url: "/v1/addresses/used", payload: { addresses } });
    assert.equal(bad.statusCode, 400);
  }
  await app.close();
});
