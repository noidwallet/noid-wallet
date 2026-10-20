// Gift cards.
//
// A gift is a small wallet of its own. Its secret is derived from this
// wallet's master secret (gift #0, #1, ...), NOID is sent to its address, and
// the secret travels to the recipient inside a link. Whoever opens the link
// moves the coins into their own wallet ("claim"). Until then the sender can
// take them back with the same secret.
//
// The sender pays the claim fee up front, so the recipient gets exactly the
// amount on the card.
import { colors } from '../theme';
import type { Api } from './api';
import type { GiftRecord } from './storage';

/** Claim = 1 coin in, 1 coin out: base 5000 + 100 + 700, never state growth. */
export function claimFee(relayFloor: number): number {
  return Math.max(relayFloor, 5_000 + 100 + 700);
}

export function newGiftRecord(g: {
  index: number;
  address: string;
  amount: number;
  message: string;
  theme: string;
  from: string;
}): GiftRecord {
  return { ...g, message: g.message.trim(), from: g.from.trim(), createdAt: Date.now(), fundTxid: null, status: 'draft' };
}

/**
 * Gift numbers are date-based: day number x 100 + a counter. A wallet restored
 * on a new phone therefore starts at today's numbers, never at #0 again, so a
 * new gift can never land on an address whose secret sits in an old link.
 * Being date-based (not random) still lets "Find gifts" scan recent days.
 */
const GIFT_EPOCH_MS = Date.UTC(2026, 0, 1);
export const GIFTS_PER_DAY = 100;

export function giftDay(nowMs: number): number {
  return Math.max(0, Math.floor((nowMs - GIFT_EPOCH_MS) / 86_400_000));
}

/** Next unused gift number: today's slots, above anything used before on this phone. */
export function pickGiftIndex(gifts: GiftRecord[], highWater: number, nowMs: number = Date.now()): number {
  const used = new Set(gifts.map((g) => g.index));
  let index = Math.max(giftDay(nowMs) * GIFTS_PER_DAY, highWater + 1, ...gifts.map((g) => g.index + 1));
  while (used.has(index)) index++;
  return index;
}

/**
 * Extra guard: starting at `from`, return the first gift number whose address
 * has no coins and no history on the server.
 */
export async function freshGiftIndex(
  api: Api,
  from: number,
  addressOf: (index: number) => Promise<string>,
  maxTries = 20,
): Promise<{ index: number; address: string }> {
  for (let index = from; index < from + maxTries; index++) {
    const address = await addressOf(index);
    const [coins, hist] = await Promise.all([api.utxos(address), api.history(address)]);
    if (coins.balance === 0 && coins.utxos.length === 0 && hist.items.length === 0) return { index, address };
  }
  throw new Error('Could not find an unused gift number. Try again later.');
}

/**
 * The fee to move a gift should be close to the network minimum. A much
 * higher one means the wallet server is misconfigured or hostile: refuse
 * rather than let fees eat the gift.
 */
export function sweepFeeTooHigh(fee: number, inputCount: number): boolean {
  const minimum = 5_000 + 100 * inputCount + 700;
  return fee > Math.max(3 * minimum, 20_000);
}

export type GiftState = 'draft' | 'waiting' | 'funded' | 'takingBack' | 'claimed' | 'takenBack';

/** One set of words and colours for gift states, used on every screen. */
export const GIFT_STATUS: Record<GiftState, { text: string; color: string }> = {
  draft: { text: 'Not sent', color: colors.muted },
  waiting: { text: 'Sending… waits for the next block', color: colors.warn },
  funded: { text: 'Not claimed yet', color: colors.warn },
  takingBack: { text: 'Taking back… arrives with the next block', color: colors.warn },
  claimed: { text: 'Claimed', color: colors.accent },
  takenBack: { text: 'Taken back', color: colors.muted },
};

/** Badge colour for each state. */
export const GIFT_TONE: Record<GiftState, 'neutral' | 'warn' | 'success'> = {
  draft: 'neutral',
  waiting: 'warn',
  funded: 'warn',
  takingBack: 'warn',
  claimed: 'success',
  takenBack: 'neutral',
};

/** Short badge text. */
export const GIFT_BADGE: Record<GiftState, string> = {
  draft: 'Not sent',
  waiting: 'Sending',
  funded: 'Unclaimed',
  takingBack: 'Taking back',
  claimed: 'Claimed',
  takenBack: 'Taken back',
};

/**
 * Work out where a gift stands from the chain, every time (a saved status is
 * never trusted over what the chain shows):
 * - coins at the gift address -> funded, or takingBack while our take-back is pending
 * - none, funding not confirmed -> waiting (or draft if never funded)
 * - none, and our take-back confirmed -> takenBack; otherwise claimed
 */
export async function giftState(api: Api, g: GiftRecord): Promise<GiftState> {
  const { balance } = await api.utxos(g.address);
  const takeBack = g.takeBackTxid ? await api.tx(g.takeBackTxid).catch(() => null) : null;
  if (balance > 0) return takeBack && takeBack.status !== 'confirmed' ? 'takingBack' : 'funded';
  if (!g.fundTxid) return 'draft';
  const fund = await api.tx(g.fundTxid);
  if (fund.status !== 'confirmed') return 'waiting';
  return takeBack?.status === 'confirmed' ? 'takenBack' : 'claimed';
}

/**
 * "Find gifts" after a restore: walk every day since gift numbers began. Each
 * day's numbers are used in order (day x 100, +1, +2 ...), so a day is done
 * after `gap` numbers in a row that never had any activity. Any used number
 * not already on this phone that still holds NOID is returned.
 */
export async function findLostGifts(
  api: Api,
  addressesFrom: (start: number, count: number) => Promise<{ index: number; address: string }[]>,
  known: GiftRecord[],
  opts: { nowMs?: number; gap?: number; onProgress?: (done: number, total: number) => void } = {},
): Promise<{ index: number; address: string; balance: number }[]> {
  const gap = opts.gap ?? 2;
  const today = giftDay(opts.nowMs ?? Date.now());
  const have = new Set(known.map((g) => g.address));
  const found: { index: number; address: string; balance: number }[] = [];
  for (let d = today; d >= 0; d--) {
    let misses = 0;
    for (let k = 0; k < GIFTS_PER_DAY && misses < gap; k += 4) {
      const batch = await addressesFrom(d * GIFTS_PER_DAY + k, Math.min(4, GIFTS_PER_DAY - k));
      const used = await Promise.all(batch.map((a) => api.history(a.address).then((h) => h.items.length > 0)));
      for (let i = 0; i < batch.length && misses < gap; i++) {
        if (!used[i]) {
          misses++;
          continue;
        }
        misses = 0;
        const a = batch[i]!;
        if (have.has(a.address)) continue;
        const { balance } = await api.utxos(a.address);
        if (balance > 0) found.push({ ...a, balance });
      }
    }
    opts.onProgress?.(today - d + 1, today + 1);
  }
  return found;
}
