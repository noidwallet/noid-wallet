import { config } from "./config.js";

/**
 * The ONLY node methods this service may call.
 *
 * The node grants full owner rights (including walletSend) to any loopback
 * connection, so this list is the security boundary. Never add wallet*,
 * stop, mining, or contract methods here, and never forward a client-chosen
 * method name.
 */
const ALLOWED = new Set([
  "getChainInfo",
  "getNodeStatus",
  "getMempoolStats",
  "getSlotsByOwner",
  "getSlotHintsSalted",
  "getEpochAnchor",
  "getBlockHash",
  "getBlockDetails",
  "getTx",
  "getMempoolEntry",
  "validateAddress",
  "submitTxIntent",
  // Parano1d v2.1 tokens and NFTs: read-only public State queries.
  "getNativeHoldings",
  "getNativeMarket",
] as const);

export type RpcMethod = typeof ALLOWED extends Set<infer T> ? T : never;

/**
 * `creation_id` is a full u64 (mined coins use 1 << 63 | height), which a
 * JavaScript number cannot hold. Quote it before JSON.parse so it stays exact.
 */
export function parseNodeJson(text: string): unknown {
  // unlock_height (Parano1d v2.1 token records) is a u64 too: a sender can set it to any value.
  return JSON.parse(text.replace(/"(creation_id|unlock_height)"\s*:\s*(\d+)/g, '"$1":"$2"'));
}

export class RpcError extends Error {
  /**
   * @param transport true when the node answered with an HTTP error instead of
   *   a JSON-RPC error: it may have acted on the request anyway.
   */
  constructor(message: string, readonly rpcCode?: number, readonly transport = false) {
    super(message);
  }
}

let nextId = 1;

export async function rpc<T>(method: RpcMethod, params: unknown[] = [], timeoutMs = 30_000): Promise<T> {
  if (!ALLOWED.has(method)) throw new Error(`blocked RPC method ${method}`);
  const res = await fetch(config.rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method: `paranoid_${method}`, params }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new RpcError(`node HTTP ${res.status}`, undefined, true);
  const body = parseNodeJson(await res.text()) as { result?: T; error?: { code: number; message: string } };
  if (body.error) throw new RpcError(body.error.message, body.error.code);
  return body.result as T;
}

// ---- Node response shapes used here (subset of docs.parano1d.org/reference/rpc) ----

export interface ChainInfo {
  height: number;
  best_hash: string;
  active_slot_count: number;
  log_slots: number;
  circulating_supply_micronoid: string;
}
export interface NodeStatus {
  synced: boolean;
  sync_stage: string;
  p2p_connected_peers?: number;
}
export interface MempoolStats {
  size: number;
  capacity: number;
  fee_floor: number;
}
export interface SlotInfo {
  slot_index: number;
  value: number;
  /** Decimal string: see parseNodeJson. */
  creation_id: string;
  owner: string;
  empty: boolean;
}
export interface TxInfo {
  tx_hash: string;
  height: number;
  block_hash: string;
  tx_position: number;
}
export interface BlockOutput {
  slot_index: number;
  amount_micronoid: number;
  owner: string;
  /** Parano1d v2.1: a token, NFT or market slot. Its owner is a commitment, not an address. */
  native?: boolean;
}
export interface BlockTx {
  position: number;
  txid: string;
  fee_micronoid: number;
  coinbase: boolean;
  development_payout: boolean;
  contract: "call" | "close" | null;
  /** Parano1d v2.1 native finance (tokens, curve, DEX, NFTs); absent on older nodes. */
  native?: unknown;
  trades?: unknown[];
  input_owner: string | null;
  input_sum_micronoid: string;
  output_sum_micronoid: string;
  outputs: BlockOutput[];
}
export interface BlockDetails {
  header: { height: number; hash: string; timestamp: number };
  retained: { transactions: BlockTx[] } | null;
}
