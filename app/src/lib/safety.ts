// Address safety checks shown before a send, and fiat display formatting.
// Pure functions; unit-tested.

export interface NamedAddress {
  name: string;
  address: string;
}

export type AddressCheck =
  | { kind: 'contact'; name: string }
  /** Same start and end as an address you know, but different in the middle: the classic poisoning trick. */
  | { kind: 'lookalike'; similarTo: string; name: string | null }
  | { kind: 'known' }
  | { kind: 'new' };

/**
 * Two different addresses look alike when their ends are close: at least 3
 * of the first 6 and 3 of the last 6 characters match by position, or 4+
 * leading or trailing characters match exactly. For random addresses that
 * happens by chance less than once in a million pairs; an attacker who
 * mines a look-alike has to beat it.
 */
export function looksAlike(a: string, b: string): boolean {
  if (a === b) return false;
  const x = a.slice(2);
  const y = b.slice(2);
  const same = (i: number, j: number) => x[i] !== undefined && x[i] === y[j];
  let head = 0;
  let tail = 0;
  for (let i = 0; i < 6; i++) {
    if (same(i, i)) head++;
    if (same(x.length - 1 - i, y.length - 1 - i)) tail++;
  }
  let prefix = 0;
  while (prefix < Math.min(x.length, y.length) && x[prefix] === y[prefix]) prefix++;
  let suffix = 0;
  while (suffix < Math.min(x.length, y.length) && x[x.length - 1 - suffix] === y[y.length - 1 - suffix]) suffix++;
  // 4 leading or trailing characters is what a short "o1ab…wxyz" display shows.
  return (head >= 3 && tail >= 3) || prefix >= 4 || suffix >= 4;
}

/**
 * @param contacts saved contacts
 * @param sentTo addresses this wallet has sent to (NOT ones that only paid
 *   you: anyone can make their address "known" by sending you dust)
 */
export function checkAddress(address: string, contacts: NamedAddress[], sentTo: string[]): AddressCheck {
  const similarContact = contacts.find((c) => looksAlike(address, c.address));
  const contact = contacts.find((c) => c.address === address);
  // Even an exact contact is checked against the others, in case a poisoned
  // address was saved as a contact earlier.
  if (contact && !similarContact) return { kind: 'contact', name: contact.name };
  if (similarContact) return { kind: 'lookalike', similarTo: similarContact.address, name: similarContact.name };
  const similarSent = sentTo.find((k) => looksAlike(address, k));
  if (similarSent) return { kind: 'lookalike', similarTo: similarSent, name: null };
  if (sentTo.includes(address)) return { kind: 'known' };
  return { kind: 'new' };
}

/** Split an address into groups of 4 so it is easier to compare by eye. */
export function groupAddress(address: string): string {
  return address.replace(/(.{4})/g, '$1 ').trim();
}

export type Currency = 'none' | 'usd' | 'ngn';

function withCommas(s: string): string {
  const [int, dec] = s.split('.');
  const grouped = int!.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return dec ? `${grouped}.${dec}` : grouped;
}

/** "≈ $1.23" / "≈ ₦1,840" for an amount in μNOID, or null when there is no price. */
export function fiat(micro: number, price: { usd: number; ngn: number | null } | null, currency: Currency): string | null {
  if (!price || currency === 'none') return null;
  const perNoid = currency === 'usd' ? price.usd : price.ngn;
  if (!perNoid || !Number.isFinite(perNoid)) return null;
  const value = (micro / 1_000_000) * perNoid;
  const symbol = currency === 'usd' ? '$' : '₦';
  if (value === 0) return `${symbol}0`;
  const smallest = currency === 'usd' ? 0.01 : 1;
  if (value < smallest) return `< ${symbol}${currency === 'usd' ? '0.01' : '1'}`;
  const decimals = currency === 'usd' || value < 100 ? 2 : 0;
  return `≈ ${symbol}${withCommas(value.toFixed(decimals))}`;
}
