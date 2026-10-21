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
export function classify(tx: BlockTx, feeAddresses: ReadonlySet<string> = new Set()): AddressRow[] {
  const received = new Map<string, number>();
  for (const o of tx.outputs) received.set(o.owner, (received.get(o.owner) ?? 0) + o.amount_micronoid);

  if (tx.coinbase || tx.development_payout || !tx.input_owner) {
    return [...received].map(([address, amount]) => ({ address, direction: "mined", amount, fee: 0, walletFee: 0, counterparty: null }));
  }

  const sender = tx.input_owner;
  const others = [...received].filter(([a]) => a !== sender);
  const rows: AddressRow[] = [];
  if (tx.contract) {
    // Contract call or close: value moves under contract rules, not a plain payment.
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

export class Indexer {
  private running = false;
  private timer: NodeJS.Timeout | undefined;
  lastError: string | null = null;
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
    this.liveFrom ??= chain.height + 1;
    let from = this.indexedHeight + 1;
    if (from === 0) from = Math.max(0, this.opts.indexFrom ?? chain.height - (RETAINED_BODIES - 2));

    // Reorg check: re-verify the last few stored hashes against the node.
    const recent = this.db
      .prepare("SELECT height, hash FROM blocks WHERE height >= ? ORDER BY height ASC")
      .all(Math.max(0, from - REORG_DEPTH)) as { height: number; hash: string }[];
    for (const b of recent) {
      const hash = await rpc<string | null>("getBlockHash", [b.height]);
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

  store(block: BlockDetails): { address: string; txid: string; direction: string; amount: number }[] {
    const stored: { address: string; txid: string; direction: string; amount: number }[] = [];
    const { height, hash, timestamp } = block.header;
    const insTx = this.db.prepare(
      "INSERT OR REPLACE INTO txs (txid, height, time, fee, kind, input_owner) VALUES (?, ?, ?, ?, ?, ?)",
    );
    const insAddr = this.db.prepare(
      "INSERT OR REPLACE INTO address_txs (address, txid, height, time, direction, amount, fee, wallet_fee, counterparty) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    this.db.transaction(() => {
      this.db
        .prepare("INSERT OR REPLACE INTO blocks (height, hash, time, complete) VALUES (?, ?, ?, ?)")
        .run(height, hash, timestamp, block.retained ? 1 : 0);
      for (const tx of block.retained?.transactions ?? []) {
        const kind = tx.coinbase || tx.development_payout ? "coinbase" : tx.contract ? "contract" : "payment";
        insTx.run(tx.txid, height, timestamp, tx.fee_micronoid, kind, tx.input_owner);
        for (const r of classify(tx, this.opts.feeAddresses)) {
          insAddr.run(r.address, tx.txid, height, timestamp, r.direction, r.amount, r.fee, r.walletFee, r.counterparty);
          stored.push({ address: r.address, txid: tx.txid, direction: r.direction, amount: r.amount });
        }
      }
    })();
    return stored;
  }
}
