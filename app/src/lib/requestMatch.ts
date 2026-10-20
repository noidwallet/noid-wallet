import type { HistoryItem } from './api';

/**
 * Did a payment request get paid? Looks only at payments in blocks after the
 * chain height when the request was made (and never at anything already in the
 * history then), so an old payment of the same amount can never count.
 *
 * - paid:      a new incoming payment of exactly the requested amount
 *              (or any new incoming payment, for an "any amount" request)
 * - different: new money arrived, but not the amount asked for
 * - waiting:   nothing new yet
 *
 * Only confirmed payments in this wallet's own history count: a screenshot
 * from the payer is never proof.
 */
export type RequestStatus =
  | { status: 'waiting' }
  | { status: 'paid'; item: HistoryItem }
  | { status: 'different'; item: HistoryItem };

export function matchRequestPayment(
  history: HistoryItem[],
  req: {
    amount: number | null;
    /** The node's chain height when the request was made: only later blocks count. */
    afterHeight: number;
    knownTxids: ReadonlySet<string>;
    ignoreFrom?: ReadonlySet<string>;
  },
): RequestStatus {
  // Both guards matter: the height one works even when this phone's copy of the
  // history was stale or empty when the request was made.
  const fresh = history.filter(
    (h) =>
      h.direction === 'received' &&
      h.height > req.afterHeight &&
      !req.knownTxids.has(h.txid) &&
      !(h.counterparty && req.ignoreFrom?.has(h.counterparty)),
  );
  if (fresh.length === 0) return { status: 'waiting' };
  if (req.amount === null) return { status: 'paid', item: oldest(fresh) };
  const exact = fresh.filter((h) => h.amount === req.amount);
  if (exact.length > 0) return { status: 'paid', item: oldest(exact) };
  return { status: 'different', item: newest(fresh) };
}

function oldest(items: HistoryItem[]): HistoryItem {
  return items.reduce((a, b) => (b.height < a.height || (b.height === a.height && b.time < a.time) ? b : a));
}

function newest(items: HistoryItem[]): HistoryItem {
  return items.reduce((a, b) => (b.height > a.height || (b.height === a.height && b.time > a.time) ? b : a));
}
