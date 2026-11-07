// Typed wrapper around the Rust wallet core (modules/noid-core + /core).
// All secret work (keys, Photo Key, proving) happens inside the core.
import NoidCore from '../../modules/noid-core';
import type { AssetMarket, AssetsPage } from './api';

export class CoreError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

async function call<T>(method: string, args: object = {}): Promise<T> {
  const raw = await NoidCore.call(method, JSON.stringify(args));
  const out = JSON.parse(raw) as { ok?: T; error?: { code: string; message: string } };
  if (out.error) throw new CoreError(out.error.code, out.error.message);
  return out.ok as T;
}

export interface Utxo {
  slotIndex: number;
  value: number;
  /** Decimal string: mined coins use 1 << 63 | height, beyond JS number range. */
  creationId: string;
}

export interface FeeContext {
  activeSlotCount: number;
  logSlots: number;
  relayFloor: number;
}

export interface FeeBreakdown {
  base: number;
  input: number;
  output: number;
  stateGrowth: number;
  requiredTotal: number;
  burned: number;
}

export interface SendPlan {
  amount: number;
  /** NOID wallet fee (its own output), 0 for sweeps. */
  walletFee: number;
  fee: number;
  totalSpend: number;
  inputCount: number;
  outputCount: number;
  change: number;
  spendable: number;
  selectedSlots: number[];
  feeBreakdown: FeeBreakdown;
}

export interface ConsolidationPlan {
  inputValue: number;
  fee: number;
  outputValue: number;
  balanceBefore: number;
  balanceAfter: number;
  inputCount: number;
  untouchedCount: number;
  freedSlots: number;
  selectedInputSlots: number[];
  feeBreakdown: FeeBreakdown;
}

export interface BuiltTx {
  txid: string;
  intentHex: string;
  fee: number;
  amount: number;
  walletFee: number;
  change: number;
  inputCount: number;
  outputCount: number;
  inputSlots: number[];
  outputSlots: number[];
  proveMs: number;
}

export interface NewKey {
  secretHex: string;
  keyId: string;
  address: string;
}

/** A token this address holds (amounts are decimal strings of base units, 6 decimals). */
export interface CheckedToken {
  assetId: string;
  units: string;
  lockedUnits: string;
  reservedUnits: string;
  outputs: number;
  /** This address created the token. */
  issuedHere: boolean;
}

export interface CheckedNft {
  collection: string;
  serial: string;
  metadata: string;
  /** Decimal strings: u64 values beyond JavaScript number range. */
  unlockHeight: string;
  locked: boolean;
  /** Listed for sale on the NFT marketplace (μNOID and height as decimal strings). */
  listing: { askMicronoid: string; expiryHeight: string; ready: boolean } | null;
  reserved: boolean;
}

export interface CheckedAssets {
  owner: string;
  height: number;
  blockHash: string;
  stateRoot: string;
  decimals: number;
  tokens: CheckedToken[];
  nfts: CheckedNft[];
  /** Collections this address created (managed in the official wallet). */
  collections: number;
  /** Trade requests, pool positions and other records not shown yet. */
  other: number;
}

export type TokenInfo =
  | { assetId: string; known: false }
  | {
      assetId: string;
      known: true;
      metadata: string;
      issuer: string;
      initialSupply: string;
      outstanding: string;
      backingMicronoid: string;
      phase: 'curve' | 'dex';
      /** NOID base units per token base unit = priceNumerator / priceDenominator. */
      priceNumerator: string;
      priceDenominator: string;
      ready: boolean;
      /**
       * μNOID that selling the units asked about into the market right now would
       * pay (after its fee), from the official trade rules. Null without units,
       * or when that many can't be sold into it.
       */
      sellValueMicronoid: string | null;
      height: number;
    };

export type MediaKind = 'token' | 'nft' | 'collection';

export interface AssetManifest {
  name: string;
  symbol: string | null;
  description: string;
  website: string | null;
  image: { hash: string; width: number; height: number; bytes: number } | null;
}

/** The phone's view of the chain (core/src/chain.rs). Opaque except `ids`. */
export interface ChainState {
  v: number;
  checkpoint: number;
  headers: string[];
  workBefore: string;
  /** Height (decimal string) to the block id the phone checked there. */
  ids: Record<string, string>;
  /** Highest trimmed block that had counted as checked (0 or missing: none). */
  checkedFloor?: number;
}

export interface ChainInfo {
  checkpointHeight: number;
  tipHeight: number;
  tipId: string;
  tipTimestamp: number;
  /** Highest block that counts as checked (8+ deep, enough work on top); the checkpoint height when none does yet. */
  checkedHeight: number;
}

/** A slot a coin proof showed, as the phone can rely on it (core/src/slot_proof.rs). */
export interface ProvenSlot {
  slotIndex: number;
  value: number;
  /** Decimal string: creation ids pass 2^53. */
  creationId: string;
  owner: string;
  empty: boolean;
}

export type SlotProofResult =
  /** Checked against the phone's own header at `height`. `checked`: that block counts as checked yet. */
  | { status: 'proven'; height: number; blockId: string; checked: boolean; slots: ProvenSlot[] }
  /** The phone doesn't hold that block (yet, or any more): no verdict. */
  | { status: 'unknown_block'; height: number; phoneTip: number };

export interface SyncResult {
  state: ChainState;
  info: ChainInfo;
  accepted: number;
  refused: { height: number; code: string } | null;
  reorgDepth: number;
}

