// Token amounts (Parano1d v2.1). Like NOID, tokens have 6 decimal places, but
// balances can exceed what a JavaScript number holds exactly, so everything
// here works on BigInt and decimal strings.

export const TOKEN_DECIMALS = 6;
const SCALE = 1_000_000n;

/** Decimal integer string from the core (no sign, no leading zeros). */
export function toBig(units: string): bigint | null {
  return /^(0|[1-9]\d{0,38})$/.test(units) ? BigInt(units) : null;
}

/** 1500000n -> "1.5"; with groups: 1234000000n -> "1,234". */
export function formatUnits(units: bigint | string, opts: { maxDecimals?: number } = {}): string {
  const v = typeof units === 'string' ? toBig(units) : units;
  if (v === null || v < 0n) return '?';
  const whole = (v / SCALE).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  let frac = (v % SCALE).toString().padStart(TOKEN_DECIMALS, '0');
  if (opts.maxDecimals !== undefined) frac = frac.slice(0, opts.maxDecimals);
  frac = frac.replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole;
}

/**
 * What `units` of a token are worth in μNOID at a price of
 * numerator / denominator NOID base units per token base unit (rounded down).
 * Null when the price is missing or the result is too large to show.
 */
export function noidValue(units: string, numerator: string, denominator: string): number | null {
  const u = toBig(units);
  const n = toBig(numerator);
  const d = toBig(denominator);
  if (u === null || n === null || d === null || d === 0n) return null;
  const v = (u * n) / d;
  return v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : null;
}

/** NOID per whole token, for display: "0.003333". */
export function unitPrice(numerator: string, denominator: string): string | null {
  const n = toBig(numerator);
  const d = toBig(denominator);
  if (n === null || d === null || d === 0n) return null;
  // Both sides have 6 decimals, so the ratio is already NOID per token.
  const micro = (n * SCALE) / d;
  return formatUnits(micro, { maxDecimals: 6 });
}

/** "ab12cd34…9f0e1d2c" */
export function shortId(hex: string): string {
  return hex.length > 20 ? `${hex.slice(0, 8)}…${hex.slice(-8)}` : hex;
}

/** One NFT's key in routes and lists. */
export function nftKey(collection: string, serial: string): string {
  return `${collection}-${serial}`;
}
