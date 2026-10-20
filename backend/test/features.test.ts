import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDb } from "../src/db.js";
import { Indexer } from "../src/indexer.js";
import { noidUsdFromPeatio, PriceFeed } from "../src/price.js";
import { Notifier, type PushSender } from "../src/push.js";
import { buildServer, clientKey } from "../src/server.js";

const A = "o1wrznmh6td3mgg9mu0a3kkxxn2lnfu827uykrnpaa90mex8su9zcs5sjxrk";
const TOKEN = "fcm-token_abcdefghijklmnopqrstuvwxyz:0123456789";

test("NOID price from Peatio: direct USDT pair, then via another quote", () => {
  const markets = [
    { id: "noidusdt", base_unit: "noid", quote_unit: "usdt" },
    { id: "btcusdt", base_unit: "btc", quote_unit: "usdt" },
  ];
  assert.equal(noidUsdFromPeatio(markets, { noidusdt: { ticker: { last: "0.0123" } } }), 0.0123);
  const viaBtc = [{ id: "noidbtc", base_unit: "noid", quote_unit: "btc" }];
  assert.equal(noidUsdFromPeatio(viaBtc, { noidbtc: { ticker: { last: "0.0000001" } }, btcusdt: { ticker: { last: "100000" } } }), 0.01);
  assert.equal(noidUsdFromPeatio(markets, {}), null);
  assert.equal(noidUsdFromPeatio("nope", {}), null);
});

test("price feed caches, serves stale while refreshing, rejects one-off jumps", async () => {
  let now = 1_000_000;
  let fail = false;
  let usd = "0.02";
  let calls = 0;
  const feed = new PriceFeed({
    now: () => now,
    bases: ["https://x"],
    fetchJson: async (url) => {
      calls++;
      if (fail) throw new Error("down");
      if (url.endsWith("/markets?limit=1000")) return [{ id: "noidusdt", base_unit: "noid", quote_unit: "usdt" }];
      if (url.endsWith("/markets/tickers")) return { noidusdt: { ticker: { last: usd } } };
      return { result: "success", rates: { NGN: 1500 } };
    },
  });
  const p = await feed.get();
  assert.equal(p?.usd, 0.02);
  assert.equal(p?.ngn, 30);
  const before = calls;
  await feed.get();
  assert.equal(calls, before, "served from cache");

  // A tenfold jump is held back until a second fetch confirms it.
  usd = "0.2";
  now += 3 * 60_000;
  await feed.get();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal((await feed.get())?.usd, 0.02);
  now += 3 * 60_000;
  await feed.get();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal((await feed.get())?.usd, 0.2);

  // Source down: the last price is served at once, for a while.
  fail = true;
  now += 5 * 60_000;
  assert.equal((await feed.get())?.usd, 0.2);
  now += 60 * 60_000;
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(await feed.get(), null, "too old: no price rather than a wrong one");
});

