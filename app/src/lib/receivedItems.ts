// What a received token or NFT row says ("Received 3 NEMO").
//
// The row only carries IDs and amounts from the wallet server. Names and
// tickers come from the token's or NFT's checked metadata on this phone, and
// are chosen by whoever created the token, so anything that could pass for
// NOID is never shown as a name here.
import type { HistoryItem } from './api';
import { formatUnits, looksLikeNoid } from './tokenMath';

export interface ItemLookup {
  /** Checked name and ticker of a token, when this phone knows them. */
  token(assetId: string): { name: string | null; symbol: string | null } | null;
  /** Checked name of an NFT, when this phone knows it. */
  nft(collection: string, serial: string): { name: string | null } | null;
}

export function isArrival(h: Pick<HistoryItem, 'direction'>): boolean {
  return h.direction === 'token_in' || h.direction === 'nft_in';
}

/** "Received 3 NEMO", "Received NFT: Night Garden #7", "Received 2 NFTs", "Received a token". */
export function receivedLabel(
  h: Pick<HistoryItem, 'direction' | 'itemId' | 'itemUnits' | 'itemCount'>,
  lookup: ItemLookup,
  opts: { hidden?: boolean } = {},
): string {
  if (h.direction === 'token_in') {
    const t = h.itemId ? lookup.token(h.itemId) : null;
    if (!t) return 'Received a token';
    if (looksLikeNoid(t.name, t.symbol)) return 'Received a token (not NOID)';
    // Balance hidden: say which token, not how much.
    if (t.symbol && opts.hidden) return `Received ${t.symbol}`;
    if (t.symbol && h.itemUnits) return `Received ${formatUnits(h.itemUnits, { maxDecimals: 4 })} ${t.symbol}`;
    return 'Received a token';
  }
  if (h.direction === 'nft_in') {
    const count = h.itemCount ?? 1;
    if (count > 1) return `Received ${count} NFTs`;
    const n = h.itemId && h.itemUnits ? lookup.nft(h.itemId, h.itemUnits) : null;
    // Always say it's an NFT: a name like "50,000 USDT" must not read as a payment.
    if (n?.name && !looksLikeNoid(n.name, null)) return `Received NFT: ${n.name}`;
    return 'Received an NFT';
  }
  return 'Received';
}

/** The row's second line: what kind of thing arrived, then when. */
export function arrivalKind(h: Pick<HistoryItem, 'direction'>): string {
  return h.direction === 'nft_in' ? 'NFT' : 'Token';
}
