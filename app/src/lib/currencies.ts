// Currencies NOID can show values in. Display only: amounts that move are
// always NOID. Rates come from the wallet server (/v1/price `rates`, units per
// 1 USD); USD needs none.

/**
 * How amounts are written:
 * - cents: always two decimals ($12.50)
 * - big:   two decimals under 100, whole units from 100 up (₦87.60, ₦2,607)
 * - whole: no minor unit in daily use (¥372, ₩5,100)
 */
export type MinorStyle = 'cents' | 'big' | 'whole';

export interface CurrencyInfo {
  /** ISO 4217 code, upper case. Settings store it lower case ('usd'). */
  code: string;
  name: string;
  /** Written before the number; codes without a well-known sign end in a space. */
  symbol: string;
  style: MinorStyle;
}

export const CURRENCIES: readonly CurrencyInfo[] = [
  { code: 'USD', name: 'US dollar', symbol: '$', style: 'cents' },
  { code: 'EUR', name: 'Euro', symbol: '€', style: 'cents' },
  { code: 'GBP', name: 'British pound', symbol: '£', style: 'cents' },
  { code: 'NGN', name: 'Nigerian naira', symbol: '₦', style: 'big' },
  { code: 'CAD', name: 'Canadian dollar', symbol: 'CA$', style: 'cents' },
  { code: 'AUD', name: 'Australian dollar', symbol: 'A$', style: 'cents' },
  { code: 'JPY', name: 'Japanese yen', symbol: '¥', style: 'whole' },
  { code: 'CNY', name: 'Chinese yuan', symbol: 'CN¥', style: 'cents' },
  { code: 'INR', name: 'Indian rupee', symbol: '₹', style: 'big' },
  { code: 'BRL', name: 'Brazilian real', symbol: 'R$', style: 'cents' },
  { code: 'ZAR', name: 'South African rand', symbol: 'R', style: 'cents' },
  { code: 'KES', name: 'Kenyan shilling', symbol: 'KSh ', style: 'big' },
  { code: 'GHS', name: 'Ghanaian cedi', symbol: 'GH₵', style: 'cents' },
  { code: 'EGP', name: 'Egyptian pound', symbol: 'E£', style: 'big' },
  { code: 'MAD', name: 'Moroccan dirham', symbol: 'MAD ', style: 'cents' },
  { code: 'XOF', name: 'West African CFA franc', symbol: 'CFA ', style: 'whole' },
  { code: 'XAF', name: 'Central African CFA franc', symbol: 'FCFA ', style: 'whole' },
  { code: 'UGX', name: 'Ugandan shilling', symbol: 'USh ', style: 'whole' },
  { code: 'TZS', name: 'Tanzanian shilling', symbol: 'TSh ', style: 'whole' },
  { code: 'TRY', name: 'Turkish lira', symbol: '₺', style: 'big' },
  { code: 'AED', name: 'UAE dirham', symbol: 'AED ', style: 'cents' },
  { code: 'SAR', name: 'Saudi riyal', symbol: 'SAR ', style: 'cents' },
  { code: 'CHF', name: 'Swiss franc', symbol: 'CHF ', style: 'cents' },
  { code: 'SEK', name: 'Swedish krona', symbol: 'SEK ', style: 'big' },
  { code: 'NOK', name: 'Norwegian krone', symbol: 'NOK ', style: 'big' },
  { code: 'PLN', name: 'Polish złoty', symbol: 'zł ', style: 'cents' },
  { code: 'MXN', name: 'Mexican peso', symbol: 'MX$', style: 'big' },
  { code: 'KRW', name: 'South Korean won', symbol: '₩', style: 'whole' },
  { code: 'SGD', name: 'Singapore dollar', symbol: 'S$', style: 'cents' },
  { code: 'HKD', name: 'Hong Kong dollar', symbol: 'HK$', style: 'cents' },
  { code: 'PHP', name: 'Philippine peso', symbol: '₱', style: 'big' },
  { code: 'IDR', name: 'Indonesian rupiah', symbol: 'Rp ', style: 'whole' },
  { code: 'PKR', name: 'Pakistani rupee', symbol: 'Rs ', style: 'big' },
  { code: 'VND', name: 'Vietnamese dong', symbol: '₫', style: 'whole' },
  { code: 'THB', name: 'Thai baht', symbol: '฿', style: 'big' },
  { code: 'MYR', name: 'Malaysian ringgit', symbol: 'RM ', style: 'cents' },
  { code: 'RUB', name: 'Russian ruble', symbol: '₽', style: 'big' },
  { code: 'UAH', name: 'Ukrainian hryvnia', symbol: '₴', style: 'big' },
  { code: 'ARS', name: 'Argentine peso', symbol: 'AR$', style: 'big' },
  { code: 'COP', name: 'Colombian peso', symbol: 'COL$', style: 'whole' },
  { code: 'NZD', name: 'New Zealand dollar', symbol: 'NZ$', style: 'cents' },
];

/** Shown first in the picker. */
export const POPULAR = ['USD', 'EUR', 'GBP', 'NGN'];

const BY_CODE = new Map(CURRENCIES.map((c) => [c.code, c]));

