// Diagnose the NOID price feed from this machine: which SafeTrade API base
// answers, whether it lists a NOID market, and whether the naira rate loads.
// Run: npm run price-check
import { PAPRIKA_MARKETS_URL, PriceFeed, SAFETRADE_BASES, noidUsdFromPaprika, noidUsdFromPeatio } from "../src/price.js";

const UA = "Mozilla/5.0 (noid-wallet-server)";

async function get(url: string): Promise<{ status: string; json: unknown }> {
  try {
    const res = await fetch(url, { headers: { accept: "application/json", "user-agent": UA }, signal: AbortSignal.timeout(10_000) });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      return { status: `HTTP ${res.status}, not JSON: ${text.slice(0, 80).replace(/\s+/g, " ")}`, json: null };
    }
    return { status: `HTTP ${res.status}`, json };
  } catch (e) {
    const err = e as Error & { cause?: { code?: string; message?: string } };
    return { status: `failed: ${err.cause?.code ?? err.cause?.message ?? err.message}`, json: null };
  }
}

for (const base of SAFETRADE_BASES) {
  const m = await get(`${base}/markets?limit=1000`);
  const t = await get(`${base}/markets/tickers`);
  const markets = Array.isArray(m.json) ? (m.json as { id?: string; base_unit?: string }[]) : [];
  const noid = markets.filter((x) => (x.base_unit ?? "").toLowerCase() === "noid").map((x) => x.id);
  const usd = noidUsdFromPeatio(m.json, t.json);
  console.log(`\n${base}`);
  console.log(`  markets: ${m.status}${markets.length ? `, ${markets.length} markets, NOID pairs: ${noid.join(", ") || "none"}` : ""}`);
  console.log(`  tickers: ${t.status}`);
  console.log(`  NOID price: ${usd ? `$${usd}` : "not found"}`);
  if (usd) break;
}

const pap = await get(PAPRIKA_MARKETS_URL);
const papUsd = noidUsdFromPaprika(pap.json, Date.now());
console.log(`\nCoinPaprika fallback: ${pap.status}, NOID price: ${papUsd ? `$${papUsd}` : "not found"}`);

const fx = await get("https://open.er-api.com/v6/latest/USD");
const ngn = (fx.json as { rates?: { NGN?: number } } | null)?.rates?.NGN;
console.log(`\nNaira rate: ${fx.status}${ngn ? `, 1 USD = ${ngn} NGN` : ""}`);

const p = await new PriceFeed().get();
console.log(`\nWhat the wallet will show: ${p ? `$${p.usd.toFixed(4)}${p.ngn ? ` / ₦${p.ngn.toFixed(2)}` : ""} (source: ${p.source})` : "no price"}`);
