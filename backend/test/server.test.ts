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
  // Parano1d v2.1: activation during checking is retried; an old-format proof tells the user to update.
  const race = classifySubmitError("invalid auth authorization: authorization profile changed during verification");
  assert.ok(race.kind === "rejected" && race.retryable && race.code === "stale_anchor");
  const old = classifySubmitError("invalid auth authorization: proof verification failed");
  assert.ok(old.kind === "rejected" && !old.retryable && old.code === "rejected" && /update from noidusa\.com/.test(old.message));
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

test("history: received token rows only for apps that ask (older apps refuse unknown kinds)", async () => {
  const db = openDb(join(mkdtempSync(join(tmpdir(), "noidsrv-")), "t.sqlite"));
  db.prepare(
    "INSERT INTO address_txs (address, txid, height, time, direction, amount, fee, counterparty) VALUES (?, ?, 10, 0, 'received', 1, 0, NULL)",
  ).run(A, "a".repeat(64));
  db.prepare(
    "INSERT INTO address_txs (address, txid, height, time, direction, amount, fee, counterparty, item_id, item_units, item_count) VALUES (?, ?, 11, 0, 'token_in', 0, 0, NULL, ?, '30', 1)",
  ).run(A, "b".repeat(64), "ab".repeat(32));
  const app = await buildServer(db, new Indexer(db, { pollMs: 1000, log: () => {} }), { trustProxy: false });
  const old = (await app.inject({ url: `/v1/address/${A}/history` })).json() as { items: Record<string, unknown>[] };
  assert.deepEqual(old.items.map((i) => i.direction), ["received"]);
  assert.equal("itemId" in old.items[0]!, false, "older apps get exactly the old fields");
  const now = (await app.inject({ url: `/v1/address/${A}/history?native=1` })).json() as { items: Record<string, unknown>[] };
  assert.deepEqual(now.items.map((i) => i.direction), ["token_in", "received"]);
  assert.deepEqual([now.items[0]!.itemId, now.items[0]!.itemUnits, now.items[0]!.itemCount], ["ab".repeat(32), "30", 1]);
  // Paging with the cursor keeps the same filter.
  const next = (await app.inject({ url: `/v1/address/${A}/history?native=0&before=11:${"b".repeat(64)}` })).json() as { items: { direction: string }[] };
  assert.deepEqual(next.items.map((i) => i.direction), ["received"]);
  await app.close();
});
