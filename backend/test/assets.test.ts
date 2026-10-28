import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { contentHash, mediaDomains, validMediaOrigin } from "../src/assets.js";
import { openDb } from "../src/db.js";
import { Indexer } from "../src/indexer.js";
import { parseNodeJson, RpcError } from "../src/rpc.js";
import { buildServer } from "../src/server.js";

const A = "o1wrznmh6td3mgg9mu0a3kkxxn2lnfu827uykrnpaa90mex8su9zcs5sjxrk";
const H = (c: string) => c.repeat(64);

function rec(slot: number) {
  return {
    root: H("a"),
    kind: 2,
    opening_hex: "4e4f4944",
    dependency_hex: null,
    slot_index: slot,
    creation_id: "4611686018427387905",
    amount_micronoid: "0",
    unlock_height: "0",
    reserved: false,
  };
}

async function server(rpc: (method: string, params: unknown[]) => unknown, fetchImpl?: typeof fetch, mediaOrigin?: string) {
  const db = openDb(join(mkdtempSync(join(tmpdir(), "noidassets-")), "t.sqlite"));
  return buildServer(db, new Indexer(db, { pollMs: 1000, log: () => {} }), {
    trustProxy: false,
    assets: {
      rpc: (async (m: string, p: unknown[] = []) => rpc(m, p)) as never,
      fetch: fetchImpl,
      mediaOrigin,
    },
  });
}

test("assets: collects every page of one State, camelCased for the app", async () => {
  const calls: unknown[][] = [];
  const app = await server((m, p) => {
    assert.equal(m, "getNativeHoldings");
    calls.push(p);
    const cursor = p[1] as { from_slot: number } | null;
    const base = { owner: A, key_index: null, height: 10, block_hash: H("1"), state_root: H("2") };
    if (!cursor) return { ...base, holdings: [rec(1)], next: { owner: A, height: 10, block_hash: H("1"), after_root: null, from_slot: 2 } };
    return { ...base, holdings: [rec(2)], next: null };
  });
  const res = await app.inject({ url: `/v1/address/${A}/assets` });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { holdings: { slotIndex: number; creationId: string; openingHex: string }[]; complete: boolean; stateRoot: string };
  assert.deepEqual(body.holdings.map((h) => h.slotIndex), [1, 2]);
  assert.equal(body.holdings[0]!.creationId, "4611686018427387905");
  assert.equal(body.complete, true);
  assert.equal(body.stateRoot, H("2"));
  assert.equal(calls.length, 2);
  assert.equal(calls[0]![2], 256);
  const bad = await app.inject({ url: "/v1/address/nope/assets" });
  assert.equal(bad.statusCode, 400);
  await app.close();
});

test("assets: restarts when a block lands between pages, never mixing two States", async () => {
  let n = 0;
  const app = await server((_m, p) => {
    n++;
    const cursor = p[1];
    // Call 1: first page at height 10. Call 2: node says State changed (-32041).
    // Call 3: first page at 11. Call 4: second page at 12 (a block landed). Calls 5-6: a clean read at 12.
    if (n === 2) throw new RpcError("native wallet State changed; restart pagination", -32041);
    const height = n === 1 ? 10 : n === 3 ? 11 : 12;
    const base = { owner: A, key_index: null, height, block_hash: H(String(height % 10)), state_root: H("2") };
    const next = { owner: A, height, block_hash: base.block_hash, after_root: null, from_slot: 2 };
    return cursor ? { ...base, holdings: [rec(2)], next: null } : { ...base, holdings: [rec(1)], next };
  });
  const res = await app.inject({ url: `/v1/address/${A}/assets` });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { height: number; holdings: { slotIndex: number }[] };
  assert.equal(body.height, 12);
  assert.deepEqual(body.holdings.map((h) => h.slotIndex), [1, 2]);
  assert.equal(n, 6);
  await app.close();
});

test("assets: a chain that never settles gives a clean busy error", async () => {
  let n = 0;
  const app = await server((_m, p) => {
    n++;
    const base = { owner: A, key_index: null, height: n, block_hash: H("1"), state_root: H("2") };
    return p[1] ? { ...base, holdings: [], next: null } : { ...base, holdings: [rec(1)], next: { owner: A, height: n, block_hash: H("1"), after_root: null, from_slot: 2 } };
  });
  const res = await app.inject({ url: `/v1/address/${A}/assets` });
  assert.equal(res.statusCode, 503);
  assert.equal((res.json() as { error: { code: string } }).error.code, "busy");
  await app.close();
});

