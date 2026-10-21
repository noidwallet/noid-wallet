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
import { ApiError, type Api } from './api';
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

/**
 * A phone that has never made a gift (new install or restore) starts halfway
 * through today's numbers: the same wallet on another phone may have used
 * today's first numbers already, and its newest gift may not be on the server
 * yet. "Find gifts" scans every number of a day, so nothing is missed.
 */
export const FRESH_PHONE_OFFSET = 50;
/** Plus a random 0-39, so two phones restored the same day rarely pick the same number. */
export const FRESH_PHONE_SPREAD = 40;

/** Next unused gift number: today's slots, above anything used before on this phone. */
export function pickGiftIndex(
  gifts: GiftRecord[],
  highWater: number,
  nowMs: number = Date.now(),
  random: () => number = Math.random,
): number {
  const used = new Set(gifts.map((g) => g.index));
  const freshPhone = highWater < 0 && gifts.length === 0;
  const spread = Math.min(FRESH_PHONE_SPREAD - 1, Math.floor(random() * FRESH_PHONE_SPREAD));
  const dayStart = giftDay(nowMs) * GIFTS_PER_DAY + (freshPhone ? FRESH_PHONE_OFFSET + spread : 0);
  let index = Math.max(dayStart, highWater + 1, ...gifts.map((g) => g.index + 1));
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

/** Retry when the server says "too many requests", waiting a little longer each time. */
async function withBackoff<T>(fn: () => Promise<T>, sleep: (ms: number) => Promise<void>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (!(e instanceof ApiError) || e.status !== 429 || attempt >= 5) throw e;
      await sleep(10_000 * (attempt + 1));
    }
  }
}

/**
 * "Find gifts" after a restore: check every gift number of every day since
 * gift numbers began (and tomorrow's, which a busy day spills into). Each day
 * is one request to the server; any used number not already on this phone
 * that still holds NOID is returned. Servers without that request are asked
 * address by address, up to 10 unused numbers in a row per day.
 */
export async function findLostGifts(
  api: Api,
  addressesFrom: (start: number, count: number) => Promise<{ index: number; address: string }[]>,
  known: GiftRecord[],
  opts: {
    nowMs?: number;
    gap?: number;
    onProgress?: (done: number, total: number) => void;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<{ index: number; address: string; balance: number }[]> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const gap = opts.gap ?? 10;
  const today = giftDay(opts.nowMs ?? Date.now());
  const have = new Set(known.map((g) => g.address));
  const found: { index: number; address: string; balance: number }[] = [];
  let oneRequest = true;

  const keepIfFunded = async (a: { index: number; address: string }) => {
    if (have.has(a.address)) return;
    const { balance } = await withBackoff(() => api.utxos(a.address), sleep);
    if (balance > 0) found.push({ ...a, balance });
  };

  for (let d = today + 1; d >= 0; d--) {
    const day = await addressesFrom(d * GIFTS_PER_DAY, GIFTS_PER_DAY);
    if (oneRequest) {
      try {
        const { used } = await withBackoff(() => api.addressesUsed(day.map((a) => a.address)), sleep);
        const usedSet = new Set(used);
        for (const a of day) if (usedSet.has(a.address)) await keepIfFunded(a);
        opts.onProgress?.(today + 1 - d + 1, today + 2);
        continue;
      } catch (e) {
        if (!(e instanceof ApiError) || e.status !== 404) throw e;
        oneRequest = false; // older server: ask address by address
      }
    }
    // Two runs per day: from number 0, and from 50, where a freshly
    // restored phone starts (up to 39 numbers further on).
    const runs: [typeof day, number][] = [
      [day.slice(0, FRESH_PHONE_OFFSET), gap],
      [day.slice(FRESH_PHONE_OFFSET), Math.max(gap, FRESH_PHONE_SPREAD)],
    ];
    for (const [run, runGap] of runs) {
      let misses = 0;
      for (const a of run) {
        if (misses >= runGap) break;
        const h = await withBackoff(() => api.history(a.address), sleep);
        if (h.items.length === 0) {
          misses++;
          continue;
        }
        misses = 0;
        await keepIfFunded(a);
      }
    }
    opts.onProgress?.(today + 1 - d + 1, today + 2);
  }
  return found;
}
