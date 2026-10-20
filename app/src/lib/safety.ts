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

const EDGE = 4;

function looksAlike(a: string, b: string): boolean {
  if (a === b) return false;
  const x = a.slice(2);
  const y = b.slice(2);
  return x.slice(0, EDGE) === y.slice(0, EDGE) && x.slice(-EDGE) === y.slice(-EDGE);
}

/**
 * @param contacts saved contacts
 * @param known addresses this wallet has sent to or received from
 */
export function checkAddress(address: string, contacts: NamedAddress[], known: string[]): AddressCheck {
  const contact = contacts.find((c) => c.address === address);
  if (contact) return { kind: 'contact', name: contact.name };
  const similarContact = contacts.find((c) => looksAlike(address, c.address));
  if (similarContact) return { kind: 'lookalike', similarTo: similarContact.address, name: similarContact.name };
  const similarKnown = known.find((k) => looksAlike(address, k));
  if (similarKnown) return { kind: 'lookalike', similarTo: similarKnown, name: null };
  if (known.includes(address)) return { kind: 'known' };
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