test("u64 unlock heights survive node JSON parsing", () => {
  const parsed = parseNodeJson('{"result":{"holdings":[{"unlock_height":18446744073709551615,"creation_id":4611686018427387905}]}}') as {
    result: { holdings: { unlock_height: string; creation_id: string }[] };
  };
  assert.equal(parsed.result.holdings[0]!.unlock_height, "18446744073709551615");
  assert.equal(parsed.result.holdings[0]!.creation_id, "4611686018427387905");
});

test("assets: old node reports unsupported, not a server failure", async () => {
  const app = await server(() => {
    throw new RpcError("Method not found", -32601);
  });
  const res = await app.inject({ url: `/v1/address/${A}/assets` });
  assert.equal(res.statusCode, 404);
  assert.equal((res.json() as { error: { code: string } }).error.code, "assets_unsupported");
  await app.close();
});

test("asset market: validated ID, cached, null item passes through", async () => {
  let calls = 0;
  const app = await server((m, p) => {
    assert.equal(m, "getNativeMarket");
    assert.deepEqual(p, [H("c")]);
    calls++;
    return { height: 5, block_hash: H("1"), state_root: H("2"), item: null };
  });
  for (let i = 0; i < 3; i++) {
    const res = await app.inject({ url: `/v1/asset/${H("C")}` });
    assert.equal(res.statusCode, 200);
    assert.equal((res.json() as { item: unknown }).item, null);
  }
  assert.equal(calls, 1);
  assert.equal((await app.inject({ url: "/v1/asset/xyz" })).statusCode, 400);
  await app.close();
});

test("media: proxied with size limits, checked before caching, off without an origin", async () => {
  const seen: { url: string; redirect?: string }[] = [];
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  const pngHash = contentHash(mediaDomains.image, png);
  const metaText = '{"schema":1}\n';
  const metaHash = contentHash(mediaDomains.metadata, new TextEncoder().encode(metaText));
  let badMeta = 0;
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    seen.push({ url, redirect: init?.redirect });
    if (url.includes(H("0"))) return new Response("nope", { status: 404 });
    if (url.includes(H("9"))) return new Response("x".repeat(9000), { status: 200 });
    if (url.includes(H("e"))) return new Response(png, { status: 200 }); // wrong picture for this hash
    if (url.endsWith(".png")) return new Response(png, { status: 200 });
    if (url.includes(H("b"))) {
      badMeta++;
      return new Response("tampered", { status: 200 });
    }
    return new Response(metaText, { status: 200 });
  }) as unknown as typeof fetch;
  const app = await server(() => null, fetchImpl, "https://media.example/");
  const meta = await app.inject({ url: `/v1/media/metadata/${metaHash}` });
  assert.equal(meta.statusCode, 200);
  assert.equal((meta.json() as { text: string }).text, metaText);
  assert.equal(seen[0]!.url, `https://media.example/metadata/${metaHash}.json`);
  assert.equal(seen[0]!.redirect, "error");
  // Metadata that doesn't match its hash is passed on (the phone rejects it) but never cached.
  await app.inject({ url: `/v1/media/metadata/${H("b")}` });
  await app.inject({ url: `/v1/media/metadata/${H("b")}` });
  assert.equal(badMeta, 2);
  const img = await app.inject({ url: `/v1/media/image/${pngHash}` });
  assert.equal(img.statusCode, 200);
  assert.equal(img.headers["content-type"], "image/png");
  assert.deepEqual(new Uint8Array(img.rawPayload), png);
  // Cached: a second request does not fetch again.
  await app.inject({ url: `/v1/media/image/${pngHash}` });
  assert.equal(seen.filter((x) => x.url.endsWith(".png")).length, 1);
  // A picture that isn't the one asked for is refused.
  assert.equal((await app.inject({ url: `/v1/media/image/${H("e")}` })).statusCode, 502);
  assert.equal((await app.inject({ url: `/v1/media/metadata/${H("0")}` })).statusCode, 404);
  assert.equal((await app.inject({ url: `/v1/media/metadata/${H("9")}` })).statusCode, 502);
  assert.equal((await app.inject({ url: "/v1/media/image/../../etc" })).statusCode, 404);
  assert.equal((await app.inject({ url: "/v1/media/image/zz" })).statusCode, 400);
  await app.close();

  const off = await server(() => null, fetchImpl, undefined);
  assert.equal((await off.inject({ url: `/v1/media/image/${pngHash}` })).statusCode, 404);
  await off.close();
});

test("media origin must be a plain https origin", () => {
  assert.equal(validMediaOrigin("https://tradedata.parano1d.org/"), "https://tradedata.parano1d.org/");
  assert.equal(validMediaOrigin("http://tradedata.parano1d.org/"), undefined);
  assert.equal(validMediaOrigin("https://user@host/"), undefined);
  assert.equal(validMediaOrigin("https://host/path/"), undefined);
  assert.equal(validMediaOrigin(undefined), undefined);
});
