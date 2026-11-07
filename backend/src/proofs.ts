import type { FastifyInstance } from "fastify";

import { rpc as nodeRpc, RpcError, type RpcMethod } from "./rpc.js";

/**
 * Coin proofs (Parano1d `getSlotProof`, upstream 757f8d8; not in v2.1.0).
 *
 * The phone asks for proofs of the slots it was told hold its coins and
 * checks each proof against a block header it checked itself
 * (core/src/slot_proof.rs). Nothing served here is trusted by the phone.
 *
 * The node proves at most 128 sorted indices across at most 8 State segments
 * per call, with one proof worker for everyone ("busy" otherwise). So the
 * server runs one call at a time, splits a request into node-sized pieces and
 * returns one proof per piece: each carries its own block, so the phone
 * checks each on its own.
 *
 * Off until the node offers the method: `features.slotProofs` follows a probe
 * that runs at startup and every few minutes.
 */

/** Most slots the phone may ask about in one request. */
export const MAX_REQUEST_INDICES = 256;
/** The node's limits (noid_rpc `SLOT_PROOF_MAX_INDICES` / `_MAX_SEGMENTS`). */
const NODE_MAX_INDICES = 128;
const NODE_MAX_SEGMENTS = 8;
/** Mainnet segments hold 2^16 slots (`LOG_SEGMENT_SIZE`); the node may use smaller ones. */
const LOG_SEGMENT = 16;
/**
 * Node calls per request: each may load 8 cold segments, so a request covers
 * at most this many pieces and says which slots it left for the next one.
 */
export const MAX_PIECES = 4;
/** Node calls queued for all clients; more get "busy" instead of waiting. */
const MAX_QUEUED = 6;
const PROBE_MS = 5 * 60_000;
const BUSY_RETRIES = 3;

export interface ProofDeps {
  rpc?: <T>(method: RpcMethod, params?: unknown[], timeoutMs?: number) => Promise<T>;
  /** For tests: no background probe timer. */
  probe?: boolean;
  sleep?: (ms: number) => Promise<void>;
}

function badRequest(message: string) {
  return Object.assign(new Error(message), { statusCode: 400, code: "bad_request" });
}

/** Sorted, unique slot indices, at most MAX_REQUEST_INDICES. */
export function proofIndices(v: unknown): number[] {
  if (!Array.isArray(v) || v.length === 0 || v.length > MAX_REQUEST_INDICES) {
    throw badRequest(`Ask about 1 to ${MAX_REQUEST_INDICES} slots.`);
  }
  let prev = -1;
  for (const i of v) {
    if (typeof i !== "number" || !Number.isInteger(i) || i < 0 || i > 0xffff_ffff) throw badRequest("Slot indices must be whole numbers.");
    if (i <= prev) throw badRequest("Slot indices must be sorted and unique.");
    prev = i;
  }
  return v as number[];
}

/** Pieces the node accepts: at most 128 indices and 8 segments each, in order. */
export function splitForNode(indices: number[], logSegment = LOG_SEGMENT): number[][] {
  const out: number[][] = [];
  let cur: number[] = [];
  const segs = new Set<number>();
  for (const i of indices) {
    const seg = Math.floor(i / 2 ** logSegment);
    if (cur.length === NODE_MAX_INDICES || (!segs.has(seg) && segs.size === NODE_MAX_SEGMENTS)) {
      out.push(cur);
      cur = [];
      segs.clear();
    }
    cur.push(i);
    segs.add(seg);
  }
  if (cur.length) out.push(cur);
  return out;
}

const isBusy = (e: unknown) => e instanceof RpcError && !e.transport && /busy/i.test(e.message);
const isTooManySegments = (e: unknown) => e instanceof RpcError && !e.transport && /segments/i.test(e.message);
const isUnknownMethod = (e: unknown) => e instanceof RpcError && !e.transport && (e.rpcCode === -32601 || /method not found/i.test(e.message));

export function registerProofRoutes(app: FastifyInstance, deps: ProofDeps = {}) {
  const call = deps.rpc ?? (<T>(m: RpcMethod, p?: unknown[], t?: number) => nodeRpc<T>(m, p ?? [], t));
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let enabled = false;
  // One node call at a time, for all clients (the node has one proof worker).
  let chain: Promise<unknown> = Promise.resolve();
  let queued = 0;
  const serial = <T>(f: () => Promise<T>): Promise<T> => {
    queued++;
    const p = chain.then(f, f).finally(() => queued--);
    chain = p.catch(() => undefined);
    return p;
  };

  async function prove(piece: number[]): Promise<unknown[]> {
    for (let attempt = 0; ; attempt++) {
      try {
        return [await serial(() => call<unknown>("getSlotProof", [piece], 30_000))];
      } catch (e) {
        if (isBusy(e) && attempt < BUSY_RETRIES) {
          await sleep(250 * (attempt + 1));
          continue;
        }
        // The node's segments were smaller than assumed: halve and retry.
        if (isTooManySegments(e) && piece.length > 1) {
          const mid = Math.ceil(piece.length / 2);
          return [...(await prove(piece.slice(0, mid))), ...(await prove(piece.slice(mid)))];
        }
        throw e;
      }
    }
  }

  async function probe() {
    try {
      await serial(() => call<unknown>("getSlotProof", [[0]], 15_000));
      enabled = true;
    } catch (e) {
      // Busy still means the method exists.
      enabled = isBusy(e);
      if (!isUnknownMethod(e) && !isBusy(e)) app.log.warn({ err: (e as Error).message }, "slot proof probe failed");
    }
  }
  if (deps.probe !== false) {
    void probe();
    const t = setInterval(() => void probe(), PROBE_MS);
    t.unref();
    app.addHook("onClose", async () => clearInterval(t));
  }

  app.post<{ Body: { indices?: unknown } }>(
    "/v1/slots/proof",
    // A wallet asks once per refresh; each piece costs the node real work.
    { config: { rateLimit: { max: 12, timeWindow: "1 minute" } }, bodyLimit: 8192 },
    async (req, reply) => {
      const indices = proofIndices(req.body?.indices);
      if (!enabled) {
        reply.code(503);
        return { error: { code: "proofs_unavailable", message: "The wallet server can't prove coins yet." } };
      }
      if (queued >= MAX_QUEUED) {
        reply.code(503);
        return { error: { code: "busy", message: "The wallet server is busy. Try again in a moment.", retryable: true } };
      }
      try {
        const pieces = splitForNode(indices);
        const proofs: unknown[] = [];
        for (const piece of pieces.slice(0, MAX_PIECES)) {
          // The phone gave up: don't keep the node's one proof worker busy for nobody.
          if (req.raw.destroyed) return reply.code(499).send();
          proofs.push(...(await prove(piece)));
        }
        // Slots left for the phone's next request (they come after these, in order).
        return { proofs, rest: pieces.slice(MAX_PIECES).flat() };
      } catch (e) {
        if (isUnknownMethod(e)) enabled = false;
        if (e instanceof RpcError && !e.transport) {
          req.log.info({ reason: e.message.slice(0, 200) }, "slot proof refused");
          reply.code(503);
          return { error: { code: "proofs_unavailable", message: "The wallet server couldn't prove these coins right now." } };
        }
        throw e;
      }
    },
  );

  return {
    enabled: () => enabled,
    /** For tests. */
    probeNow: probe,
  };
}
