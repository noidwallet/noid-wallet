import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type Db = Database.Database;

export function openDb(path: string): Db {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS blocks (
      height INTEGER PRIMARY KEY,
      hash TEXT NOT NULL,
      time INTEGER NOT NULL,
      complete INTEGER NOT NULL      -- 0 when the body was already pruned
    );
    CREATE TABLE IF NOT EXISTS txs (
      txid TEXT PRIMARY KEY,
      height INTEGER NOT NULL,
      time INTEGER NOT NULL,
      fee INTEGER NOT NULL,
      kind TEXT NOT NULL,            -- payment | coinbase | contract
      input_owner TEXT
    );
    CREATE TABLE IF NOT EXISTS address_txs (
      address TEXT NOT NULL,
      txid TEXT NOT NULL,
      height INTEGER NOT NULL,
      time INTEGER NOT NULL,
      direction TEXT NOT NULL,       -- sent | received | self | mined | contract
      amount INTEGER NOT NULL,       -- what this address sent away or received (μNOID)
      fee INTEGER NOT NULL,          -- fee paid by this address (0 unless it is the sender)
      counterparty TEXT,
      PRIMARY KEY (address, txid)
    );
    CREATE INDEX IF NOT EXISTS address_txs_by_height ON address_txs (address, height DESC);
    CREATE INDEX IF NOT EXISTS txs_by_height ON txs (height);
  `);
  return db;
}