/** Info for a stored setting ('ngn', 'usd'...), or null for 'none' / unknown. */
export function currencyInfo(setting: string | undefined | null): CurrencyInfo | null {
  if (!setting || setting === 'none') return null;
  return BY_CODE.get(setting.toUpperCase()) ?? null;
}

export interface PriceLike {
  usd: number;
  ngn: number | null;
  rates?: Record<string, number>;
  ageMs?: number;
  receivedAt?: number;
}

/** Typing amounts in a currency needs a recent price; showing "≈" values does not. */
export const PRICE_FRESH_MS = 15 * 60_000;

/** Is this price recent enough to convert typed currency into NOID? */
export function priceIsFresh(price: PriceLike | null, now: number): boolean {
  if (!price) return false;
  if (price.receivedAt === undefined) return true; // tests and older callers
  return (price.ageMs ?? 0) + Math.max(0, now - price.receivedAt) < PRICE_FRESH_MS;
}

/** Value of 1 NOID in the chosen currency, or null when it isn't available. */
export function perNoid(price: PriceLike | null, setting: string | undefined | null): number | null {
  const info = currencyInfo(setting);
  if (!price || !info || !(price.usd > 0) || !Number.isFinite(price.usd)) return null;
  if (info.code === 'USD') return price.usd;
  const rate = price.rates?.[info.code];
  if (typeof rate === 'number' && Number.isFinite(rate) && rate > 0) return price.usd * rate;
  // Servers from before `rates` only sent the naira value.
  if (info.code === 'NGN' && price.ngn && Number.isFinite(price.ngn) && price.ngn > 0) return price.ngn;
  return null;
}

function withCommas(s: string): string {
  const [int, dec] = s.split('.');
  const grouped = int!.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return dec ? `${grouped}.${dec}` : grouped;
}

function decimalsFor(info: CurrencyInfo, value: number): number {
  if (info.style === 'whole') return 0;
  if (info.style === 'big') return value < 100 ? 2 : 0;
  return 2;
}

/** "$12.50", "₦2,607", "¥372" for a value already in that currency (no "≈"). */
export function formatMoney(value: number, info: CurrencyInfo): string {
  return `${info.symbol}${withCommas(value.toFixed(decimalsFor(info, value)))}`;
}

/**
 * "≈ $1.23" / "≈ ₦1,840" / "< ¥1" for an amount in μNOID, or null when there
 * is no price for the chosen currency.
 */
export function fiatValue(micro: number, price: PriceLike | null, setting: string | undefined | null): string | null {
  const info = currencyInfo(setting);
  const per = perNoid(price, setting);
  if (!info || per === null) return null;
  const value = (micro / 1_000_000) * per;
  if (value === 0) return `${info.symbol}0`;
  const smallest = info.style === 'cents' ? 0.01 : 1;
  if (value < smallest) return `< ${info.symbol}${info.style === 'cents' ? '0.01' : '1'}`;
  return `≈ ${formatMoney(value, info)}`;
}

/**
 * What the user typed in a currency field. Countries write numbers differently
 * ("1,500.50" vs "1.500,50"), and guessing wrong is a 1000x mistake, so:
 * - plain digits, with one "." or "," as the decimal point: "5000", "12.5", "12,50"
 * - full grouping that can only mean thousands: "1,250,000", "1.250.000,75", "12,500.00"
 * - refused (null): one separator followed by exactly three digits ("1.500", "12,500"),
 *   which could be either thousands or decimals.
 */
export function parseMoney(input: string): number | null {
  const s = input.trim().replace(/\s/g, '');
  if (s === '' || !/^[\d.,]+$/.test(s)) return null;
  const dots = (s.match(/\./g) ?? []).length;
  const commas = (s.match(/,/g) ?? []).length;
  let normal: string;
  if (dots === 0 && commas === 0) {
    normal = s;
  } else if (dots > 0 && commas > 0) {
    // Both used: the last one is the decimal point, the other groups thousands.
    const dec = s.lastIndexOf('.') > s.lastIndexOf(',') ? '.' : ',';
    const grp = dec === '.' ? ',' : '.';
    const [intPart, frac, extra] = s.split(dec);
    if (extra !== undefined || !frac || !new RegExp(`^\\d{1,3}(\\${grp}\\d{3})+$`).test(intPart!)) return null;
    normal = `${intPart!.split(grp).join('')}.${frac}`;
  } else {
    const sep = dots > 0 ? '.' : ',';
    const parts = s.split(sep);
    if (parts.length > 2) {
      // The same mark more than once can only group thousands.
      if (!new RegExp(`^\\d{1,3}(\\${sep}\\d{3})+$`).test(s)) return null;
      normal = parts.join('');
    } else {
      const [intPart, frac] = parts as [string, string];
      if (frac.length === 3) return null; // "1.500" or "12,500": thousands or decimals? Ask instead.
      if (!frac && !intPart) return null;
      // Mid-typing "12." counts as 12, and ".5" as 0.5.
      normal = frac ? `${intPart || '0'}.${frac}` : intPart;
    }
  }
  if (!/^\d+(\.\d+)?$/.test(normal)) return null;
  const v = Number(normal);
  return Number.isFinite(v) && v >= 0 ? v : null;
}

/** An amount of currency as an editable string (no grouping): "12.5", "2607". */
export function moneyInputText(value: number, info: CurrencyInfo): string {
  return value.toFixed(decimalsFor(info, value)).replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
}
