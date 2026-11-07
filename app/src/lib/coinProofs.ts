// Coin proofs: checking that the coins the server lists are really in the
// chain's State (Parano1d getSlotProof; core/src/slot_proof.rs does the
// hashing). Kept free of native and React imports so it can be tested in
// Node; lib/coinProofsStore.ts wires it to the core, the chain check and
// screens.
//
// What a proof shows: the slot holds exactly this coin (amount, creation id,
// owner) in the State of one block the phone checked itself. What it can't
// show: that the server listed all of the address's coins.
import type { SlotProofResult, Utxo } from './core';

/** A coin proven in the State of one block. */
export interface ProofRecord {
  creationId: string;
  value: number;
  height: number;
  blockId: string;
  /** When it was proven (ms). Proofs are re-asked for after REPROVE_MS. */
  at: number;
}

/**
 * A proof shows the coin existed in one block. Ask again after this long, so
 * a coin spent since can't keep showing as proven.
 */
export const REPROVE_MS = 30 * 60_000;

/** Slot index → what was proven there. */
export type Records = Map<number, ProofRecord>;

export interface ProveDeps {
  slotProofs: (indices: number[]) => Promise<{ proofs: unknown[] }>;
  /** Check one proof against the phone's own header (throws when it doesn't check out). */
  verify: (proof: unknown, indices: number[]) => Promise<SlotProofResult>;
  /** Bring the phone's chain check up to the server's tip. */
  syncChain: () => Promise<void>;
  /** The server's coin list again, to tell a lie from a coin spent meanwhile. */
  utxos: () => Promise<Utxo[]>;
}

/** Most slots asked about per round (the server's limit); the rest wait for the next. */
export const MAX_PER_ROUND = 256;

/** A coin the server listed that the chain's State says is different or gone. */
export class CoinMismatch extends Error {
  constructor(readonly coins: Utxo[]) {
    super('The server listed coins the chain does not have.');
  }
}

/** The server answered with proofs that don't cover exactly what was asked. */
export class ProofShapeError extends Error {}

function same(r: ProofRecord | undefined, u: Utxo): boolean {
  return !!r && r.creationId === u.creationId && r.value === u.value;
}

/** The coins still to prove: listed now, with no matching record or an old one. Sorted by slot. */
export function toProve(utxos: Utxo[], known: Records, now: number): number[] {
  return utxos
    .filter((u) => {
      const r = known.get(u.slotIndex);
      return !same(r, u) || now - r!.at > REPROVE_MS;
    })
    .map((u) => u.slotIndex)
    .sort((a, b) => a - b)
    .slice(0, MAX_PER_ROUND);
}

/** The slot indices one proof covers, in order. */
function pieceIndices(p: unknown): number[] {
  const slots = (p as { slots?: unknown }).slots;
  if (!Array.isArray(slots)) throw new ProofShapeError('A proof has no slots.');
  return slots.map((s) => {
    const i = (s as { slot_index?: unknown }).slot_index;
    if (typeof i !== 'number' || !Number.isInteger(i) || i < 0) throw new ProofShapeError('A proof slot has no index.');
    return i;
  });
}

/**
 * Prove the listed coins that aren't proven yet. Returns the updated records
 * (only coins still listed). Throws CoinMismatch when the server keeps
 * listing a coin the State contradicts, ProofShapeError for an answer that
 * doesn't match the question, and the core's error for a proof that doesn't
 * check out.
 */
export async function proveCoins(deps: ProveDeps, address: string, utxos: Utxo[], known: Records, now = Date.now()): Promise<Records> {
  const listed = new Map(utxos.map((u) => [u.slotIndex, u]));
  const records: Records = new Map(
    [...known].filter(([slot, r]) => {
      const u = listed.get(slot);
      return !!u && same(r, u);
    }),
  );
  const indices = toProve(utxos, records, now);
  if (indices.length === 0) return records;

  const { proofs } = await deps.slotProofs(indices);
  // The pieces must cover exactly the slots asked about, in order.
  const pieces = proofs.map(pieceIndices);
  const flat = pieces.flat();
  if (flat.length !== indices.length || flat.some((v, k) => v !== indices[k])) throw new ProofShapeError('The proofs are not for the coins asked about.');

  const mismatched: Utxo[] = [];
  for (let k = 0; k < proofs.length; k++) {
    let res = await deps.verify(proofs[k], pieces[k]!);
    if (res.status === 'unknown_block') {
      // Usually a block the phone hasn't checked yet: catch up once.
      await deps.syncChain();
      res = await deps.verify(proofs[k], pieces[k]!);
      if (res.status === 'unknown_block') continue; // no verdict this round
    }
    for (const s of res.slots) {
      const u = listed.get(s.slotIndex)!;
      if (s.empty || s.owner !== address || s.creationId !== u.creationId || s.value !== u.value) mismatched.push(u);
      else records.set(s.slotIndex, { creationId: s.creationId, value: s.value, height: res.height, blockId: res.blockId, at: now });
    }
  }
  for (const u of mismatched) records.delete(u.slotIndex);
  if (mismatched.length > 0) {
    // A coin spent between the list and the proof is fine: ask for the list
    // again. Only coins the server still lists, unchanged, are a lie.
    const fresh = new Map((await deps.utxos()).map((u) => [u.slotIndex, u]));
    const lies = mismatched.filter((u) => {
      const f = fresh.get(u.slotIndex);
      return !!f && f.creationId === u.creationId && f.value === u.value;
    });
    if (lies.length > 0) throw new CoinMismatch(lies);
  }
  return records;
}

export interface CoinSummary {
  coins: number;
  /** Proven in a block that counts as checked on this phone. */
  proven: number;
  provenValue: number;
  /** Proven in a block that doesn't count as checked yet (too new). */
  waiting: number;
  /** Not proven (yet). */
  unproven: number;
  /** Lowest and highest block the proven coins were proven in. */
  blocks: [number, number] | null;
}

/**
 * Where the listed coins stand. `checked(height, blockId)` is the chain
 * check's verdict on a block: true (that block, counted as checked), false
 * (a different block there), null (not counted yet, or not remembered).
 */
export function summarize(utxos: Utxo[], records: Records, checked: (height: number, blockId: string) => boolean | null): CoinSummary {
  const out: CoinSummary = { coins: utxos.length, proven: 0, provenValue: 0, waiting: 0, unproven: 0, blocks: null };
  for (const u of utxos) {
    const r = records.get(u.slotIndex);
    const verdict = r && same(r, u) ? checked(r.height, r.blockId) : undefined;
    if (verdict === true) {
      out.proven++;
      out.provenValue += u.value;
      out.blocks = out.blocks ? [Math.min(out.blocks[0], r!.height), Math.max(out.blocks[1], r!.height)] : [r!.height, r!.height];
    } else if (verdict === null) out.waiting++;
    else out.unproven++;
  }
  return out;
}

/** Records whose block the chain check now places elsewhere: prove those again. */
export function dropReplaced(records: Records, checked: (height: number, blockId: string) => boolean | null): Records {
  return new Map([...records].filter(([, r]) => checked(r.height, r.blockId) !== false));
}
