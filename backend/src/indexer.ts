import type { Db } from "./db.js";
import { rpc, type BlockDetails, type BlockTx, type ChainInfo } from "./rpc.js";

/** Node keeps 42 recent bodies; reorgs are at most 17 blocks deep. */
const REORG_DEPTH = 18;
const RETAINED_BODIES = 42;

export interface AddressRow {
  address: string;
  direction: "sent" | "received" | "self" | "mined" | "contract";
  amount: number;
  fee: number;
  /** NOID wallet fee paid by the sender in this transaction (μNOID). */
  walletFee: number;
  counterparty: string | null;
}

/**
 * Turn one block transaction into per-address history rows. Pure; unit-tested.
 * An output to a wallet fee address next to another recipient is the sender's
 * NOID wallet fee, not a second payment.
 */
/** Parano1d v2.1 native finance (token, curve, DEX, NFT). The node leaves `contract` empty for these. */
export function isNativeFinance(tx: BlockTx): boolean {
  return tx.native != null || (tx.trades?.length ?? 0) > 0 || tx.outputs.some((o) => o.native);
}

export function classify(tx: BlockTx, feeAddresses: ReadonlySet<string> = new Set()): AddressRow[] {
  const received = new Map<string, number>();
  // Native (v2.1) token/NFT/market slots are owned by a commitment, not an
  // address: they are nobody's plain NOID and are left out of history.
  for (const o of tx.outputs) {
    if (o.native) continue;
    received.set(o.owner, (received.get(o.owner) ?? 0) + o.amount_micronoid);
  }
  const nativeFinance = isNativeFinance(tx);

  if (tx.coinbase || tx.development_payout || !tx.input_owner) {
    return [...received].map(([address, amount]) => ({ address, direction: "mined", amount, fee: 0, walletFee: 0, counterparty: null }));
  }

  const sender = tx.input_owner;
  const others = [...received].filter(([a]) => a !== sender);
  const rows: AddressRow[] = [];
  const native = tx.native as
    | { operation?: unknown; token_outputs?: { owner?: unknown }[]; nft_outputs?: { owner?: unknown }[] }
    | null
    | undefined;
  if (nativeFinance && (native?.operation === "transfer_token" || native?.operation === "transfer_nft")) {
    // A token or NFT transfer (NOID 1.2 sends one with a wallet fee output):
    // the sender's row shows the NOID that left (network fee plus any plain
    // outputs to others), not its own change.
    let spent = 0;
    try {
      spent = Number(BigInt(tx.input_sum_micronoid) - BigInt(received.get(sender) ?? 0));
    } catch {
      spent = tx.fee_micronoid;
    }
    const walletFee = others.filter(([a]) => feeAddresses.has(a.toLowerCase())).reduce((s, [, v]) => s + v, 0);
    const owners = [...(native.token_outputs ?? []), ...(native.nft_outputs ?? [])]
      .map((o) => o.owner)
      .filter((o): o is string => typeof o === "string" && o !== sender);
    const to = [...new Set(owners)];
    rows.push({ address: sender, direction: "contract", amount: spent, fee: tx.fee_micronoid, walletFee, counterparty: to.length === 1 ? to[0]! : null });
    for (const [address, amount] of others) rows.push({ address, direction: "contract", amount, fee: 0, walletFee: 0, counterparty: sender });
    // No row for the token recipient: no NOID reached them, and apps show a
    // contract row as outgoing. Their tokens show in their token list.
    return rows;
  }
  if (tx.contract || nativeFinance) {
    // Contract call or close, or v2.1 native finance (token, curve, DEX, NFT):
    // value moves under contract rules, not a plain payment.
    const total = [...received].reduce((s, [, v]) => s + v, 0);
    rows.push({ address: sender, direction: "contract", amount: total, fee: tx.fee_micronoid, walletFee: 0, counterparty: null });
    for (const [address, amount] of others) rows.push({ address, direction: "contract", amount, fee: 0, walletFee: 0, counterparty: sender });
    return rows;
  }
  if (others.length === 0) {
    // Consolidation or a payment to yourself: only the fee leaves the address.
    rows.push({ address: sender, direction: "self", amount: 0, fee: tx.fee_micronoid, walletFee: 0, counterparty: sender });
  } else {
    const feeOutputs = others.filter(([a]) => feeAddresses.has(a.toLowerCase()));
    const recipients = feeOutputs.length > 0 && feeOutputs.length < others.length ? others.filter(([a]) => !feeAddresses.has(a.toLowerCase())) : others;
    const walletFee = recipients === others ? 0 : feeOutputs.reduce((s, [, v]) => s + v, 0);
    rows.push({
      address: sender,
      direction: "sent",
      amount: recipients.reduce((s, [, v]) => s + v, 0),
      fee: tx.fee_micronoid,
      walletFee,
      counterparty: recipients.length === 1 ? recipients[0]![0] : null,
    });
    for (const [address, amount] of others) {
      rows.push({ address, direction: "received", amount, fee: 0, walletFee: 0, counterparty: sender });
    }
  }
  return rows;
}

