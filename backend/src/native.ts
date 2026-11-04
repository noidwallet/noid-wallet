import type { FastifyInstance } from "fastify";
import { randomBytes } from "node:crypto";

import { rpc as nodeRpc, RpcError, type MempoolStats, type NodeStatus, type RpcMethod } from "./rpc.js";

/**
 * Token and NFT transfers (NOID 1.2).
 *
 * The node's planner (`prepareNativeIntent`, Parano1d v2.1) builds an
 * unsigned transfer for the phone's address from verified State. It reads
 * State and the mempool only: it never touches the node's own wallet, and it
 * signs nothing. The phone decodes the plan itself, checks every input and
 * output against what the user asked for, adds the NOID wallet fee output,
 * re-runs the official checks, proves and sends the result through
 * /v1/submit. Nothing served here is trusted by the phone.
 *
 * Only plain transfers are offered: no trading, listing, minting or burning.
 */

const ADDRESS_RE = /^o1[02-9ac-hj-np-z]{20,100}$/;
const ID_RE = /^[0-9a-f]{64}$/;
const U64_RE = /^\d{1,20}$/;
const U64_MAX = (1n << 64n) - 1n;
/** Planning reads up to 16,384 funding records: few at once, for all clients. */
const MAX_IN_FLIGHT = 2;
const MAX_WAITING = 8;
/** Free output slots handed out for the wallet fee output (the phone uses one). */
const FEE_SLOT_HINTS = 4;

export interface NativeDeps {
  rpc?: <T>(method: RpcMethod, params?: unknown[], timeoutMs?: number) => Promise<T>;
}

type Body = {
  owner?: unknown;
  action?: unknown;
  assetId?: unknown;
  units?: unknown;
  collectionId?: unknown;
  serial?: unknown;
  recipient?: unknown;
};

function badRequest(message: string) {
  return Object.assign(new Error(message), { statusCode: 400, code: "bad_request" });
}

function address(v: unknown, what: string): string {
  if (typeof v !== "string" || !ADDRESS_RE.test(v)) throw badRequest(`${what} is not a valid NOID address.`);
  return v;
}

function id(v: unknown, what: string): string {
  if (typeof v !== "string" || !ID_RE.test(v)) throw badRequest(`${what} must be 64 lowercase hex characters.`);
  return v;
}

function u64(v: unknown, what: string, min: bigint): string {
  if (typeof v !== "string" || !U64_RE.test(v)) throw badRequest(`${what} must be a whole number.`);
  const n = BigInt(v);
  if (n < min || n > U64_MAX) throw badRequest(`${what} is out of range.`);
  return n.toString(); // canonical: no leading zeros
}

/** The planner request, built only from checked fields (the node rejects unknown ones). */
export function nativeRequest(body: Body): { owner: string; request: Record<string, string> } {
  const owner = address(body.owner, "The sender");
  const recipient = address(body.recipient, "The recipient");
  if (recipient === owner) throw badRequest("You can't send to your own address.");
  if (body.action === "transfer_token") {
    return {
      owner,
      request: { action: "transfer_token", asset_id: id(body.assetId, "The token ID"), units: u64(body.units, "The amount", 1n), recipient },
    };
  }
  if (body.action === "transfer_nft") {
    return {
      owner,
      request: { action: "transfer_nft", collection_id: id(body.collectionId, "The collection ID"), serial: u64(body.serial, "The serial", 0n), recipient },
    };
  }
  throw badRequest("Only token and NFT transfers are supported.");
}

export function registerNativeRoutes(app: FastifyInstance, deps: NativeDeps = {}) {
  const call = deps.rpc ?? (<T>(m: RpcMethod, p?: unknown[], t?: number) => nodeRpc<T>(m, p ?? [], t));
  let inFlight = 0;
  const waiting: (() => void)[] = [];

  app.post<{ Body: Body }>(
    "/v1/native/prepare",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } }, bodyLimit: 4096 },
    async (req, reply) => {
      const { owner, request } = nativeRequest(req.body ?? {});
      if (inFlight >= MAX_IN_FLIGHT) {
        if (waiting.length >= MAX_WAITING) {
          reply.code(503);
          return { error: { code: "busy", message: "The wallet server is busy. Try again in a moment." } };
        }
        await new Promise<void>((resolve) => waiting.push(resolve));
      }
      inFlight++;
      try {
        // A node that is behind would plan with spent records and an old anchor.
        const node = await call<NodeStatus>("getNodeStatus");
        if (!node.synced) {
          reply.code(503);
          return { error: { code: "node_unavailable", message: "The wallet server's node is still catching up. Try again in a minute." } };
        }
        let plan: unknown;
        try {
          plan = await call<unknown>("prepareNativeIntent", [owner, request], 60_000);
        } catch (e) {
          if (e instanceof RpcError && e.rpcCode === -32041) {
            reply.code(409);
            return { error: { code: "state_changed", message: "A new block arrived while preparing. Try again." } };
          }
          if (e instanceof RpcError && !e.transport) {
            // The planner's own reason (not enough NOID for the fee, no such
            // token in this wallet...): short, plain text, no secrets.
            reply.code(422);
            return { error: { code: "cannot_prepare", message: e.message.replace(/[^\x20-\x7e]/g, "").slice(0, 200) } };
          }
          throw e;
        }
        const salt = randomBytes(16).toString("hex");
        const [slotHints, mempool] = await Promise.all([
          call<number[]>("getSlotHintsSalted", [FEE_SLOT_HINTS, salt]),
          call<MempoolStats>("getMempoolStats"),
        ]);
        return { plan, slotHints, relayFloor: mempool.fee_floor };
      } finally {
        inFlight--;
        waiting.shift()?.();
      }
    },
  );
}
