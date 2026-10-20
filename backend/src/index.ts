import { config } from "./config.js";
import { openDb } from "./db.js";
import { Indexer } from "./indexer.js";
import { PriceFeed } from "./price.js";
import { fcmSender, Notifier } from "./push.js";
import { buildServer } from "./server.js";

const log = (m: string) => console.log(new Date().toISOString(), m);
const db = openDb(config.dbPath);
const sender = fcmSender(config.fcmServiceAccount, log);
const notifier = sender ? new Notifier(db, sender, log) : null;
const price = config.priceEnabled ? new PriceFeed({ log }) : null;
const indexer = new Indexer(db, {
  indexFrom: config.indexFrom,
  pollMs: config.pollMs,
  log,
  onBlock: notifier ? (h, t, rows) => notifier.onRows(h, t, rows) : undefined,
});
const app = await buildServer(db, indexer, { trustProxy: config.trustProxy, price, notifier });

indexer.start();
await app.listen({ host: config.host, port: config.port });

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    indexer.stop();
    await app.close();
    db.close();
    process.exit(0);
  });
}
