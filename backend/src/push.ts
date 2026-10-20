// "You received NOID" notifications through Firebase Cloud Messaging (HTTP v1).
//
// Privacy: a subscription links a phone's push token to a public address on
// this server. It is opt-in in the app, can be removed at any time, and holds
// nothing secret. Addresses and amounts on chain are public anyway.
import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";

import type { Db } from "./db.js";

export type SendResult = "ok" | "gone" | "error";

export interface PushSender {
  send(token: string, title: string, body: string, data: Record<string, string>): Promise<SendResult>;
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

  async function accessToken(): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    if (access && access.exp - 60 > now) return access.token;
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
  }

  return {
    async send(token, title, body, data) {
      try {
        const res = await fetch(`https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`, {
          method: "POST",
          headers: { authorization: `Bearer ${await accessToken()}`, "content-type": "application/json" },
          body: JSON.stringify({
            message: { token, notification: { title, body }, data, android: { priority: "high", notification: { channel_id: "payments" } } },
          }),
          signal: AbortSignal.timeout(10_000),
        });
        if (res.ok) return "ok";
        const text = await res.text();
        // The app was uninstalled or the token rotated: forget it.
        if (res.status === 404 || text.includes("UNREGISTERED")) return "gone";
        log(`push: FCM HTTP ${res.status}`);
        return "error";
      } catch (e) {
        log(`push: ${(e as Error).message}`);
        return "error";
      }
    },
  };
}

export const PUSH_TOKEN_RE = /^[A-Za-z0-9_:\-]{20,4096}$/;
const MAX_ADDRESSES_PER_TOKEN = 5;
const MAX_TOKENS_PER_ADDRESS = 10;

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
  constructor(
    private readonly db: Db,
    private readonly sender: PushSender,
    private readonly log: (m: string) => void,
  ) {}

  subscribe(address: string, token: string): { ok: true } | { ok: false; message: string } {
    const perToken = this.db.prepare("SELECT COUNT(*) AS n FROM push_subs WHERE token = ? AND address != ?").get(token, address) as {
      n: number;
    };
    if (perToken.n >= MAX_ADDRESSES_PER_TOKEN) return { ok: false, message: "This phone already gets notifications for too many addresses." };
    const perAddr = this.db.prepare("SELECT COUNT(*) AS n FROM push_subs WHERE address = ? AND token != ?").get(address, token) as {
      n: number;
    };
    if (perAddr.n >= MAX_TOKENS_PER_ADDRESS) return { ok: false, message: "Too many phones get notifications for this address." };
    this.db
      .prepare("INSERT OR REPLACE INTO push_subs (address, token, created_at) VALUES (?, ?, ?)")
      .run(address, token, Math.floor(Date.now() / 1000));
    return { ok: true };
  }

  unsubscribe(address: string, token: string) {
    this.db.prepare("DELETE FROM push_subs WHERE address = ? AND token = ?").run(address, token);
  }

  /** Called by the indexer for each newly stored block (live blocks only). */
  async onRows(height: number, rows: NotifyRow[]) {
    const tokensFor = this.db.prepare("SELECT token FROM push_subs WHERE address = ?");
    const markSent = this.db.prepare("INSERT OR IGNORE INTO push_sent (address, txid, height) VALUES (?, ?, ?)");
    for (const r of rows) {
      if (r.direction !== "received" && r.direction !== "mined") continue;
      const tokens = tokensFor.all(r.address) as { token: string }[];
      if (tokens.length === 0) continue;
      // Once per (address, tx), even if a reorg makes the indexer store it again.
      if (markSent.run(r.address, r.txid, height).changes === 0) continue;
      const title = r.direction === "mined" ? "You mined NOID" : "NOID received";
      const body = `${r.direction === "mined" ? "Mined" : "You received"} ${formatNoid(r.amount)} NOID`;
      for (const { token } of tokens) {
        const result = await this.sender.send(token, title, body, { txid: r.txid, address: r.address });
        if (result === "gone") this.db.prepare("DELETE FROM push_subs WHERE token = ?").run(token);
      }
    }
    // Keep the de-duplication table small.
    this.db.prepare("DELETE FROM push_sent WHERE height < ?").run(height - 5_000);
  }
}