/** What the user asked to send (core/src/native_send.rs Transfer). */
export type NativeTransfer =
  | { kind: 'token'; assetId: string; units: string; recipient: string }
  | { kind: 'nft'; collectionId: string; serial: string; recipient: string };

export interface NativeSendRequest {
  plan: unknown;
  transfer: NativeTransfer;
  slotHints: number[];
  relayFloor: number;
}

/** Every figure computed on the phone from the decoded transfer. */
export interface NativeSendReview {
  kind: 'token' | 'nft';
  recipient: string;
  assetId: string | null;
  units: string | null;
  collectionId: string | null;
  serial: string | null;
  networkFee: number;
  walletFee: number;
  /** Network fee plus wallet fee: all the NOID this send costs. */
  noidDebit: number;
  inputCount: number;
  outputCount: number;
  parentHeight: number;
  parentId: string;
  txid: string;
}

export interface BuiltNativeSend {
  review: NativeSendReview;
  intentHex: string;
  txid: string;
  noidInputs: { slotIndex: number; creationId: string }[];
  recordInputSlots: number[];
  outputSlots: number[];
  proveMs: number;
}

export const core = {
  version: () => call<{ core: string; parano1dRev: string; photoKey: string }>('version'),
  generateSecret: () => call<NewKey>('generateSecret'),
  inspectSecret: (secretHex: string) => call<{ keyId: string; address: string }>('inspectSecret', { secretHex }),
  photoKeySelfTest: () => call<{ ok: boolean }>('photoKeySelfTest'),
  photoKey: (path: string) => call<NewKey & { width: number; height: number }>('photoKey', { path }),
  deriveAddresses: (secretHex: string, start: number, count: number) =>
    call<{ index: number; address: string }[]>('deriveAddresses', { secretHex, start, count }),
  validateAddress: (address: string) => call<{ valid: boolean; address?: string; error?: string }>('validateAddress', { address }),
  planSend: (a: { utxos: Utxo[]; pendingInputSlots: number[]; amount: number; fee: number | null; walletFee: number } & FeeContext) =>
    call<SendPlan>('planSend', a),
  planConsolidation: (a: { utxos: Utxo[]; pendingInputSlots: number[]; maxInputs?: number } & FeeContext) =>
    call<ConsolidationPlan>('planConsolidation', a),
  /** Move every coin at an address to one recipient (gift claim / take back). */
  planSweep: (a: { utxos: Utxo[]; pendingInputSlots: number[] } & FeeContext) => call<SendPlan>('planSweep', a),
  /** Gift card `index` of this wallet: secret for the link, and its address. */
  giftKey: (secretHex: string, index: number) =>
    call<{ giftSecretHex: string; address: string; index: number }>('giftKey', { secretHex, index }),
  giftAddresses: (secretHex: string, start: number, count: number) =>
    call<{ index: number; address: string }[]>('giftAddresses', { secretHex, start, count }),
  buildTransaction: (a: {
    secretHex: string;
    keyIndex: number;
    utxos: Utxo[];
    selectedSlots: number[];
    to: string | null;
    amount: number;
    walletFee?: number;
    walletFeeTo?: string;
    fee: number;
    epochAnchorHex: string;
    /** Chain tip from /v1/prepare: picks the proof construction (Parano1d v2.1). */
    tipHeight: number;
    slotHints: number[];
    pendingOutputSlots: number[];
  }) => call<BuiltTx>('buildTransaction', a),
  /** Check the server's plan for a token or NFT send (no secret): the review screen. */
  checkNativeSend: (owner: string, request: NativeSendRequest, pendingOutputSlots: number[]) =>
    call<NativeSendReview>('checkNativeSend', { owner, request, pendingOutputSlots }),
  /** Check again, add the wallet fee, prove and encode. */
  buildNativeSend: (secretHex: string, keyIndex: number, request: NativeSendRequest, pendingOutputSlots: number[]) =>
    call<BuiltNativeSend>('buildNativeSend', { secretHex, keyIndex, request, pendingOutputSlots }),
  /** Decode and check the server's token/NFT records for `owner`. */
  checkAssets: (owner: string, page: AssetsPage) => call<CheckedAssets>('checkAssets', { owner, page }),
  checkToken: (assetId: string, market: AssetMarket, units?: string) => call<TokenInfo>('checkToken', { assetId, market, units }),
  /** Throws unless `text` is exactly the metadata State committed to (`hash`). */
  checkMetadata: (hash: string, text: string, kind: MediaKind) => call<AssetManifest>('checkMetadata', { hash, text, kind }),
  /** Throws unless the file is exactly the committed picture. */
  checkImage: (path: string, image: { hash: string; width: number; height: number; bytes: number }) =>
    call<{ ok: true }>('checkImage', { path, ...image }),
  /** Where the phone's own chain check stands (`state` null: the built-in checkpoint). */
  chainInfo: (state: ChainState | null) => call<ChainInfo>('chainInfo', { state }),
  /**
   * Check a coin proof against the phone's own header. Throws (proof_invalid,
   * proof_other_chain) when it doesn't check out.
   */
  verifySlotProof: (state: ChainState, proof: unknown, indices: number[]) =>
    call<SlotProofResult>('verifySlotProof', { state, proof, indices }),
  /** Check raw headers (hex, contiguous, oldest first) and adopt the ones that pass. */
  syncHeaders: (state: ChainState | null, headersHex: string[], now: number) =>
    call<SyncResult>('syncHeaders', { state, headersHex, now }),
};
