// The NOID wallet fee: 0.25% of what you send, at least 0.005 and at most
// 0.5 NOID. It is paid as its own output to the address below, inside the same
// transaction, and shown on every review screen before you confirm.
//
// It applies to sends (including paying a request) and to new gift cards.
// Receiving, claiming a gift, taking a gift back and combining coins are free.
//
// The address and the rates are part of the signed app on purpose: the wallet
// server can't change them, so a hacked server can't redirect anyone's fee.

/** Where wallet fees go. Public: anyone can see what arrives there. */
export const WALLET_FEE_ADDRESS = 'o155fsn6m5au9ardteuw0qc77agzzp6a99c8j5k60qumdwus5ajwesf9magf';

/** 25 basis points = 0.25%. */
export const WALLET_FEE_BPS = 25;
/** 0.005 NOID: never less, so each fee is worth the network cost of its own output. */
export const WALLET_FEE_MIN = 5_000;
/** 0.5 NOID: never more, however large the payment. */
export const WALLET_FEE_MAX = 500_000;

export interface FeeRule {
  address: string;
  bps: number;
  min: number;
  max: number;
}
export const WALLET_FEE: FeeRule = { address: WALLET_FEE_ADDRESS, bps: WALLET_FEE_BPS, min: WALLET_FEE_MIN, max: WALLET_FEE_MAX };

/** Wallet fee in μNOID for sending `amount` μNOID. */
export function walletFeeFor(amount: number, rule: FeeRule = WALLET_FEE): number {
  if (!rule.address || !(amount > 0)) return 0;
  const pct = Math.floor((amount * rule.bps) / 10_000);
  return Math.min(rule.max, Math.max(rule.min, pct));
}

/** Review-screen label: says when the minimum or maximum applies instead of the 0.25%. */
export function walletFeeLabel(amount: number, fee: number, rule: FeeRule = WALLET_FEE): string {
  const pct = Math.floor((amount * rule.bps) / 10_000);
  if (fee === rule.min && pct < rule.min) return 'NOID wallet fee (minimum)';
  if (fee === rule.max && pct > rule.max) return 'NOID wallet fee (maximum)';
  return `NOID wallet fee (${rule.bps / 100}%)`;
}

/** "0.25%, at least 0.005 NOID, at most 0.5 NOID", for help text. */
export const WALLET_FEE_TEXT = '0.25% of the amount (at least 0.005 NOID, at most 0.5 NOID)';

// Network fee rules (consensus, noid_chain fees.rs; same as core/src/fees.rs).
const MIN_FEE_BASE = 5_000;
const FEE_PER_INPUT = 100;
const FEE_PER_OUTPUT = 700;
const STATE_GROWTH_FEE_BASE = 2_500;

function pressure(activeSlotCount: number, logSlots: number): number {
  const capacity = Math.max(1, 2 ** logSlots);
  const bps = Math.floor((activeSlotCount * 10_000) / capacity);
  return bps >= 9_000 ? 8 : bps >= 7_500 ? 4 : bps >= 5_000 ? 2 : 1;
}

/** Minimum network fee for a transaction shape, as the network computes it. */
export function networkFee(
  inputs: number,
  outputs: number,
  ctx: { activeSlotCount: number; logSlots: number; relayFloor: number },
): number {
  const growth = Math.max(0, outputs - inputs) * STATE_GROWTH_FEE_BASE * pressure(ctx.activeSlotCount, ctx.logSlots);
  return Math.max(ctx.relayFloor, MIN_FEE_BASE + FEE_PER_INPUT * inputs + FEE_PER_OUTPUT * outputs + growth);
}

/**
 * The most that can be sent from `spendable` μNOID in `coins` coins with no
 * change left over: recipient + wallet fee outputs, network fee and wallet
 * fee all paid from the balance. Null when the balance can't cover the fees.
 */
export function maxSendable(
  spendable: number,
  coins: number,
  ctx: { activeSlotCount: number; logSlots: number; relayFloor: number },
  rule: FeeRule = WALLET_FEE,
): number | null {
  const outputs = rule.address ? 2 : 1;
  const left = spendable - networkFee(coins, outputs, ctx);
  if (left <= 0) return null;
  // amount + walletFeeFor(amount) must equal `left`; start from the percentage
  // and adjust, since the minimum and maximum make it non-linear.
  let amount = Math.floor((left * 10_000) / (10_000 + (rule.address ? rule.bps : 0)));
  for (let i = 0; i < 4 && amount > 0; i++) {
    const next = left - walletFeeFor(amount, rule);
    if (next === amount) break;
    amount = next;
  }
  while (amount > 0 && amount + walletFeeFor(amount, rule) > left) amount--;
  return amount > 0 ? amount : null;
}
