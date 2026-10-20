// NOID price in USD (from SafeTrade's public Peatio API) and NGN (USD rate
// from a public FX feed). Display only: the wallet never uses these numbers
// to decide amounts or fees.

export interface Price {
  usd: number;
  ngn: number | null;
  source: string;
  updatedAt: number;
}

type FetchJson = (url: string) => Promise<unknown>;

/** SafeTrade runs OpenDAX/Peatio; current and legacy public API bases. */
export const SAFETRADE_BASES = [
  "https://safetrade.com/api/v2/trade/public",
  "https://safe.trade/api/v2/trade/public",
  "https://safetrade.com/api/v2/peatio/public",
  "https://safe.trade/api/v2/peatio/public",
];
/**
 * Fallback: CoinPaprika mirrors SafeTrade's NOID markets and has a free,
 * keyless API. SafeTrade's own API sits behind a bot wall that refuses
 * server requests from many networks.
 */
export const PAPRIKA_MARKETS_URL = "https://api.coinpaprika.com/v1/coins/noid-parano1d/markets";
/** A mirrored market quote older than this is not trusted as "current". */
const PAPRIKA_MAX_AGE_MS = 2 * 60 * 60_000;
const FX_URL = "https://open.er-api.com/v6/latest/USD";
const USD_LIKE = new Set(["usdt", "usdc", "usd"]);

interface Market {
  id?: string;
  base_unit?: string;
  quote_unit?: string;
}

/** Anything outside this range is treated as a broken feed, not a price. */
const MIN_USD = 1e-9;
const MAX_USD = 1e6;
/** A move bigger than this from the last good price must be seen twice in a row. */
const MAX_JUMP = 0.5;

export function sanePrice(n: number | null | undefined): n is number {
  return typeof n === "number" && Number.isFinite(n) && n >= MIN_USD && n <= MAX_USD;
}