const ADDRESS_RE = /^o1[02-9ac-hj-np-z]{20,100}$/;

export interface Arrival {
  address: string;
  kind: "token" | "nft";
  /** Token ID, or the (first) NFT's collection ID. */
  itemId: string;
  /** Token units received, or the (first) NFT's serial; null when not exact. */
  units: string | null;
  /** How many NFTs (1 for tokens). */
  count: number;
}

const HEX64 = /^[0-9a-f]{64}$/;

/**
 * Who receives a token or NFT in a plain transfer (not the sender's own
 * change), and what. Pure; unit-tested.
 */
export function nativeArrivals(tx: BlockTx): Arrival[] {
  const native = tx.native as
    | {
        operation?: unknown;
        token_outputs?: { owner?: unknown; units?: unknown; asset_id?: unknown }[];
        nft_outputs?: { owner?: unknown; collection_id?: unknown; serial?: unknown }[];
      }
    | null
    | undefined;
  if (!native || (native.operation !== "transfer_token" && native.operation !== "transfer_nft")) return [];
  // Without a known sender its own change can't be told apart: nobody.
  const sender = tx.input_owner;
  if (!sender) return [];
  const found = new Map<string, Arrival>();
  const recipient = (owner: unknown): owner is string => typeof owner === "string" && owner !== sender && ADDRESS_RE.test(owner);
  if (native.operation === "transfer_token") {
    for (const o of native.token_outputs ?? []) {
      if (!recipient(o.owner) || typeof o.asset_id !== "string" || !HEX64.test(o.asset_id)) continue;
      if (typeof o.units !== "string" || !/^[1-9]\d{0,19}$/.test(o.units)) continue;
      const had = found.get(o.owner);
      if (!had) found.set(o.owner, { address: o.owner, kind: "token", itemId: o.asset_id, units: o.units, count: 1 });
      // The same token again: add it up (another token in one transfer: keep the first).
      else if (had.itemId === o.asset_id && had.units !== null) had.units = (BigInt(had.units) + BigInt(o.units)).toString();
    }
  } else {
    for (const o of native.nft_outputs ?? []) {
      if (!recipient(o.owner) || typeof o.collection_id !== "string" || !HEX64.test(o.collection_id)) continue;
      // Big 64-bit numbers arrive as strings (parseNodeJson keeps them exact).
      const serial =
        typeof o.serial === "number" && Number.isSafeInteger(o.serial) && o.serial >= 0
          ? String(o.serial)
          : typeof o.serial === "string" && /^\d{1,20}$/.test(o.serial)
            ? BigInt(o.serial).toString()
            : null;
      const had = found.get(o.owner);
      if (!had) found.set(o.owner, { address: o.owner, kind: "nft", itemId: o.collection_id, units: serial, count: 1 });
      else had.count++;
    }
  }
  return [...found.values()];
}

export class Indexer {
  private running = false;
  private timer: NodeJS.Timeout | undefined;
  lastError: string | null = null;
  private lastBehind: number | null = null;
  tip = 0;

  /** Blocks at or below this height were indexed as catch-up, not live: no notifications. */
  private liveFrom: number | null = null;

  constructor(
    private db: Db,
    private opts: {
      indexFrom?: number;
      pollMs: number;
      log: (msg: string) => void;
      /** Wallet fee addresses (see classify). */
      feeAddresses?: ReadonlySet<string>;
      /** Called after each live block is stored (used for notifications). */
      onBlock?: (height: number, time: number, rows: { address: string; txid: string; direction: string; amount: number }[]) => void;
    },
  ) {}

  get indexedHeight(): number {
    const row = this.db.prepare("SELECT MAX(height) AS h FROM blocks").get() as { h: number | null };
    return row.h ?? -1;
  }

  start() {
    const loop = async () => {
      if (!this.running) {
        this.running = true;
        try {
          await this.step();
          this.lastError = null;
        } catch (e) {
          this.lastError = (e as Error).message;
          this.opts.log(`indexer: ${this.lastError}`);
        } finally {
          this.running = false;
        }
      }
      this.timer = setTimeout(loop, this.opts.pollMs);
    };
    void loop();
  }

  stop() {
    clearTimeout(this.timer);
  }

