export const config = {
  /** Parano1d node JSON-RPC. Keep the node bound to loopback. */
  rpcUrl: process.env.NOID_RPC_URL ?? "http://127.0.0.1:9601",
  host: process.env.HOST ?? "127.0.0.1",
  port: Number(process.env.PORT ?? 8787),
  dbPath: process.env.DB_PATH ?? "./data/wallet-index.sqlite",
  /** First height to index on an empty database. Defaults to tip - 40 (the node keeps 42 bodies). */
  indexFrom: process.env.INDEX_FROM ? Number(process.env.INDEX_FROM) : undefined,
  pollMs: Number(process.env.POLL_MS ?? 5000),
  /** Set behind a reverse proxy (Caddy) so rate limits see the real client IP. */
  trustProxy: process.env.TRUST_PROXY === "1",
  /** Firebase service-account JSON for "NOID received" notifications. Unset = off. */
  fcmServiceAccount: process.env.FCM_SERVICE_ACCOUNT || undefined,
  /** Set PRICE=0 to turn off the NOID price feed. */
  priceEnabled: process.env.PRICE !== "0",
};