test("notifications: validated tokens, once per tx, no dust, no old blocks, owners never locked out", async () => {
  const db = openDb(join(mkdtempSync(join(tmpdir(), "noidpush-")), "t.sqlite"));
  const sent: string[] = [];
  let gone = false;
  const sender: PushSender = {
    async send(token, _title, body) {
      sent.push(`${token}|${body}`);
      return gone ? "gone" : "ok";
    },
    async validate(token) {
      return token.startsWith("fake") ? "gone" : "ok";
    },
  };
  let clock = 1_000_000;
  const n = new Notifier(db, sender, () => {}, () => clock);
  assert.equal((await n.subscribe(A, "fake_token_abcdefghijklmnopqrstuvwxyz")).ok, false, "made-up tokens refused");
  assert.deepEqual(await n.subscribe(A, TOKEN), { ok: true });
  n.onRows(10, clock, [
    { address: A, txid: "a".repeat(64), direction: "received", amount: 4_900_000 },
    { address: A, txid: "b".repeat(64), direction: "sent", amount: 1_000_000 },
    { address: A, txid: "d".repeat(64), direction: "received", amount: 10 },
  ]);
  await n.drain();
  assert.deepEqual(sent, [`${TOKEN}|Incoming: 4.9 NOID. Confirms in a few minutes.`]);
  n.onRows(10, clock, [{ address: A, txid: "a".repeat(64), direction: "received", amount: 4_900_000 }]);
  n.onRows(11, clock - 3600, [{ address: A, txid: "e".repeat(64), direction: "received", amount: 4_900_000 }]);
  await n.drain();
  assert.equal(sent.length, 1, "no repeat for a re-stored block, none for old blocks");

  // An attacker filling an address with tokens only evicts older ones.
  for (let i = 0; i < 12; i++) {
    clock += 1;
    await n.subscribe(A, `attacker_token_${i}_abcdefghijklmnop`);
  }
  clock += 1;
  await n.subscribe(A, TOKEN);
  const mine = db.prepare("SELECT COUNT(*) AS n FROM push_subs WHERE token = ?").get(TOKEN) as { n: number };
  const count = db.prepare("SELECT COUNT(*) AS n FROM push_subs WHERE address = ?").get(A) as { n: number };
  assert.equal(mine.n, 1);
  assert.equal(count.n, 10);

  gone = true;
  n.onRows(12, clock, [{ address: A, txid: "c".repeat(64), direction: "mined", amount: 16_000_000 }]);
  await n.drain();
  const left = db.prepare("SELECT COUNT(*) AS n FROM push_subs").get() as { n: number };
  assert.equal(left.n, 0, "tokens FCM rejects are deleted");
});

test("rate limit key: IPv4 as is, IPv6 grouped by /64", () => {
  assert.equal(clientKey("203.0.113.9"), "203.0.113.9");
  assert.equal(clientKey("::ffff:203.0.113.9"), "203.0.113.9");
  assert.equal(clientKey("2001:db8:1:2:aaaa::1"), clientKey("2001:db8:1:2:bbbb:cccc:dddd:eeee"));
  assert.notEqual(clientKey("2001:db8:1:2::1"), clientKey("2001:db8:1:3::1"));
});

test("push and price endpoints validate input and report when off", async () => {
  const db = openDb(join(mkdtempSync(join(tmpdir(), "noidsrv2-")), "t.sqlite"));
  const indexer = new Indexer(db, { pollMs: 1000, log: () => {} });
  const off = await buildServer(db, indexer, { trustProxy: false });
  const r1 = await off.inject({ method: "POST", url: "/v1/push/subscribe", payload: { address: A, token: TOKEN } });
  assert.equal(r1.statusCode, 404);
  assert.equal((await off.inject({ url: "/v1/price" })).statusCode, 503);
  await off.close();

  const sender: PushSender = { send: async () => "ok", validate: async () => "ok" };
  const on = await buildServer(db, indexer, { trustProxy: false, notifier: new Notifier(db, sender, () => {}) });
  const bad = await on.inject({ method: "POST", url: "/v1/push/subscribe", payload: { address: A, token: "x" } });
  assert.equal(bad.statusCode, 400);
  const long = await on.inject({ method: "POST", url: "/v1/push/subscribe", payload: { address: A, token: "a".repeat(600) } });
  assert.equal(long.statusCode, 400);
  const badAddr = await on.inject({ method: "POST", url: "/v1/push/subscribe", payload: { address: "nope", token: TOKEN } });
  assert.equal(badAddr.statusCode, 400);
  const ok = await on.inject({ method: "POST", url: "/v1/push/subscribe", payload: { address: A, token: TOKEN } });
  assert.equal(ok.statusCode, 200);
  const un = await on.inject({ method: "POST", url: "/v1/push/unsubscribe", payload: { address: A, token: TOKEN } });
  assert.equal(un.statusCode, 200);
  await on.close();
});
