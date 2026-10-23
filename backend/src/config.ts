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
  /**
   * Addresses that receive the NOID wallet fee (comma separated). Display only:
   * a send's fee output is shown as "wallet fee" instead of a second recipient.
   * The app decides the fee and its address itself; the server can't change it.
   */
  walletFeeAddresses: new Set(
    (process.env.WALLET_FEE_ADDRESSES ?? "o155fsn6m5au9ardteuw0qc77agzzp6a99c8j5k60qumdwus5ajwesf9magf")
      .split(",")
      .map((a) => a.trim().toLowerCase())
      .filter(Boolean),
  ),
  /** Set PRICE=0 to turn off the NOID price feed. */
  priceEnabled: process.env.PRICE !== "0",
  /**
   * App versions announced to phones (x.y.z). APP_LATEST_VERSION shows "an
   * update is available"; APP_MIN_VERSION warns that older versions can't send
   * (e.g. after a network upgrade). The app links only to noidusa.com.
   */
  appLatestVersion: semver(process.env.APP_LATEST_VERSION),
  appMinVersion: semver(process.env.APP_MIN_VERSION),
};

function semver(v: string | undefined): string | undefined {
  return v && /^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v.trim()) ? v.trim() : undefined;
}
