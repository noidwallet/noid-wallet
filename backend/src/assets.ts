import type { FastifyInstance } from "fastify";

import { rpc as nodeRpc, RpcError, type RpcMethod } from "./rpc.js";

/**
 * Parano1d v2.1 tokens and NFTs.
 *
 * The server only passes on the node's records. The app decodes and checks
 * every record itself (core/src/assets.rs), so nothing here is trusted by the
 * phone: these routes just collect pages and fetch public pictures.
 */

const ADDRESS_RE = /^o1[02-9ac-hj-np-z]{20,100}$/;
const DIGEST_RE = /^[0-9a-f]{64}$/;
/** The node allows 1 to 256 records per page. */
const PAGE = 256;
/** At most this many pages per request (4,096 records); more is reported as incomplete. */
const MAX_PAGES = 16;
const MAX_METADATA_BYTES = 8192;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
/** Pictures kept in memory, shared by all phones (immutable, so never stale). */
const IMAGE_CACHE_BYTES = 64 * 1024 * 1024;
const MARKET_CACHE_MS = 15_000;

interface NodeHolding {
  root: string;
  kind: number;
  opening_hex: string;
  dependency_hex: string | null;
  slot_index: number;
  creation_id: string;
  amount_micronoid: string;
  unlock_height: number;
  reserved?: boolean;
}
interface NodeHoldingsPage {
  owner: string;
  key_index: number | null;
  height: number;
  block_hash: string;
  state_root: string;
  holdings: NodeHolding[];
  next: { owner: string; height: number; block_hash: string; after_root: string | null; from_slot: number } | null;
}
interface NodeMarket {
  height: number;
  block_hash: string;
  state_root: string;
  item: { key: string; primary: NodeHolding; related: NodeHolding[] } | null;
}

export interface AssetDeps {
  rpc?: <T>(method: RpcMethod, params?: unknown[]) => Promise<T>;
  fetch?: typeof fetch;
  /** Public media service (names and pictures), e.g. https://tradedata.parano1d.org/. Unset: off. */
  mediaOrigin?: string;
  now?: () => number;
}

function holding(h: NodeHolding) {
  return {
    root: h.root,
    kind: h.kind,
    openingHex: h.opening_hex,
    dependencyHex: h.dependency_hex ?? null,
    slotIndex: h.slot_index,
    // The node writes these as strings already; keep them exact.
    creationId: String(h.creation_id),
    amountMicronoid: String(h.amount_micronoid),
    unlockHeight: h.unlock_height,
    reserved: h.reserved === true,
  };
}

function fail(status: number, code: string, message: string) {
  return Object.assign(new Error(message), { statusCode: status, code });
}

/** Node from before v2.1: it doesn't know these methods. */
function unsupported(e: unknown): boolean {
  return e instanceof RpcError && (e.rpcCode === -32601 || /method not found/i.test(e.message));
}

