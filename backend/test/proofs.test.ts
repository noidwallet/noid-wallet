import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDb } from "../src/db.js";
import { Indexer } from "../src/indexer.js";
import { RpcError, type RpcMethod } from "../src/rpc.js";
import { MAX_PIECES, MAX_REQUEST_INDICES, proofIndices, splitForNode } from "../src/proofs.js";
import { buildServer } from "../src/server.js";

test("proof requests: sorted unique whole numbers, bounded", () => {
  assert.deepEqual(proofIndices([1, 5, 9]), [1, 5, 9]);
  for (const bad of [[], [2, 1], [1, 1], [1.5], [-1], ["3"], null, Array.from({ length: MAX_REQUEST_INDICES + 1 }, (_, i) => i)]) {
    assert.throws(() => proofIndices(bad), JSON.stringify(bad)?.slice(0, 40));
  }
});

test("split: node-sized pieces (128 indices, 8 segments), order kept", () => {
  const many = Array.from({ length: 200 }, (_, i) => i);
  assert.deepEqual(splitForNode(many).map((p) => p.length), [128, 72]);
  const spread = Array.from({ length: 10 }, (_, i) => i * 65_536 + 3); // ten segments
  const pieces = splitForNode(spread);
  assert.deepEqual(pieces.map((p) => p.length), [8, 2]);
  assert.deepEqual(pieces.flat(), spread);
});

async function server(rpc: (method: RpcMethod, params?: unknown[]) => Promise<unknown>) {
  const db = openDb(join(mkdtempSync(join(tmpdir(), "noidproof-")), "t.sqlite"));
  return buildServer(db, new Indexer(db, { pollMs: 1000, log: () => {} }), {
    trustProxy: false,
    proofs: { rpc: rpc as never, probe: false, sleep: async () => {} },
  });
}

test("proofs: off until the node offers getSlotProof, then one proof per node-sized piece", async () => {
  const calls: unknown[][] = [];
  let mode: "missing" | "ok" = "missing";
  let busyOnce = true;
  const app = await server(async (method, params) => {
    assert.equal(method, "getSlotProof");
    if (mode === "missing") throw new RpcError("Method not found", -32601);
    const idx = (params as number[][])[0]!;
    if (busyOnce && idx.length > 1) {
      busyOnce = false;
      throw new RpcError("Merkle proof service is busy; retry the request", -32000);
    }
    calls.push(idx);
    return { height: 1, block_hash: "ab".repeat(32), state_root: "cd".repeat(32), log_slots: 24, slots: idx.map((i) => ({ slot_index: i })), siblings: [] };
  });
  const ask = (indices: unknown) => app.inject({ method: "POST", url: "/v1/slots/proof", payload: { indices } });

  let r = await ask([1, 2]);
  assert.equal(r.statusCode, 503);
  assert.equal(r.json().error.code, "proofs_unavailable");

  mode = "ok";
  // The probe turns it on (here run by hand: the timer is off in tests).
  await (app as unknown as { proofs: { probeNow(): Promise<void> } }).proofs.probeNow();
  calls.length = 0;
  r = await ask(Array.from({ length: 200 }, (_, i) => i));
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().proofs.length, 2);
  assert.deepEqual(calls.map((c) => c.length), [128, 72], "split, and the busy answer was retried");
  assert.equal(r.json().proofs[0].slots.length, 128);
  await app.close();
});

test("proofs: one request makes at most MAX_PIECES node calls and names the slots left", async () => {
  let calls = 0;
  const app = await server(async (_m, params) => {
    calls++;
    return { slots: (params as number[][])[0] };
  });
  await (app as unknown as { proofs: { probeNow(): Promise<void> } }).proofs.probeNow();
  calls = 0;
  const spread = Array.from({ length: 50 }, (_, i) => i * 65_536); // 50 segments: 7 pieces
  const r = await app.inject({ method: "POST", url: "/v1/slots/proof", payload: { indices: spread } });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(calls, MAX_PIECES);
  const body = r.json() as { proofs: { slots: number[] }[]; rest: number[] };
  assert.deepEqual([...body.proofs.flatMap((p) => p.slots), ...body.rest], spread);
  assert.equal(body.proofs.flatMap((p) => p.slots).length, MAX_PIECES * 8);
  await app.close();
});

test("proofs: a node with smaller segments gets halves; an unknown method turns proofs off", async () => {
  let segmentsRefusals = 0;
  let gone = false;
  const app = await server(async (_m, params) => {
    const idx = (params as number[][])[0]!;
    if (gone) throw new RpcError("Method not found", -32601);
    if (idx.length > 2) {
      segmentsRefusals++;
      throw new RpcError("slot proof spans more than 8 segments", -32000);
    }
    return { slots: idx };
  });
  await (app as unknown as { proofs: { probeNow(): Promise<void> } }).proofs.probeNow();
  const r = await app.inject({ method: "POST", url: "/v1/slots/proof", payload: { indices: [1, 2, 3, 4, 5] } });
  assert.equal(r.statusCode, 200, r.body);
  assert.deepEqual(r.json().proofs.map((p: { slots: number[] }) => p.slots), [[1, 2], [3], [4, 5]]);
  assert.ok(segmentsRefusals >= 2);
  gone = true;
  const r2 = await app.inject({ method: "POST", url: "/v1/slots/proof", payload: { indices: [1] } });
  assert.equal(r2.statusCode, 503);
  const s = await app.inject({ method: "POST", url: "/v1/slots/proof", payload: { indices: [1] } });
  assert.equal(s.json().error.code, "proofs_unavailable");
  await app.close();
});
