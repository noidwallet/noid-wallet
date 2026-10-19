// NOID amounts are integers in μNOID (1 NOID = 1,000,000 μNOID).
// Parsing never goes through floating point.

export const MICRO = 1_000_000;

/**
 * "1.5" or "1,5" -> 1500000. A comma is read as the decimal point, because
 * phones set to comma-decimal regions only offer "," on the number pad.
 * Thousands separators are not accepted, so "1,500" can never become 1500.
 * Returns null for invalid input or more than 6 decimals.
 */
export function parseNoid(input: string): number | null {
  const raw = input.trim().replace(/\s/g, '');
  if (raw.includes(',') && raw.includes('.')) return null;
  if ((raw.match(/,/g) ?? []).length > 1) return null;
  const s = raw.replace(',', '.');
  if (!/^\d*(\.\d{0,6})?$/.test(s) || s === '' || s === '.') return null;
  const [whole = '0', frac = ''] = s.split('.');
  const micro = BigInt(whole || '0') * 1_000_000n + BigInt((frac + '000000').slice(0, 6));
  if (micro > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(micro);
}

/** 1500000 -> "1.5", 5000 -> "0.005" */
export function formatNoid(micro: number, opts: { maxDecimals?: number } = {}): string {
  const negative = micro < 0;
  const v = BigInt(Math.abs(Math.trunc(micro)));
  const whole = v / 1_000_000n;
  let frac = (v % 1_000_000n).toString().padStart(6, '0');
  if (opts.maxDecimals !== undefined) frac = frac.slice(0, opts.maxDecimals);
  frac = frac.replace(/0+$/, '');
  const wholeStr = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}${wholeStr}${frac ? '.' + frac : ''}`;
}

export function shortAddress(address: string, chars = 6): string {
  return address.length <= chars * 2 + 3 ? address : `${address.slice(0, chars + 2)}…${address.slice(-chars)}`;
}