  async step() {
    const chain = await rpc<ChainInfo>("getChainInfo");
    this.tip = chain.height;
    // A node that is behind us (resyncing, reindexing, or a different node) is
    // not a reorg: wait for it. Rolling back here would delete history that
    // can't be rebuilt, since the node keeps only the last 42 block bodies.
    if (chain.height < this.indexedHeight) {
      this.lastBehind ??= chain.height;
      if (this.lastBehind !== chain.height) this.opts.log(`indexer: node at ${chain.height}, behind our ${this.indexedHeight}; waiting`);
      this.lastBehind = chain.height;
      return;
    }
    this.lastBehind = null;
    this.liveFrom ??= chain.height + 1;
    let from = this.indexedHeight + 1;
    if (from === 0) from = Math.max(0, this.opts.indexFrom ?? chain.height - (RETAINED_BODIES - 2));

    // Reorg check: re-verify the last few stored hashes against the node.
    const recent = this.db
      .prepare("SELECT height, hash FROM blocks WHERE height >= ? ORDER BY height ASC")
      .all(Math.max(0, from - REORG_DEPTH)) as { height: number; hash: string }[];
    for (const b of recent) {
      const hash = await rpc<string | null>("getBlockHash", [b.height]);
      // No hash means the node doesn't have that block (yet): not a reorg.
      if (hash === null) return;
      if (hash !== b.hash) {
        this.opts.log(`indexer: reorg at ${b.height}, rolling back`);
        this.rollback(b.height);
        from = b.height;
        break;
      }
    }

    for (let h = from; h <= chain.height; h++) {
      const block = await rpc<BlockDetails | null>("getBlockDetails", [h]);
      if (!block) break;
      if (!block.retained) this.opts.log(`indexer: body for ${h} already pruned; history gap`);
      const rows = this.store(block);
      if (this.opts.onBlock && h >= this.liveFrom && rows.length > 0) {
        try {
          this.opts.onBlock(h, block.header.timestamp, rows);
        } catch (e) {
          this.opts.log(`indexer: notify failed: ${(e as Error).message}`);
        }
      }
    }
  }

  private rollback(fromHeight: number) {
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM address_txs WHERE height >= ?").run(fromHeight);
      this.db.prepare("DELETE FROM txs WHERE height >= ?").run(fromHeight);
      this.db.prepare("DELETE FROM blocks WHERE height >= ?").run(fromHeight);
    })();
  }

  /** Stores the block; returns its new history rows (what to notify about). */
  store(block: BlockDetails): { address: string; txid: string; direction: string; amount: number }[] {
    const stored: { address: string; txid: string; direction: string; amount: number }[] = [];
    const { height, hash, timestamp } = block.header;
    const insTx = this.db.prepare(
      "INSERT OR REPLACE INTO txs (txid, height, time, fee, kind, input_owner) VALUES (?, ?, ?, ?, ?, ?)",
    );
    const insAddr = this.db.prepare(
      "INSERT OR REPLACE INTO address_txs (address, txid, height, time, direction, amount, fee, wallet_fee, counterparty, item_id, item_units, item_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)",
    );
    // A token or NFT received: no NOID reached the address, so its own row
    // kind, served only to apps that ask for it (see /v1/address/:a/history).
    const insArrival = this.db.prepare(
      "INSERT OR IGNORE INTO address_txs (address, txid, height, time, direction, amount, fee, wallet_fee, counterparty, item_id, item_units, item_count) VALUES (?, ?, ?, ?, ?, 0, 0, 0, ?, ?, ?, ?)",
    );
    this.db.transaction(() => {
      this.db
        .prepare("INSERT OR REPLACE INTO blocks (height, hash, time, complete) VALUES (?, ?, ?, ?)")
        .run(height, hash, timestamp, block.retained ? 1 : 0);
      for (const tx of block.retained?.transactions ?? []) {
        const kind = tx.coinbase || tx.development_payout ? "coinbase" : tx.contract || isNativeFinance(tx) ? "contract" : "payment";
        insTx.run(tx.txid, height, timestamp, tx.fee_micronoid, kind, tx.input_owner);
        for (const r of classify(tx, this.opts.feeAddresses)) {
          insAddr.run(r.address, tx.txid, height, timestamp, r.direction, r.amount, r.fee, r.walletFee, r.counterparty);
          stored.push({ address: r.address, txid: tx.txid, direction: r.direction, amount: r.amount });
        }
        // Token and NFT recipients (never over a row the address already has for this tx).
        for (const a of nativeArrivals(tx)) {
          const direction = a.kind === "token" ? "token_in" : "nft_in";
          if (insArrival.run(a.address, tx.txid, height, timestamp, direction, tx.input_owner, a.itemId, a.units, a.count).changes === 0) continue;
          stored.push({ address: a.address, txid: tx.txid, direction, amount: 0 });
        }
      }
    })();
    return stored;
  }
}