function lastPrice(tickers: Record<string, unknown>, marketId: string): number | null {
  const entry = tickers[marketId] as { ticker?: { last?: unknown }; last?: unknown } | undefined;
  const raw = entry?.ticker?.last ?? entry?.last;
  const n = typeof raw === "string" ? Number(raw) : typeof raw === "number" ? raw : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** NOID price in USD from Peatio markets + tickers. Pure; unit-tested. */
export function noidUsdFromPeatio(markets: unknown, tickers: unknown): number | null {
  if (!Array.isArray(markets) || !tickers || typeof tickers !== "object") return null;
  const t = tickers as Record<string, unknown>;
  const noidMarkets = (markets as Market[]).filter((m) => (m.base_unit ?? "").toLowerCase() === "noid" && m.id);
  // Prefer a direct USD-like pair; otherwise convert through quote/usdt.
  for (const m of noidMarkets) {
    if (USD_LIKE.has((m.quote_unit ?? "").toLowerCase())) {
      const p = lastPrice(t, m.id!);
      if (sanePrice(p)) return p;
    }
  }
  for (const m of noidMarkets) {
    const quote = (m.quote_unit ?? "").toLowerCase();
    const p = lastPrice(t, m.id!);
    const conv = lastPrice(t, `${quote}usdt`);
    if (p && conv && sanePrice(p * conv)) return p * conv;
  }
  return null;
}

interface PaprikaMarket {
  exchange_name?: string;
  pair?: string;
  last_updated?: string;
  quotes?: { USD?: { price?: unknown; volume_24h?: unknown } };
}

/**
 * NOID price in USD from CoinPaprika's market list: the most traded NOID
 * market quoted in the last two hours, preferring NOID/USDT. Pure; unit-tested.
 */
export function noidUsdFromPaprika(markets: unknown, now: number): number | null {
  if (!Array.isArray(markets)) return null;
  const usable = (markets as PaprikaMarket[])
    .map((m) => ({
      pair: (m.pair ?? "").toUpperCase(),
      price: Number(m.quotes?.USD?.price),
      volume: Number(m.quotes?.USD?.volume_24h) || 0,
      at: Date.parse(m.last_updated ?? ""),
    }))
    .filter((m) => m.pair.startsWith("NOID/") && sanePrice(m.price) && Number.isFinite(m.at) && now - m.at <= PAPRIKA_MAX_AGE_MS && m.at - now < 5 * 60_000);
  if (usable.length === 0) return null;
  usable.sort((a, b) => Number(b.pair === "NOID/USDT") - Number(a.pair === "NOID/USDT") || b.volume - a.volume);
  return usable[0]?.price ?? null;
}

async function defaultFetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, {
    headers: { accept: "application/json", "user-agent": "Mozilla/5.0 (noid-wallet-server)" },
    signal: AbortSignal.timeout(8_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
  return res.json();
}

export class PriceFeed {
  private cached: Price | null = null;
  private inflight: Promise<Price | null> | null = null;
  private retryAfter = 0;
  /** A large jump waits here until a second fetch agrees with it. */
  private suspect: number | null = null;
  private readonly fetchJson: FetchJson;
  private readonly ttlMs: number;
  private readonly maxStaleMs: number;

  constructor(
    private readonly opts: {
      fetchJson?: FetchJson;
      ttlMs?: number;
      /** Serve the last good price this long when the sources are down. */
      maxStaleMs?: number;
      bases?: string[];
      paprikaUrl?: string;
      log?: (msg: string) => void;
      now?: () => number;
    } = {},
  ) {
    this.fetchJson = opts.fetchJson ?? defaultFetchJson;
    this.ttlMs = opts.ttlMs ?? 120_000;
    this.maxStaleMs = opts.maxStaleMs ?? 30 * 60_000;
  }

  private now() {
    return this.opts.now?.() ?? Date.now();
  }

  /**
   * Serves the cached price at once while a refresh runs in the background
   * (no request waits on a slow exchange), and only waits when nothing is
   * cached yet. After a failure it waits a minute before trying again.
   */
  async get(): Promise<Price | null> {
    const fresh = this.cached !== null && this.now() - this.cached.updatedAt < this.ttlMs;
    if (!fresh && this.now() >= this.retryAfter) {
      this.inflight ??= this.refresh().finally(() => {
        this.inflight = null;
      });
    }
    if (this.cached && this.now() - this.cached.updatedAt < this.maxStaleMs) return this.cached;
    return this.inflight ?? null;
  }

  private async refresh(): Promise<Price | null> {
    try {
      const got = await this.fetchUsd();
      let usd = got.usd;
      const last = this.cached?.usd ?? null;
      if (last !== null && Math.abs(usd - last) / last > MAX_JUMP) {
        // One odd trade on a thin market should not move every wallet's display:
        // accept a big jump only when the next fetch confirms it.
        const confirmed = this.suspect !== null && Math.abs(usd - this.suspect) / this.suspect <= 0.1;
        if (!confirmed) {
          this.suspect = usd;
          usd = last;
        } else this.suspect = null;
      } else this.suspect = null;
      const rate = await this.fetchNgnRate().catch(() => null);
      const ngn = rate ? usd * rate : null;
      this.cached = { usd, ngn: ngn !== null && Number.isFinite(ngn) && ngn > 0 ? ngn : null, source: got.source, updatedAt: this.now() };
      return this.cached;
    } catch (e) {
      this.opts.log?.(`price: ${(e as Error).message}`);
      this.retryAfter = this.now() + 60_000;
      if (this.cached && this.now() - this.cached.updatedAt < this.maxStaleMs) return this.cached;
      return null;
    }
  }

  private async fetchUsd(): Promise<{ usd: number; source: string }> {
    const errors: string[] = [];
    for (const base of this.opts.bases ?? SAFETRADE_BASES) {
      try {
        const [markets, tickers] = await Promise.all([
          this.fetchJson(`${base}/markets?limit=1000`),
          this.fetchJson(`${base}/markets/tickers`),
        ]);
        const usd = noidUsdFromPeatio(markets, tickers);
        if (usd) return { usd, source: "SafeTrade" };
        errors.push(`${new URL(base).host}: no NOID market`);
      } catch (e) {
        errors.push((e as Error).message);
      }
    }
    try {
      const usd = noidUsdFromPaprika(await this.fetchJson(this.opts.paprikaUrl ?? PAPRIKA_MARKETS_URL), this.now());
      if (usd) return { usd, source: "SafeTrade via CoinPaprika" };
      errors.push("coinpaprika: no recent NOID market");
    } catch (e) {
      errors.push((e as Error).message);
    }
    throw new Error(errors.join("; "));
  }

  private async fetchNgnRate(): Promise<number | null> {
    const fx = (await this.fetchJson(FX_URL)) as { result?: string; rates?: Record<string, number> };
    const r = fx?.rates?.NGN;
    // Sanity range for naira per dollar.
    return fx?.result === "success" && typeof r === "number" && Number.isFinite(r) && r > 10 && r < 1e6 ? r : null;
  }
}
