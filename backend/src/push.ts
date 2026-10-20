// "NOID incoming" notifications through Firebase Cloud Messaging (HTTP v1).
//
// Privacy: a subscription links a phone's push token to a public address on
// this server. It is opt-in in the app, can be removed at any time, and holds
// nothing secret. Only the txid is sent through Google; no addresses.
//
// Abuse limits: tokens are checked with FCM (validate_only) before they are
// stored, a token watches at most 5 addresses, an address keeps its 10 most
// recent tokens (older ones are evicted, so nobody can lock an owner out),
// rows expire unless the app renews them, and the table has a global cap.
import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";

import type { Db } from "./db.js";

export type SendResult = "ok" | "gone" | "error";

export interface PushSender {
  send(token: string, title: string, body: string, data: Record<string, string>): Promise<SendResult>;
  /** Ask FCM whether this token belongs to our app, without delivering anything. */
  validate(token: string): Promise<SendResult>;
}

interface ServiceAccount {
  project_id: string;
  client_email: string;
  private_key: string;
  token_uri?: string;
}

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");

/** FCM sender from a Firebase service-account JSON file; null when not configured. */
export function fcmSender(path: string | undefined, log: (m: string) => void): PushSender | null {
  if (!path) return null;
  let sa: ServiceAccount;
  try {
    sa = JSON.parse(readFileSync(path, "utf8")) as ServiceAccount;
    if (!sa.project_id || !sa.client_email || !sa.private_key) throw new Error("missing fields");
  } catch (e) {
    log(`push: cannot read service account (${(e as Error).message}); notifications are off`);
    return null;
  }
  const tokenUri = sa.token_uri ?? "https://oauth2.googleapis.com/token";
  let access: { token: string; exp: number } | null = null;
  /** After an auth failure, do not hammer Google: wait before trying again. */
  let authBackoffUntil = 0;

  async function accessToken(): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    if (access && access.exp - 60 > now) return access.token;
    if (Date.now() < authBackoffUntil) throw new Error("auth backoff");
    const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const claims = b64url(
      JSON.stringify({
        iss: sa.client_email,
        scope: "https://www.googleapis.com/auth/firebase.messaging",
        aud: tokenUri,
        iat: now,
        exp: now + 3600,
      }),
    );
    const signer = createSign("RSA-SHA256");
    signer.update(`${header}.${claims}`);
    const jwt = `${header}.${claims}.${b64url(signer.sign(sa.private_key))}`;
    try {
      const res = await fetch(tokenUri, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`token endpoint HTTP ${res.status}`);
      const body = (await res.json()) as { access_token: string; expires_in: number };
      access = { token: body.access_token, exp: now + (body.expires_in ?? 3600) };
      return access.token;
    } catch (e) {
      authBackoffUntil = Date.now() + 60_000;
      throw e;
    }
  }

  async function post(message: object, validateOnly: boolean): Promise<SendResult> {
    try {
      const res = await fetch(`https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`, {
        method: "POST",
        headers: { authorization: `Bearer ${await accessToken()}`, "content-type": "application/json" },
        body: JSON.stringify({ message, validate_only: validateOnly }),
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) return "ok";
      const text = await res.text();
      // Uninstalled app, rotated token, made-up token or another app's token: forget it.
      if (
        res.status === 404 ||
        text.includes("UNREGISTERED") ||
        text.includes("INVALID_ARGUMENT") ||
        text.includes("SENDER_ID_MISMATCH")
      ) {
        return "gone";
      }
      log(`push: FCM HTTP ${res.status}`);
      return "error";
    } catch (e) {
      log(`push: ${(e as Error).message}`);
      return "error";
    }
  }

  return {
    send: (token, title, body, data) =>
      post(
        { token, notification: { title, body }, data, android: { priority: "high", notification: { channel_id: "payments" } } },
        false,
      ),
    validate: (token) => post({ token, data: { check: "1" } }, true),
  };
}

/** FCM registration tokens are about 160 characters. */
export const PUSH_TOKEN_RE = /^[A-Za-z0-9_:\-]{20,512}$/;
const MAX_ADDRESSES_PER_TOKEN = 5;
const MAX_TOKENS_PER_ADDRESS = 10;
const MAX_ROWS = 200_000;
/** The app renews its subscription; unrenewed rows are dropped after this long. */
const EXPIRE_SECONDS = 60 * 24 * 3600;
/** Ignore dust so nobody can spam an address with notifications cheaply. */
export const MIN_NOTIFY_MICRO = 1_000;
/** Only blocks this recent notify; older ones are catch-up after downtime or sync. */
const MAX_BLOCK_AGE_SECONDS = 15 * 60;
const SEND_CONCURRENCY = 4;
const MAX_QUEUE = 10_000;

