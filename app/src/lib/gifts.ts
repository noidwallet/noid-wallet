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

export function nextGiftIndex(gifts: GiftRecord[]): number {
  return gifts.reduce((m, g) => Math.max(m, g.index + 1), 0);
}

/**
 * A gift address must never be used twice: its secret may still sit in an old
 * link. Starting at `from`, return the first gift number whose address has no
 * coins and no history on the server.
 */
export async function freshGiftIndex(
  api: Api,
  from: number,
  addressOf: (index: number) => Promise<string>,
  maxTries = 50,
): Promise<{ index: number; address: string }> {
  for (let index = from; index < from + maxTries; index++) {
    const address = await addressOf(index);
    const [coins, hist] = await Promise.all([api.utxos(address), api.history(address)]);
    if (coins.balance === 0 && coins.utxos.length === 0 && hist.items.length === 0) return { index, address };
  }
  throw new Error('Could not find an unused gift number. Try again later.');
}

export type GiftState = 'draft' | 'waiting' | 'funded' | 'claimed' | 'takenBack';

/**
 * Work out where a gift stands from the chain:
 * - coins at the gift address -> funded (waiting to be claimed)
 * - none, and the funding tx confirmed -> claimed (or taken back by us)
 * - none, funding not confirmed yet -> waiting
 */
export async function giftState(api: Api, g: GiftRecord): Promise<GiftState> {
  if (g.status === 'claimed' || g.status === 'takenBack') return g.status;
  const { balance } = await api.utxos(g.address);
  if (balance > 0) return 'funded';
  if (!g.fundTxid) return 'draft';
  const tx = await api.tx(g.fundTxid);
  if (tx.status !== 'confirmed') return g.status === 'draft' ? 'draft' : 'waiting';
  return g.takeBackTxid ? 'takenBack' : 'claimed';
}

/**
 * After a restore: find gifts this wallet made that are not in the list.
 * Funded ones can be taken back; used ones are recorded (hidden) so their
 * numbers are never reused.
 */
export async function findLostGifts(
  api: Api,
  addresses: { index: number; address: string }[],
  known: GiftRecord[],
): Promise<{ index: number; address: string; balance: number; used: boolean }[]> {
  const have = new Set(known.map((g) => g.address));
  const found: { index: number; address: string; balance: number; used: boolean }[] = [];
  const todo = addresses.filter((a) => !have.has(a.address));
  // A few at a time, to be gentle with the server.
  for (let i = 0; i < todo.length; i += 5) {
    const batch = todo.slice(i, i + 5);
    const res = await Promise.all(
      batch.map(async (a) => {
        const [coins, hist] = await Promise.all([api.utxos(a.address), api.history(a.address)]);
        return { ...a, balance: coins.balance, used: coins.balance > 0 || hist.items.length > 0 };
      }),
    );
    found.push(...res.filter((r) => r.used));
  }
  return found;
}
