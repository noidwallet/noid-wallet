// NOID links: gift cards, payment requests and plain addresses.
//
//   Gift:    https://noidusa.com/g#v=1&k=<gift secret>&a=<NOID>&m=<message>&t=<theme>&f=<from>
//   Request: https://noidusa.com/pay#to=<address>&a=<NOID>&n=<note>
//   In-app:  noid://g?...  noid://pay?...  noid:<address>?amount=<NOID>
//
// The gift secret sits after `#`. Browsers never send that part to a server,
// so the landing page host never sees it. Everything here is pure so it can
// be unit-tested without the phone.

export const GIFT_THEMES = ['vault', 'celebrate', 'thanks', 'birthday'] as const;
export type GiftTheme = (typeof GIFT_THEMES)[number];

export const MAX_GIFT_MESSAGE = 120;
export const MAX_GIFT_FROM = 30;
export const MAX_NOTE = 80;

export type ParsedLink =
  | { kind: 'gift'; secretHex: string; amount?: string; message: string; theme: GiftTheme; from: string }
  | { kind: 'pay'; address: string; amount?: string; note: string }
  | { kind: 'address'; address: string; amount?: string };

const HEX64 = /^[0-9a-f]{64}$/;
const ADDRESS = /^o1[02-9ac-hj-np-z]{20,100}$/;
const AMOUNT = /^\d{1,12}(\.\d{1,6})?$/;

function clean(text: string | null | undefined, max: number): string {
  // Plain text only: drop control characters, collapse whitespace, cap length.
  return (text ?? '')
    .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function amountParam(raw: string | null): string | undefined {
  const a = (raw ?? '').trim();
  return AMOUNT.test(a) && Number(a) > 0 ? a : undefined;
}

function theme(raw: string | null): GiftTheme {
  return (GIFT_THEMES as readonly string[]).includes(raw ?? '') ? (raw as GiftTheme) : 'vault';
}

function params(query: string): URLSearchParams {
  return new URLSearchParams(query.replace(/^[?#]/, ''));
}

export function giftLink(
  base: string,
  g: { secretHex: string; amount: string; message: string; theme: GiftTheme; from: string },
): string {
  const p = new URLSearchParams({ v: '1', k: g.secretHex, a: g.amount, t: g.theme });
  const m = clean(g.message, MAX_GIFT_MESSAGE);
  const f = clean(g.from, MAX_GIFT_FROM);
  if (m) p.set('m', m);
  if (f) p.set('f', f);
  return `${base.replace(/\/+$/, '')}/g#${p.toString()}`;
}

export function payLink(base: string, r: { address: string; amount?: string; note?: string }): string {
  const p = new URLSearchParams({ to: r.address });
  if (r.amount) p.set('a', r.amount);
  const n = clean(r.note, MAX_NOTE);
  if (n) p.set('n', n);
  return `${base.replace(/\/+$/, '')}/pay#${p.toString()}`;
}

/** Short form for QR codes that only NOID wallets read. */
export function payUri(r: { address: string; amount?: string; note?: string }): string {
  const p = new URLSearchParams();
  if (r.amount) p.set('amount', r.amount);
  const n = clean(r.note, MAX_NOTE);
  if (n) p.set('note', n);
  const q = p.toString();
  return `noid:${r.address}${q ? `?${q}` : ''}`;
}

function fromGiftParams(p: URLSearchParams): ParsedLink | null {
  const k = (p.get('k') ?? '').toLowerCase();
  if (!HEX64.test(k) || /^0+$/.test(k)) return null;
  return {
    kind: 'gift',
    secretHex: k,
    amount: amountParam(p.get('a')),
    message: clean(p.get('m'), MAX_GIFT_MESSAGE),
    theme: theme(p.get('t')),
    from: clean(p.get('f'), MAX_GIFT_FROM),
  };
}

function fromPayParams(p: URLSearchParams): ParsedLink | null {
  const to = (p.get('to') ?? '').trim().toLowerCase();
  if (!ADDRESS.test(to)) return null;
  return { kind: 'pay', address: to, amount: amountParam(p.get('a') ?? p.get('amount')), note: clean(p.get('n') ?? p.get('note'), MAX_NOTE) };
}

/**
 * Read anything a user might paste or scan. Returns null for text that is not
 * a NOID link or address. A bare 64-character secret is deliberately NOT
 * accepted as a gift: only a gift link is, so nobody is talked into pasting
 * their own wallet secret somewhere.
 */
export function parseLink(input: string, linkHosts: string[] = ['noidusa.com', 'www.noidusa.com']): ParsedLink | null {
  const text = input.trim();
  if (!text) return null;

  // https://<our host>/g#...  or  /pay#...
  const web = /^https:\/\/([^/?#]+)(\/[^?#]*)?([?#].*)?$/i.exec(text);
  if (web) {
    const host = web[1]!.toLowerCase();
    if (!linkHosts.includes(host)) return null;
    const path = (web[2] ?? '/').replace(/\/+$/, '') || '/';
    const rest = web[3] ?? '';
    if (path === '/g') return fromGiftParams(params(rest));
    if (path === '/pay') return fromPayParams(params(rest));
    return null;
  }

  // noid://g?...  noid://pay?...  (in-app links, e.g. from the landing page)
  const app = /^noid:\/\/(g|gift|pay)\/?([?#].*)?$/i.exec(text);
  if (app) {
    const p = params(app[2] ?? '');
    return app[1]!.toLowerCase() === 'pay' ? fromPayParams(p) : fromGiftParams(p);
  }

  // noid:<address>?amount=..&note=..  or a bare address
  const uri = /^(?:noid:)?(o1[0-9a-z]+)(?:\?(.*))?$/i.exec(text);
  if (uri) {
    const address = uri[1]!.toLowerCase();
    if (!ADDRESS.test(address)) return null;
    const p = params(uri[2] ?? '');
    const amount = amountParam(p.get('amount') ?? p.get('a'));
    const note = clean(p.get('note') ?? p.get('n'), MAX_NOTE);
    if (note) return { kind: 'pay', address, amount, note };
    return { kind: 'address', address, amount };
  }
  return null;
}