export interface NotifyRow {
  address: string;
  txid: string;
  direction: string;
  amount: number;
}

function formatNoid(micro: number): string {
  const s = (micro / 1_000_000).toFixed(6).replace(/\.?0+$/, "");
  return s === "" ? "0" : s;
}

export class Notifier {
  private queue: { token: string; title: string; body: string; txid: string }[] = [];
  private active = 0;

  constructor(
    private readonly db: Db,
    private readonly sender: PushSender,
    private readonly log: (m: string) => void,
    private readonly now: () => number = () => Math.floor(Date.now() / 1000),
  ) {}

  async subscribe(address: string, token: string): Promise<{ ok: true } | { ok: false; status: number; message: string }> {
    const valid = await this.sender.validate(token);
    if (valid === "gone") return { ok: false, status: 400, message: "This notification token is not valid for NOID." };
    if (valid === "error") return { ok: false, status: 503, message: "Notifications are not reachable right now. Try again later." };

    const perToken = this.db.prepare("SELECT COUNT(*) AS n FROM push_subs WHERE token = ? AND address != ?").get(token, address) as {
      n: number;
    };
    if (perToken.n >= MAX_ADDRESSES_PER_TOKEN) {
      return { ok: false, status: 429, message: "This phone already gets notifications for too many addresses." };
    }
    const total = this.db.prepare("SELECT COUNT(*) AS n FROM push_subs").get() as { n: number };
    if (total.n >= MAX_ROWS) return { ok: false, status: 503, message: "Notifications are full on this server right now." };

    const now = this.now();
    this.db.transaction(() => {
      this.db.prepare("INSERT OR REPLACE INTO push_subs (address, token, created_at) VALUES (?, ?, ?)").run(address, token, now);
      // Keep only the newest tokens for an address: an owner is never locked out.
      this.db
        .prepare(
          `DELETE FROM push_subs WHERE address = ? AND token NOT IN
             (SELECT token FROM push_subs WHERE address = ? ORDER BY created_at DESC LIMIT ?)`,
        )
        .run(address, address, MAX_TOKENS_PER_ADDRESS);
    })();
    return { ok: true };
  }

  unsubscribe(address: string, token: string) {
    this.db.prepare("DELETE FROM push_subs WHERE address = ? AND token = ?").run(address, token);
  }

  /**
   * Called by the indexer for each newly stored block. Returns quickly:
   * sending happens in the background so the indexer never waits on Google.
   */
  onRows(height: number, blockTime: number, rows: NotifyRow[]) {
    const now = this.now();
    this.db.prepare("DELETE FROM push_subs WHERE created_at < ?").run(now - EXPIRE_SECONDS);
    this.db.prepare("DELETE FROM push_sent WHERE height < ?").run(height - 5_000);
    if (now - blockTime > MAX_BLOCK_AGE_SECONDS) return;

    const tokensFor = this.db.prepare("SELECT token FROM push_subs WHERE address = ?");
    const markSent = this.db.prepare("INSERT OR IGNORE INTO push_sent (address, txid, height) VALUES (?, ?, ?)");
    for (const r of rows) {
      if (r.direction !== "received" && r.direction !== "mined") continue;
      if (r.amount < MIN_NOTIFY_MICRO) continue;
      const tokens = tokensFor.all(r.address) as { token: string }[];
      if (tokens.length === 0) continue;
      // Once per (address, tx), even if a reorg makes the indexer store it again.
      if (markSent.run(r.address, r.txid, height).changes === 0) continue;
      // The block can still be replaced for a few minutes, so say "incoming".
      const title = r.direction === "mined" ? "Block mined" : "NOID incoming";
      const body = `${r.direction === "mined" ? "Mining reward" : "Incoming"}: ${formatNoid(r.amount)} NOID. Confirms in a few minutes.`;
      for (const { token } of tokens) {
        if (this.queue.length >= MAX_QUEUE) break;
        this.queue.push({ token, title, body, txid: r.txid });
      }
    }
    this.pump();
  }

  /** For tests: resolves when every queued notification has been handled. */
  async drain() {
    while (this.queue.length > 0 || this.active > 0) await new Promise((r) => setTimeout(r, 5));
  }

  private pump() {
    while (this.active < SEND_CONCURRENCY && this.queue.length > 0) {
      const job = this.queue.shift()!;
      this.active++;
      void this.sender
        .send(job.token, job.title, job.body, { txid: job.txid })
        .then((result) => {
          if (result === "gone") this.db.prepare("DELETE FROM push_subs WHERE token = ?").run(job.token);
        })
        .catch((e: Error) => this.log(`push: ${e.message}`))
        .finally(() => {
          this.active--;
          this.pump();
        });
    }
  }
}
