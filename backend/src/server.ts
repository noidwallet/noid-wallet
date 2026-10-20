import Fastify, { LogController, type FastifyInstance } from "fastify";
import rateLimit from "@fastify/rate-limit";
import { randomBytes } from "node:crypto";

import type { Db } from "./db.js";
import type { Indexer } from "./indexer.js";
import type { PriceFeed } from "./price.js";
import { PUSH_TOKEN_RE, type Notifier } from "./push.js";
import {
  rpc,
  RpcError,
  type ChainInfo,
  type MempoolStats,
  type NodeStatus,
  type SlotInfo,
  type TxInfo,
} from "./rpc.js";

const ADDRESS_RE = /^o1[02-9ac-hj-np-z]{20,100}$/;
const TXID_RE = /^[0-9a-f]{64}$/;
/** submitTxIntent decodes at most 303,495 bytes; hex doubles that. */
const MAX_INTENT_HEX = 303_495 * 2;

function badRequest(message: string) {
  return Object.assign(new Error(message), { statusCode: 400, code: "bad_request" });
}

export type SubmitOutcome =
  | { kind: "accepted" }
  | { kind: "rejected"; code: string; message: string; retryable: boolean };

/**
 * Map the node's mempool rejection to a stable code. Matches the exact error
 * variants from noid_mempool/src/error.rs and noid_chain ConsensusError, not
 * loose keywords, so permanent failures are never retried.
 */
export function classifySubmitError(message: string): SubmitOutcome {
  const m = message.trim();
  if (m.startsWith("already admitted")) return { kind: "accepted" };
  if (m.includes("BelowMinFee"))
    return { kind: "rejected", code: "fee_too_low", retryable: true, message: "The network fee rose while you were sending." };
  if (m.includes("BadEpochAnchor"))
    return { kind: "rejected", code: "stale_anchor", retryable: true, message: "A new block arrived while the proof was forging." };
  if (m.includes("SlotConflict"))
    return {
      kind: "rejected",
      code: "stale_inputs",
      retryable: true,
      message: "Some of your coins are already being spent by another pending transaction.",
    };
  if (m.includes("BadStateRoot"))
    return {
      kind: "rejected",
      code: "inputs_spent",
      retryable: false,
      message: "These coins are already spent. Refresh your wallet and try again.",
    };
  if (m.startsWith("mempool full") || m.startsWith("mempool byte cap"))
    return { kind: "rejected", code: "busy", retryable: false, message: "The network is busy. Try again in a minute." };
  return { kind: "rejected", code: "rejected", retryable: false, message: "The network rejected the transaction." };
}

/** Pending in the mempool or already in a block? */
async function txKnown(txid: string): Promise<boolean> {
  if (await rpc<unknown | null>("getMempoolEntry", [txid])) return true;
  return (await rpc<TxInfo | null>("getTx", [txid])) !== null;
}

/** Rate-limit key: IPv4 as is, IPv6 by its /64 network (one customer's block). */
export function clientKey(ip: string): string {
  const v4 = /^(?:::ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (v4) return v4[1]!;
  if (!ip.includes(":")) return ip;
  const [head = "", tail = ""] = ip.split("::");
  const h = head ? head.split(":") : [];
  const t = tail ? tail.split(":") : [];
  const full = [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t];
  return full.slice(0, 4).map((x) => x.toLowerCase().replace(/^0+(?=.)/, "")).join(":") + "::/64";
}

function intParam(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined || raw === "") return fallback;
  if (!/^\d+$/.test(raw)) throw badRequest("Invalid number in query.");
  return Math.min(Math.max(Number(raw), min), max);
}

