// Typing an amount in a currency (₦5,000) turns it into NOID with the price
// the wallet server sends. A dishonest or hacked server could send a price far
// too low, so "₦5,000" would become a much larger NOID amount. This guard keeps
// an anchor (on the phone): the value of 1 NOID per currency it trusted, which
// moves at most once a day. Typed-currency entry is refused when the price is
// more than 50% off the anchor, until that new value has held steady for a
// whole day (real markets do move). Stepping the price down a little each
// refresh does not work: the anchor doesn't follow until a day has passed.
//
// The review screen still shows the NOID amount and warns when a payment is a
// large share of the balance; amounts typed in NOID are never affected.

export interface GuardEntry {
  /** The anchor: value of 1 NOID this phone trusts. */
  per: number;
  /** When the anchor was set. */
  at: number;
  /** A far-off value seen since `since`, waiting to be believed. */
  candidate?: { per: number; since: number };
}
export type GuardState = Record<string, GuardEntry>;

/** More than this move from the anchor needs time to be believed. */
const MAX_MOVE = 0.5;
/** The anchor follows an accepted price at most this often. */
const ANCHOR_MS = 24 * 3600_000;
/** A far-off value must stay within this of itself... */
const AGREE = 0.1;
/** ...for this long. */
const CONFIRM_MS = 24 * 3600_000;

function within(a: number, b: number, share: number) {
  return Math.abs(a / b - 1) <= share;
}

/** Is `per` (value of 1 NOID in `currency`) safe for typed amounts? Pure; returns the new state to save. */
export function judgePrice(state: GuardState, currency: string, per: number, now: number): { ok: boolean; next: GuardState } {
  if (!(per > 0) || !Number.isFinite(per)) return { ok: false, next: state };
  const entry = state[currency];
  const anchor = (): GuardState => ({ ...state, [currency]: { per, at: now } });
  if (!entry || !(entry.per > 0) || !Number.isFinite(entry.at)) return { ok: true, next: anchor() };
  if (within(per, entry.per, MAX_MOVE)) {
    if (now - entry.at >= ANCHOR_MS) return { ok: true, next: anchor() };
    // Close enough: usable, but the anchor stays put (and any far-off candidate is dropped).
    if (!entry.candidate) return { ok: true, next: state };
    return { ok: true, next: { ...state, [currency]: { per: entry.per, at: entry.at } } };
  }
  const cand = entry.candidate;
  if (cand && within(per, cand.per, AGREE)) {
    if (now - cand.since >= CONFIRM_MS) return { ok: true, next: anchor() };
    return { ok: false, next: state };
  }
  return { ok: false, next: { ...state, [currency]: { ...entry, candidate: { per, since: now } } } };
}
