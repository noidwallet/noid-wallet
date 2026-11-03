import type { FastifyInstance } from "fastify";

import { rpc as nodeRpc, type ChainInfo, type RpcMethod } from "./rpc.js";

/**
 * Raw block headers for the phone's own chain check (NOID 1.1).
 *
 * The phone starts from a checkpoint built into the app and checks every
 * header after it itself (proof of work, difficulty, timestamps, links), so
 * nothing served here is trusted: a wrong or invented header is refused on
 * the phone. This route only pages the node's permanent headers.
 */

/** Headers per page: 300 x 212 bytes is about 127 KB of hex. */
export const PAGE_MAX = 300;
/** Headers at least this deep can't change (the node's finality depth). */
const FINAL_DEPTH = 18;
/** Final headers kept in memory, shared by all phones (about 8 MB of hex). */
const CACHE_MAX = 20_000;
const HEADER_HEX_RE = /^[0-9a-f]{424}$/;

export interface HeaderDeps {
  rpc?: <T>(method: RpcMethod, params?: unknown[]) => Promise<T>;
}

function badRequest(message: string) {
  return Object.assign(new Error(message), { statusCode: 400, code: "bad_request" });
}

export function registerHeaderRoutes(app: FastifyInstance, deps: HeaderDeps = {}) {
  const call = deps.rpc ?? (<T>(m: RpcMethod, p?: unknown[]) => nodeRpc<T>(m, p ?? []));
  const cache = new Map<number, string>();

  const header = async (height: number, tip: number): Promise<string | null> => {
    const hit = cache.get(height);
    if (hit) return hit;
    const hex = await call<string | null>("getHeaderByHeight", [height]);
    if (hex === null) return null;
    const h = String(hex).toLowerCase();
    if (!HEADER_HEX_RE.test(h)) throw new Error(`node returned a malformed header at ${height}`);
    if (height + FINAL_DEPTH <= tip) {
      if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as number);
      cache.set(height, h);
    }
    return h;
  };

  app.get<{ Querystring: { from?: string; count?: string } }>(
    "/v1/headers",
    { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } },
    async (req) => {
      const from = Number(req.query.from);
      if (!Number.isInteger(from) || from < 0 || from > 1e12) throw badRequest("Invalid starting height.");
      const wanted = req.query.count === undefined ? PAGE_MAX : Number(req.query.count);
      if (!Number.isInteger(wanted) || wanted < 1 || wanted > PAGE_MAX) throw badRequest(`count must be 1 to ${PAGE_MAX}.`);
      const chain = await call<ChainInfo>("getChainInfo");
      const tip = chain.height;
      const last = Math.min(from + wanted - 1, tip);
      const headers: string[] = [];
      // A few at a time: each is a local RPC, and a page is at most 300.
      for (let h = from; h <= last; h += 8) {
        const batch = await Promise.all(Array.from({ length: Math.min(8, last - h + 1) }, (_, i) => header(h + i, tip)));
        let stop = false;
        for (const hex of batch) {
          if (hex === null) {
            stop = true;
            break;
          }
          headers.push(hex);
        }
        if (stop) break;
      }
      return { from, tip, headers };
    },
  );
}