/** Read a response body, refusing anything over `max` bytes. */
async function readBounded(res: Response, max: number): Promise<Uint8Array | null> {
  const declared = Number(res.headers.get("content-length") ?? "0");
  if (declared > max) return null;
  if (!res.body) return new Uint8Array(await res.arrayBuffer()).slice(0, max + 1);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

export function validMediaOrigin(origin: string | undefined): string | undefined {
  if (!origin) return undefined;
  const o = origin.trim();
  // https, a host, optional port, and "/" as the path (like the official wallet).
  return /^https:\/\/[a-z0-9.-]+(:\d{1,5})?\/$/i.test(o) ? o : undefined;
}

export function registerAssetRoutes(app: FastifyInstance, deps: AssetDeps = {}) {
  const call = deps.rpc ?? (<T>(m: RpcMethod, p?: unknown[]) => nodeRpc<T>(m, p ?? []));
  const get = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  const origin = validMediaOrigin(deps.mediaOrigin);

  /** Everything an address holds, in one consistent State (restarts if a block lands mid-way). */
  app.get<{ Params: { address: string } }>(
    "/v1/address/:address/assets",
    { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } },
    async (req) => {
      const a = req.params.address.trim();
      if (!ADDRESS_RE.test(a)) throw fail(400, "bad_request", "That is not a valid NOID address.");
      for (let attempt = 0; attempt < 3; attempt++) {
        let cursor: NodeHoldingsPage["next"] = null;
        let first: NodeHoldingsPage | null = null;
        const holdings: ReturnType<typeof holding>[] = [];
        let complete = true;
        let restarted = false;
        try {
          for (let page = 0; page < MAX_PAGES; page++) {
            const p: NodeHoldingsPage = await call<NodeHoldingsPage>("getNativeHoldings", [a, cursor, PAGE]);
            if (!first) first = p;
            else if (p.height !== first.height || p.block_hash !== first.block_hash || p.state_root !== first.state_root) {
              restarted = true;
              break;
            }
            holdings.push(...p.holdings.map(holding));
            cursor = p.next;
            if (!cursor) break;
            if (page === MAX_PAGES - 1) complete = false;
          }
        } catch (e) {
          if (unsupported(e)) throw fail(404, "assets_unsupported", "This wallet server does not support tokens yet.");
          // -32041: State changed between pages. Start again from the first page.
          if (e instanceof RpcError && e.rpcCode === -32041) continue;
          throw e;
        }
        if (restarted || !first) continue;
        return {
          owner: first.owner,
          height: first.height,
          blockHash: first.block_hash,
          stateRoot: first.state_root,
          holdings,
          complete,
        };
      }
      throw fail(503, "busy", "The chain moved while reading. Try again.");
    },
  );

  // A token's definition and market. Shared by every phone holding it, so cached briefly.
  const markets = new Map<string, { at: number; p: Promise<NodeMarket> }>();
  app.get<{ Params: { assetId: string } }>("/v1/asset/:assetId", async (req) => {
    const id = req.params.assetId.toLowerCase();
    if (!DIGEST_RE.test(id)) throw fail(400, "bad_request", "Invalid token ID.");
    let entry = markets.get(id);
    if (!entry || now() - entry.at > MARKET_CACHE_MS) {
      const p = call<NodeMarket>("getNativeMarket", [id]);
      entry = { at: now(), p };
      if (markets.size > 2000) markets.clear();
      markets.set(id, entry);
      p.catch(() => {
        if (markets.get(id)?.p === p) markets.delete(id);
      });
    }
    let m: NodeMarket;
    try {
      m = await entry.p;
    } catch (e) {
      if (unsupported(e)) throw fail(404, "assets_unsupported", "This wallet server does not support tokens yet.");
      throw e;
    }
    return {
      height: m.height,
      blockHash: m.block_hash,
      stateRoot: m.state_root,
      item: m.item ? { key: m.item.key, primary: holding(m.item.primary), related: m.item.related.map(holding) } : null,
    };
  });

  // Public names and pictures. Fetched here so phones never contact another
  // service; the phone checks every file against the hash committed in State.
  const images = new Map<string, Uint8Array>();
  let imageBytes = 0;
  const metadata = new Map<string, string>();

  const media = async (path: string, max: number): Promise<Uint8Array> => {
    if (!origin) throw fail(404, "media_disabled", "This wallet server does not serve token pictures.");
    let res: Response;
    try {
      res = await get(origin + path, { redirect: "error", signal: AbortSignal.timeout(15_000) });
    } catch {
      throw fail(503, "media_unavailable", "Token pictures are not available right now.");
    }
    if (res.status === 404) throw fail(404, "media_missing", "This token has no published picture or details.");
    if (!res.ok) throw fail(503, "media_unavailable", "Token pictures are not available right now.");
    const body = await readBounded(res, max);
    if (!body) throw fail(502, "media_too_large", "The token's file is too large.");
    return body;
  };

  app.get<{ Params: { hash: string } }>(
    "/v1/media/metadata/:hash",
    { config: { rateLimit: { max: 300, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const hash = req.params.hash.toLowerCase();
      if (!DIGEST_RE.test(hash)) throw fail(400, "bad_request", "Invalid metadata ID.");
      let text = metadata.get(hash);
      if (text === undefined) {
        const bytes = await media(`metadata/${hash}.json`, MAX_METADATA_BYTES);
        text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
        if (metadata.size > 5000) metadata.clear();
        metadata.set(hash, text);
      }
      reply.header("cache-control", "public, max-age=31536000, immutable");
      return { hash, text };
    },
  );

  app.get<{ Params: { hash: string } }>(
    "/v1/media/image/:hash",
    { config: { rateLimit: { max: 300, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const hash = req.params.hash.toLowerCase();
      if (!DIGEST_RE.test(hash)) throw fail(400, "bad_request", "Invalid picture ID.");
      let png = images.get(hash);
      if (!png) {
        png = await media(`images/${hash}.png`, MAX_IMAGE_BYTES);
        if (imageBytes + png.byteLength > IMAGE_CACHE_BYTES) {
          images.clear();
          imageBytes = 0;
        }
        images.set(hash, png);
        imageBytes += png.byteLength;
      }
      reply.header("content-type", "image/png");
      reply.header("x-content-type-options", "nosniff");
      reply.header("cache-control", "public, max-age=31536000, immutable");
      return reply.send(Buffer.from(png));
    },
  );

  return { mediaEnabled: !!origin };
}
