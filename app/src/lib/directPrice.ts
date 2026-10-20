// Fallback for the NOID price when the wallet server can't get it. Price sites
// often refuse requests from data-centre servers but answer phones, so the
// phone asks CoinPaprika for the NOID price itself and takes only the exchange
// rates from the wallet server (/v1/fx). Display only, like every price: the
// wallet never uses it to decide what is sent.
//
// CoinPaprika sees this phone's IP address asking for the NOID price, nothing
// else: no address, balance or wallet data goes with it. It is only used while
// a display currency is chosen.

import type { Price } from './api';

export const PAPRIKA_MARKETS_URL = 'https://api.coinpaprika.com/v1/coins/noid-parano1d/markets';
export const DIRECT_SOURCE = 'CoinPaprika (from this phone)';

/** Ask CoinPaprika at most this often; in between the last answer is reused. */
const PRICE_TTL_MS = 2 * 60_000;
/** After a failed try, wait this long before the next. */
const RETRY_MS = 2 * 60_000;
/** Rates change slowly: ask the server for them hourly, keep an older copy up to a day. */
const FX_TTL_MS = 60 * 60_000;
const FX_MAX_AGE_MS = 24 * 60 * 60_000;
/** A mirrored market quote older than this is not "current". */
const MARKET_MAX_AGE_MS = 2 * 60 * 60_000;
/** A move bigger than this from the last good price must be seen twice in a row. */
const MAX_JUMP = 0.5;

export function sanePrice(n: number | null | undefined): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n >= 1e-9 && n <= 1e6;
}

interface PaprikaMarket {
  pair?: string;
  last_updated?: string;
  quotes?: { USD?: { price?: unknown; volume_24h?: unknown } };
}

/**
 * NOID in USD from CoinPaprika's market list: the most traded NOID market
 * quoted in the last two hours, preferring NOID/USDT. Same rule as the server.
 */
export function noidUsdFromPaprika(markets: unknown, now: number): number | null {
  if (!Array.isArray(markets)) return null;
  const usable = (markets as PaprikaMarket[])
    .map((m) => ({
      pair: (m.pair ?? '').toUpperCase(),
      price: Number(m.quotes?.USD?.price),
      volume: Number(m.quotes?.USD?.volume_24h) || 0,
      at: Date.parse(m.last_updated ?? ''),
    }))
    .filter(
      (m) =>
        m.pair.startsWith('NOID/') &&
        sanePrice(m.price) &&
        Number.isFinite(m.at) &&
        now - m.at <= MARKET_MAX_AGE_MS &&
        // A phone clock a little behind is fine; a quote far in the future is not.
        m.at - now < 30 * 60_000,
    );
  if (usable.length === 0) return null;
  usable.sort((a, b) => Number(b.pair === 'NOID/USDT') - Number(a.pair === 'NOID/USDT') || b.volume - a.volume);
  return usable[0]?.price ?? null;
}

/** Units per 1 USD; anything that isn't a sane positive number is dropped. */
function cleanRates(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [code, v] of Object.entries(raw as Record<string, unknown>)) {
    if (/^[A-Z]{3}$/.test(code) && typeof v === 'number' && Number.isFinite(v) && v > 1e-3 && v < 1e6) out[code] = v;
  }
  return out;
}

async function defaultFetchJson(url: string): Promise<unknown> {
  // Hermes may not ship AbortSignal.timeout.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    const res = await fetch(url, { headers: { accept: 'application/json' }, signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

export type FxSource = () => Promise<{ rates: Record<string, number> } | null>;

export function createDirectPrice(opts: { fetchJson?: (url: string) => Promise<unknown>; now?: () => number } = {}) {
  const fetchJson = opts.fetchJson ?? defaultFetchJson;
  const now = opts.now ?? Date.now;
  let last: { usd: number; at: number } | null = null;
  let suspect: number | null = null;
  let retryAfter = 0;
  let fx: { rates: Record<string, number>; at: number } | null = null;
  let fxRetryAfter = 0;
  let inflight: Promise<Price | null> | null = null;

  async function rates(getFx: FxSource): Promise<Record<string, number>> {
    const t = now();
    if (fx && t - fx.at < FX_TTL_MS) return fx.rates;
    if (t >= fxRetryAfter) {
      try {
        const got = cleanRates((await getFx())?.rates);
        if (Object.keys(got).length > 0) {
          fx = { rates: got, at: t };
          return got;
        }
      } catch {
        // Older servers have no /v1/fx: USD still works.
      }
      fxRetryAfter = t + 5 * 60_000;
    }
    return fx && t - fx.at < FX_MAX_AGE_MS ? fx.rates : {};
  }

  async function usd(): Promise<{ usd: number; at: number } | null> {
    const t = now();
    if (last && t - last.at < PRICE_TTL_MS) return last;
    if (t < retryAfter) return last && t - last.at < 30 * 60_000 ? last : null;
    try {
      let got = noidUsdFromPaprika(await fetchJson(PAPRIKA_MARKETS_URL), t);
      if (!got) throw new Error('no recent NOID market');
      if (last && Math.abs(got - last.usd) / last.usd > MAX_JUMP) {
        // One odd trade on a thin market shouldn't move the display: a big
        // jump counts only when the next answer agrees with it.
        const confirmed = suspect !== null && Math.abs(got - suspect) / suspect <= 0.1;
        suspect = confirmed ? null : got;
        if (!confirmed) got = last.usd;
      } else suspect = null;
      last = { usd: got, at: t };
      return last;
    } catch {
      retryAfter = t + RETRY_MS;
      // The last good price is still worth showing for a while; it carries its age.
      return last && t - last.at < 30 * 60_000 ? last : null;
    }
  }

  async function load(getFx: FxSource): Promise<Price | null> {
    const [p, r] = await Promise.all([usd(), rates(getFx)]);
    if (!p) return null;
    const ngn = r.NGN ? p.usd * r.NGN : null;
    return {
      usd: p.usd,
      ngn: ngn !== null && Number.isFinite(ngn) && ngn > 0 ? ngn : null,
      rates: r,
      source: DIRECT_SOURCE,
      updatedAt: p.at,
      ageMs: Math.max(0, now() - p.at),
    };
  }

  return {
    /** The NOID price fetched by this phone, with the server's rates; null when unavailable. */
    get(getFx: FxSource): Promise<Price | null> {
      inflight ??= load(getFx).finally(() => {
        inflight = null;
      });
      return inflight;
    },
  };
}
