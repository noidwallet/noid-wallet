import { config } from "./config.js";
import { openDb } from "./db.js";
import { Indexer } from "./indexer.js";
import { buildServer } from "./server.js";

const db = openDb(config.dbPath);
const indexer = new Indexer(db, {
  indexFrom: config.indexFrom,
  pollMs: config.pollMs,
  log: (m) => console.log(new Date().toISOString(), m),
});
const app = await buildServer(db, indexer, { trustProxy: config.trustProxy });

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
