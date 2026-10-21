// Typed wrapper around the Rust wallet core (modules/noid-core + /core).
// All secret work (keys, Photo Key, proving) happens inside the core.
import NoidCore from '../../modules/noid-core';

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
    slotHints: number[];
    pendingOutputSlots: number[];
  }) => call<BuiltTx>('buildTransaction', a),
};