export async function buildServer(
  db: Db,
  indexer: Indexer,
  opts: { trustProxy: boolean; price?: PriceFeed | null; notifier?: Notifier | null },
): Promise<FastifyInstance> {
  // Only trust X-Forwarded-For from the local reverse proxy (Caddy).
  const app = Fastify({
    // No per-request logs: they would tie client IPs to the addresses they look up.
    logger: { level: "warn" },
    logController: new LogController({ disableRequestLogging: true }),
    trustProxy: opts.trustProxy ? "127.0.0.1" : false,
    bodyLimit: MAX_INTENT_HEX + 4096,
  });
  // Many phones share one public IP on mobile networks (CGNAT), so limits are
  // generous and also keyed on the app's random install id.
  await app.register(rateLimit, {
    max: 900,
    timeWindow: "1 minute",
    // Keyed on the client IP only (IPv6 grouped by /64). The app's install id
    // is client-chosen, so it must never widen a limit.
    keyGenerator: (req) => clientKey(req.ip),
  });

  app.setErrorHandler((err, req, reply) => {
    const e = err as Error & { statusCode?: number; code?: string };
    if (e instanceof RpcError) {
      req.log.warn({ err: e.message }, "node rpc error");
      reply.code(502).send({ error: { code: "node_error", message: "The wallet server's node returned an error." } });
      return;
    }
    if (e.name === "TimeoutError" || (e as { cause?: { code?: string } }).cause?.code === "ECONNREFUSED") {
      reply.code(503).send({ error: { code: "node_unavailable", message: "The wallet server cannot reach its node right now." } });
      return;
    }
    const status = e.statusCode ?? 500;
    if (status >= 500) req.log.error(e);
    reply.code(status).send({ error: { code: e.code ?? "error", message: status >= 500 ? "Server error." : e.message } });
  });

  const address = (raw: string) => {
    const a = raw.trim();
    if (!ADDRESS_RE.test(a)) throw badRequest("That is not a valid NOID address.");
    return a;
  };

  app.get("/healthz", async () => ({ ok: true }));

  app.get("/v1/status", async () => {
    const [chain, node, mempool] = await Promise.all([
      rpc<ChainInfo>("getChainInfo"),
      rpc<NodeStatus>("getNodeStatus"),
      rpc<MempoolStats>("getMempoolStats"),
    ]);
    return {
      height: chain.height,
      synced: node.synced,
      syncStage: node.sync_stage,
      peers: node.p2p_connected_peers ?? null,
      activeSlotCount: chain.active_slot_count,
      logSlots: chain.log_slots,
      relayFloor: mempool.fee_floor,
      mempool: { size: mempool.size, capacity: mempool.capacity },
      indexer: { indexedHeight: indexer.indexedHeight, healthy: indexer.lastError === null },
      features: { price: !!opts.price, push: !!opts.notifier },
    };
  });

  /** NOID price for display (USD from SafeTrade, NGN via a public FX rate). */
  app.get("/v1/price", async (_req, reply) => {
    const p = opts.price ? await opts.price.get() : null;
    if (!p) {
      reply.code(503);
      return { error: { code: "price_unavailable", message: "The NOID price is not available right now." } };
    }
    // Age by the server's own clock, so a phone with a wrong clock still knows how fresh it is.
    return { ...p, ageMs: Math.max(0, Date.now() - p.updatedAt) };
  });

  /**
   * Exchange rates only (units per 1 USD). Price sources often refuse requests
   * from data centres; the app then gets the NOID price itself and the rates here.
   */
  app.get("/v1/fx", async (_req, reply) => {
    const fx = opts.price ? await opts.price.fxRates() : null;
    if (!fx) {
      reply.code(503);
      return { error: { code: "fx_unavailable", message: "Exchange rates are not available right now." } };
    }
    return { ...fx, ageMs: Math.max(0, Date.now() - fx.updatedAt) };
  });

  const pushBody = (body: { address?: string; token?: string } | undefined) => {
    if (!opts.notifier) throw Object.assign(new Error("Notifications are not set up on this server."), { statusCode: 404, code: "push_disabled" });
    const token = String(body?.token ?? "");
    if (!PUSH_TOKEN_RE.test(token)) throw badRequest("Invalid notification token.");
    return { notifier: opts.notifier, a: address(String(body?.address ?? "")), token };
  };

  app.post<{ Body: { address?: string; token?: string } }>(
    "/v1/push/subscribe",
    { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const { notifier, a, token } = pushBody(req.body);
      const r = await notifier.subscribe(a, token);
      if (!r.ok) {
        reply.code(r.status);
        return { error: { code: "push_refused", message: r.message } };
      }
      return { ok: true };
    },
  );

  app.post<{ Body: { address?: string; token?: string } }>(
    "/v1/push/unsubscribe",
    { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (req) => {
      const { notifier, a, token } = pushBody(req.body);
      notifier.unsubscribe(a, token);
      return { ok: true };
    },
  );

  /** Live coins of one address, straight from the node's verified State. */
  app.get<{ Params: { address: string } }>("/v1/address/:address/utxos", async (req) => {
    const a = address(req.params.address);
    const slots = await rpc<SlotInfo[]>("getSlotsByOwner", [a]);
    const utxos = slots
      .filter((s) => !s.empty)
      // creationId stays a decimal string: mined coins exceed 2^53.
      .map((s) => ({ slotIndex: s.slot_index, value: s.value, creationId: String(s.creation_id) }));
    return { address: a, balance: utxos.reduce((sum, u) => sum + u.value, 0), utxos };
  });

  /** Everything the phone needs to build and prove one transaction. */
  app.post<{ Body: { outputs?: number } }>(
    "/v1/prepare",
    { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } },
    async (req) => {
      const outputs = Math.min(Math.max(Number(req.body?.outputs ?? 2) || 2, 1), 2);
      const salt = randomBytes(16).toString("hex");
      const [anchor, hints, chain, mempool] = await Promise.all([
        rpc<string>("getEpochAnchor"),
        rpc<number[]>("getSlotHintsSalted", [outputs + 2, salt]),
        rpc<ChainInfo>("getChainInfo"),
        rpc<MempoolStats>("getMempoolStats"),
      ]);
      return {
        epochAnchorHex: anchor,
        slotHints: hints,
        height: chain.height,
        activeSlotCount: chain.active_slot_count,
        logSlots: chain.log_slots,
        relayFloor: mempool.fee_floor,
      };
    },
  );

  /**
   * Relay a finished intent. Idempotent: resubmitting the same intent (same
   * txid) after a lost response returns success, never a second payment.
   */
  app.post<{ Body: { intentHex?: string; txid?: string } }>(
    "/v1/submit",
    { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const hex = String(req.body?.intentHex ?? "").trim().toLowerCase();
      const txid = String(req.body?.txid ?? "").trim().toLowerCase();
      if (!/^[0-9a-f]+$/.test(hex) || hex.length % 2 !== 0 || !hex.startsWith("a3") || hex.length > MAX_INTENT_HEX) {
        throw badRequest("Invalid transaction encoding.");
      }
      if (!TXID_RE.test(txid)) throw badRequest("Invalid transaction ID.");
      try {
        const accepted = await rpc<string>("submitTxIntent", [hex], 90_000);
        if (accepted !== txid) req.log.warn({ accepted, txid }, "node txid differs from client txid");
        return { txid: accepted };
      } catch (e) {
        // Only a JSON-RPC error body is a real answer about this transaction.
        // An HTTP-level failure (overload, restart) may come after the node
        // accepted it, so it is handled like a timeout below.
        if (e instanceof RpcError && !e.transport) {
          const outcome = classifySubmitError(e.message);
          if (outcome.kind === "accepted") return { txid, already: true };
          // A spent-input rejection can also mean our own earlier submit already confirmed.
          if (outcome.code === "inputs_spent" && (await txKnown(txid).catch(() => false))) return { txid, already: true };
          req.log.warn({ reason: e.message.slice(0, 300) }, "submit rejected");
          reply.code(422);
          return { error: { code: outcome.code, message: outcome.message, retryable: outcome.retryable } };
        }
        // Timeout or node unreachable: the node may still have admitted it.
        if (await txKnown(txid).catch(() => false)) return { txid, already: true };
        reply.code(503);
        return { error: { code: "unknown_status", message: "The network did not answer in time. Your wallet is checking whether it went through." } };
      }
    },
  );

  app.get<{ Params: { txid: string } }>("/v1/tx/:txid", async (req) => {
    const txid = req.params.txid.toLowerCase();
    if (!TXID_RE.test(txid)) throw badRequest("Invalid transaction ID.");
    const pending = await rpc<unknown | null>("getMempoolEntry", [txid]);
    if (pending) return { txid, status: "pending" };
    const [info, chain] = await Promise.all([rpc<TxInfo | null>("getTx", [txid]), rpc<ChainInfo>("getChainInfo")]);
    if (info) return { txid, status: "confirmed", height: info.height, confirmations: chain.height - info.height + 1 };
    const row = db.prepare("SELECT height FROM txs WHERE txid = ?").get(txid) as { height: number } | undefined;
    if (row) return { txid, status: "confirmed", height: row.height, confirmations: chain.height - row.height + 1 };
    return { txid, status: "unknown" };
  });

  /** History, newest first. Cursor `before` is "<height>:<txid>" from the previous page. */
  app.get<{ Params: { address: string }; Querystring: { before?: string; limit?: string } }>(
    "/v1/address/:address/history",
    async (req) => {
      const a = address(req.params.address);
      const limit = intParam(req.query.limit, 30, 1, 100);
      let rows: { height: number; txid: string }[];
      const select = "SELECT txid, height, time, direction, amount, fee, counterparty FROM address_txs";
      if (req.query.before) {
        const m = /^(\d+):([0-9a-f]{64})$/.exec(req.query.before);
        if (!m) throw badRequest("Invalid history cursor.");
        const h = Number(m[1]);
        rows = db
          .prepare(
            `${select} WHERE address = ? AND (height < ? OR (height = ? AND txid > ?))
             ORDER BY height DESC, txid ASC LIMIT ?`,
          )
          .all(a, h, h, m[2], limit) as typeof rows;
      } else {
        rows = db.prepare(`${select} WHERE address = ? ORDER BY height DESC, txid ASC LIMIT ?`).all(a, limit) as typeof rows;
      }
      const last = rows[rows.length - 1];
      const oldest = db.prepare("SELECT MIN(height) AS h FROM blocks").get() as { h: number | null };
      return {
        address: a,
        items: rows,
        nextBefore: rows.length === limit && last ? `${last.height}:${last.txid}` : null,
        indexedFrom: oldest.h,
      };
    },
  );

  return app;
}
