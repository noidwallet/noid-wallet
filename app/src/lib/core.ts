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
  /** Decode and check the server's token/NFT records for `owner`. */
  checkAssets: (owner: string, page: AssetsPage) => call<CheckedAssets>('checkAssets', { owner, page }),
  checkToken: (assetId: string, market: AssetMarket) => call<TokenInfo>('checkToken', { assetId, market }),
  /** Throws unless `text` is exactly the metadata State committed to (`hash`). */
  checkMetadata: (hash: string, text: string, kind: MediaKind) => call<AssetManifest>('checkMetadata', { hash, text, kind }),
  /** Throws unless the file is exactly the committed picture. */
  checkImage: (path: string, image: { hash: string; width: number; height: number; bytes: number }) =>
    call<{ ok: true }>('checkImage', { path, ...image }),
};
