import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDb } from "../src/db.js";
import { Indexer } from "../src/indexer.js";
import { noidUsdFromPaprika, noidUsdFromPeatio, PriceFeed, saneRates } from "../src/price.js";
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
    paprikaUrl: "https://x/paprika",
    fetchJson: async (url) => {
      calls++;
      if (fail) throw new Error("down");
      if (url.endsWith("/markets?limit=1000")) return [{ id: "noidusdt", base_unit: "noid", quote_unit: "usdt" }];
      if (url.endsWith("/markets/tickers")) return { noidusdt: { ticker: { last: usd } } };
      if (url.endsWith("/paprika")) return [];
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

test("paprika fallback: recent NOID/USDT preferred, stale or junk ignored", () => {
  const now = Date.parse("2026-10-20T16:30:00Z");
  const m = (pair: string, price: unknown, at: string, volume = 1000) => ({ pair, last_updated: at, quotes: { USD: { price, volume_24h: volume } } });
  assert.equal(noidUsdFromPaprika([m("NOID/USDT", 0.61, "2026-10-20T16:16:09Z")], now), 0.61);
  assert.equal(
    noidUsdFromPaprika([m("NOID/BTC", 0.7, "2026-10-20T16:20:00Z", 9e9), m("NOID/USDT", 0.61, "2026-10-20T16:16:09Z", 1)], now),
    0.61,
  );
  assert.equal(noidUsdFromPaprika([m("NOID/USDT", 0.61, "2026-10-20T10:00:00Z")], now), null, "too old");
  assert.equal(noidUsdFromPaprika([m("NOID/USDT", "x", "2026-10-20T16:16:09Z")], now), null);
  assert.equal(noidUsdFromPaprika([m("BTC/USDT", 60000, "2026-10-20T16:16:09Z")], now), null);
  assert.equal(noidUsdFromPaprika({ error: "nope" }, now), null);
});

test("price feed falls back to CoinPaprika when SafeTrade blocks the server", async () => {
  const now = Date.parse("2026-10-20T16:30:00Z");
  const feed = new PriceFeed({
    now: () => now,
    bases: ["https://blocked"],
    paprikaUrl: "https://paprika/markets",
    fetchJson: async (url) => {
      if (url.startsWith("https://blocked")) throw new Error("HTTP 403 from blocked");
      if (url === "https://paprika/markets") return [{ pair: "NOID/USDT", last_updated: "2026-10-20T16:16:09Z", quotes: { USD: { price: 0.6, volume_24h: 5 } } }];
      return { result: "success", rates: { NGN: 1300 } };
    },
  });
  const p = await feed.get();
  assert.equal(p?.usd, 0.6);
  assert.equal(p?.ngn, 780);
  assert.equal(p?.source, "SafeTrade via CoinPaprika");
});

test("fx rates: only supported, sane currencies; fetched hourly; old copy used while the feed is down", async () => {
  assert.deepEqual(saneRates({ EUR: 0.9, JPY: 150, NGN: 1500, XYZ: 3, GBP: -1, KES: "129", INR: Infinity }), { EUR: 0.9, JPY: 150, NGN: 1500 });
  assert.deepEqual(saneRates({ NGN: 5 }), {}, "naira outside its sane range");
  assert.deepEqual(saneRates(null), {});

  let now = 1_000_000;
  let fxCalls = 0;
  let fxDown = false;
  const feed = new PriceFeed({
    now: () => now,
    bases: ["https://x"],
    paprikaUrl: "https://x/paprika",
    fetchJson: async (url) => {
      if (url.endsWith("/markets?limit=1000")) return [{ id: "noidusdt", base_unit: "noid", quote_unit: "usdt" }];
      if (url.endsWith("/markets/tickers")) return { noidusdt: { ticker: { last: "0.5" } } };
      if (url.endsWith("/paprika")) return [];
      fxCalls++;
      if (fxDown) throw new Error("fx down");
      return { result: "success", rates: { EUR: 0.9, NGN: 1500 } };
    },
  });
  const p = await feed.get();
  assert.deepEqual(p?.rates, { EUR: 0.9, NGN: 1500 });
  assert.equal(p?.ngn, 750);
  // Price refreshes every few minutes; the FX feed only once an hour.
  for (let i = 0; i < 5; i++) {
    now += 3 * 60_000;
    await feed.get();
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.equal(fxCalls, 1);
  // Feed down after an hour: the older rates are still served (for up to a day).
  fxDown = true;
  now += 60 * 60_000;
  await feed.get();
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual((await feed.get())?.rates, { EUR: 0.9, NGN: 1500 });
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

  // New phones per address are rate limited...
  const burst = [];
  for (let i = 0; i < 4; i++) burst.push((await n.subscribe(A, `burst_token_${i}_abcdefghijklmnopq`)).ok);
  // The owner's phone already used one of this hour's 3 slots.
  assert.deepEqual(burst, [true, true, false, false]);
  // ...and an attacker filling the slots (slowly, from many IPs, renewing
  // them all) can never push the owner's phone out.
  for (let i = 0; i < 30; i++) {
    clock += 1300;
    await n.subscribe(A, `attacker_token_${i}_abcdefghijklmnop`, `10.0.0.${i}`);
    if (i % 5 === 0) assert.deepEqual(await n.subscribe(A, TOKEN), { ok: true }, "owner renews now and then");
  }
  const mine = db.prepare("SELECT COUNT(*) AS n FROM push_subs WHERE token = ?").get(TOKEN) as { n: number };
  const count = db.prepare("SELECT COUNT(*) AS n FROM push_subs WHERE address = ?").get(A) as { n: number };
  assert.equal(mine.n, 1, "the owner's phone is still subscribed");
  assert.equal(count.n, 10);
  const full = await n.subscribe(A, "late_token_abcdefghijklmnopqrstu", "10.9.9.9");
  assert.equal(full.ok, false, "a full address refuses new phones instead of evicting");
  // Phones that stop renewing free their slot after two weeks.
  clock += 15 * 24 * 3600;
  assert.deepEqual(await n.subscribe(A, "late_token_abcdefghijklmnopqrstu", "10.9.9.9"), { ok: true });

  // New phones from one client are limited too.
  const many = [];
  for (let i = 0; i < 12; i++) many.push((await n.subscribe(`${A.slice(0, -1)}${i % 2 ? "q" : "p"}`, `ip_token_${i}_abcdefghijklmnopqrs`, "198.51.100.7")).ok);
  assert.ok(many.filter((ok) => !ok).length > 0, "per-client limit");

  gone = true;
  n.onRows(12, clock, [{ address: A, txid: "c".repeat(64), direction: "mined", amount: 16_000_000 }]);
  await n.drain();
  const left = db.prepare("SELECT COUNT(*) AS n FROM push_subs WHERE address = ?").get(A) as { n: number };
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

  // With a feed: rates for the app, the old naira field for older apps, and the age by the server clock.
  const feed = new PriceFeed({
    bases: ["https://x"],
    paprikaUrl: "https://x/paprika",
    fetchJson: async (url) => {
      if (url.endsWith("/markets?limit=1000")) return [{ id: "noidusdt", base_unit: "noid", quote_unit: "usdt" }];
      if (url.endsWith("/markets/tickers")) return { noidusdt: { ticker: { last: "0.5" } } };
      if (url.endsWith("/paprika")) return [];
      return { result: "success", rates: { EUR: 0.9, NGN: 1500 } };
    },
  });
  const priced = await buildServer(db, indexer, { trustProxy: false, price: feed });
  const pr = await priced.inject({ url: "/v1/price" });
  assert.equal(pr.statusCode, 200);
  const body = pr.json() as { usd: number; ngn: number; rates: Record<string, number>; ageMs: number };
  assert.equal(body.usd, 0.5);
  assert.equal(body.ngn, 750);
  assert.deepEqual(body.rates, { EUR: 0.9, NGN: 1500 });
  assert.ok(body.ageMs >= 0 && body.ageMs < 5_000);
  const fx = await priced.inject({ url: "/v1/fx" });
  assert.equal(fx.statusCode, 200);
  assert.deepEqual((fx.json() as { rates: Record<string, number> }).rates, { EUR: 0.9, NGN: 1500 });
  await priced.close();

  // Every NOID price source blocked (as from a data centre): no price, but the rates still come.
  const blocked = new PriceFeed({
    bases: ["https://x"],
    paprikaUrl: "https://x/paprika",
    log: () => {},
    fetchJson: async (url) => {
      if (url.includes("open.er-api")) return { result: "success", rates: { EUR: 0.9, NGN: 1500 } };
      throw new Error("HTTP 403");
    },
  });
  const half = await buildServer(db, indexer, { trustProxy: false, price: blocked });
  assert.equal((await half.inject({ url: "/v1/price" })).statusCode, 503);
  const fx2 = await half.inject({ url: "/v1/fx" });
  assert.equal(fx2.statusCode, 200);
  const fxBody = fx2.json() as { rates: Record<string, number>; ageMs: number };
  assert.equal(fxBody.rates.NGN, 1500);
  assert.ok(fxBody.ageMs >= 0);
  await half.close();
  const none = await buildServer(db, indexer, { trustProxy: false });
  assert.equal((await none.inject({ url: "/v1/fx" })).statusCode, 503);
  await none.close();

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
