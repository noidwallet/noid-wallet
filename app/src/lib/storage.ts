// On-device storage.
// - The master secret lives only in SecureStore: on Android it is encrypted
//   with a key held in the Android Keystore and excluded from cloud backups
//   (expo-secure-store config plugin).
// - Pending transactions are public data (the finished, proven intent), kept
//   in a plain app file so a send can be safely re-sent after a lost reply.
import * as SecureStore from 'expo-secure-store';
import Constants from 'expo-constants';
import { File, Paths } from 'expo-file-system';
import * as Crypto from 'expo-crypto';

import { isAllowedServerUrl } from './api';
import type { Currency } from './safety';
import type { Refusal } from './send';

const SECRET = 'noid.master.v1';
const META = 'noid.meta.v1';
const SETTINGS = 'noid.settings.v1';
const INSTALL_ID = 'noid.install.v1';
const PENDING_FILE = 'pending-v2.json';
const REFUSALS_FILE = 'refusals-v1.json';
const PRICE_GUARD_FILE = 'price-guard-v1.json';
const CONTACTS_FILE = 'contacts-v1.json';
const GIFTS_FILE = 'gifts-v1.json';
const SNAPSHOT_FILE = 'snapshot-v1.json';
const RECIPIENTS_FILE = 'recipients-v1.json';
/** Highest gift number ever used on this phone; never reset, never reused. */
const GIFT_HIGH_WATER = 'noid.gifthw.v1';

/** Last balance and activity seen, shown while offline. Public chain data only. */
export interface Snapshot {
  address: string;
  utxos: { slotIndex: number; value: number; creationId: string }[];
  history: unknown[];
  at: number;
}

export type WalletOrigin = 'generated' | 'imported' | 'photo';

export interface WalletMeta {
  keyId: string;
  address: string;
  keyIndex: number;
  origin: WalletOrigin;
  backedUp: boolean;
  createdAt: number;
}

export type { Currency };

export interface Settings {
  apiUrl: string;
  /** Show balances in this currency too (display only). */
  currency?: Currency;
  /** Push token registered with the wallet server, when notifications are on. */
  pushToken?: string | null;
  /** Hide amounts on the home screen (for using the app in public). */
  hideBalance?: boolean;
  /** The safety slides were shown (before the first wallet was made). */
  safetySeen?: boolean;
}

export interface Contact {
  id: string;
  name: string;
  address: string;
  createdAt: number;
}

/**
 * A gift card this wallet made. Its secret is NOT stored: it is re-derived
 * from the master secret by `index` whenever it is needed (sharing again or
 * taking the gift back), so a restored wallet can find its gifts too.
 */
export interface GiftRecord {
  index: number;
  address: string;
  /** What the recipient receives, in μNOID (claim fee already covered). */
  amount: number;
  message: string;
  theme: string;
  from: string;
  createdAt: number;
  fundTxid: string | null;
  /** draft: saved before funding. funded: waiting to be claimed. claimed/takenBack: finished. */
  status: 'draft' | 'funded' | 'claimed' | 'takenBack';
  takeBackTxid?: string;
  /** Removed from the list by the user. Kept so its number is never reused. */
  hidden?: boolean;
}

export interface PendingTx {
  txid: string;
  /** gift: funding a gift card. claim: moving a gift into this wallet (its inputs are not ours). */
  kind: 'send' | 'consolidate' | 'gift' | 'claim';
  /**
   * submitting: built and saved, but the server has not confirmed it received it.
   *   Never build another transaction while one is in this state; re-send this one.
   * submitted: the network has it.
   */
  state: 'submitting' | 'submitted';
  /** The exact signed-equivalent intent, so a lost reply is answered by re-sending it. */
  intentHex: string;
  to: string | null;
  amount: number;
  fee: number;
  /** NOID wallet fee paid with it (sends and gifts). */
  walletFee?: number;
  /** Chain height it was built at (it can be mined until its epoch ends). */
  builtAtHeight?: number;
  inputSlots: number[];
  /** Origin ids of the input coins (same order), so a reused slot number is never mistaken for them. */
  inputIds?: string[];
  outputSlots: number[];
  createdAt: number;
  /**
   * Set once the network confirms it. The record is kept until the server's
   * history lists the transaction too (its index lags the node by a few
   * seconds), so the payment never vanishes from Activity in between.
   */
  confirmedAt?: number;
}

// Empty until you deploy a production server and set extra.defaultApiUrl in app.json.
const defaultApiUrl = (Constants.expoConfig?.extra?.defaultApiUrl as string | undefined) ?? '';

async function readJson<T>(key: string): Promise<T | null> {
  const raw = await SecureStore.getItemAsync(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function parseFile<T>(name: string): T | undefined {
  try {
    const f = new File(Paths.document, name);
    if (!f.exists) return undefined;
    return (JSON.parse(f.textSync()) as T) ?? undefined;
  } catch {
    return undefined;
  }
}

/** The saved copy, or the new copy a write left behind if it was cut off before the swap. */
function readFileJson<T>(name: string, fallback: T): T {
  return parseFile<T>(name) ?? parseFile<T>(`${name}.tmp`) ?? fallback;
}

/**
 * Write a whole new copy, then swap it in. A crash or a dead battery mid-write
 * leaves either the old file or the new one intact, never half of each.
 */
function writeFileJson(name: string, value: unknown) {
  const tmp = new File(Paths.document, `${name}.tmp`);
  if (tmp.exists) tmp.delete();
  tmp.create();
  tmp.write(JSON.stringify(value));
  tmp.moveSync(new File(Paths.document, name), { overwrite: true });
}

export const storage = {
  async saveSecret(secretHex: string) {
    await SecureStore.setItemAsync(SECRET, secretHex);
  },
  /** Only call right before a proof or a secret reveal, after the user unlocked. */
  async readSecret(): Promise<string> {
    const s = await SecureStore.getItemAsync(SECRET);
    if (!s) throw new Error('This phone no longer has your wallet secret. Restore it from your backup.');
    return s;
  },
  loadMeta: () => readJson<WalletMeta>(META),
  saveMeta: (m: WalletMeta) => SecureStore.setItemAsync(META, JSON.stringify(m)),
  async loadSettings(): Promise<Settings> {
    const s: Settings = { apiUrl: defaultApiUrl, ...((await readJson<Partial<Settings>>(SETTINGS)) ?? {}) };
    // A server address this build no longer accepts (plain http in a release
    // build) falls back to the built-in one.
    if (s.apiUrl && !isAllowedServerUrl(s.apiUrl)) s.apiUrl = defaultApiUrl;
    return s;
  },
  saveSettings: (s: Settings) => SecureStore.setItemAsync(SETTINGS, JSON.stringify(s)),

  /** Random per-install id, sent so server rate limits work on shared mobile IPs. */
  async installId(): Promise<string> {
    let id = await SecureStore.getItemAsync(INSTALL_ID);
    if (!id) {
      id = Array.from(Crypto.getRandomBytes(16), (b) => b.toString(16).padStart(2, '0')).join('');
      await SecureStore.setItemAsync(INSTALL_ID, id);
    }
    return id;
  },

  loadPending(): PendingTx[] {
    const parsed = readFileJson<unknown>(PENDING_FILE, []);
    return Array.isArray(parsed) ? (parsed as PendingTx[]) : [];
  },
  savePending(p: PendingTx[]) {
    writeFileJson(PENDING_FILE, p);
  },

  /** Refused payments still guarded against (see lib/send.ts). */
  loadRefusals: () => {
    const r = readFileJson<unknown>(REFUSALS_FILE, []);
    return Array.isArray(r) ? (r as Refusal[]) : [];
  },
  saveRefusals: (r: Refusal[]) => writeFileJson(REFUSALS_FILE, r),

  /** Last trusted value of 1 NOID per currency (see lib/priceGuard.ts). */
  loadPriceGuard: () => readFileJson<Record<string, unknown>>(PRICE_GUARD_FILE, {}),
  savePriceGuard: (g: Record<string, unknown>) => writeFileJson(PRICE_GUARD_FILE, g),

  loadSnapshot(address: string): Snapshot | null {
    const s = readFileJson<Snapshot | null>(SNAPSHOT_FILE, null);
    return s && s.address === address && Array.isArray(s.utxos) ? s : null;
  },
  /** Returns the time it was saved. */
  /** Forget the saved balance and activity (they reload from the server). */
  clearSnapshot() {
    for (const name of [SNAPSHOT_FILE, `${SNAPSHOT_FILE}.tmp`]) {
      try {
        const f = new File(Paths.document, name);
        if (f.exists) f.delete();
      } catch {
        // nothing to remove
      }
    }
  },
  saveSnapshot(s: Omit<Snapshot, 'at'>): number {
    const at = Date.now();
    writeFileJson(SNAPSHOT_FILE, { ...s, at });
    return at;
  },
  /** Addresses this wallet has paid (used to spot look-alike addresses). */
  loadRecipients(): string[] {
    const r = readFileJson<string[]>(RECIPIENTS_FILE, []);
    return Array.isArray(r) ? r.filter((x) => typeof x === 'string') : [];
  },
  saveRecipients(r: string[]) {
    writeFileJson(RECIPIENTS_FILE, r.slice(-500));
  },
  async giftHighWater(): Promise<number> {
    const raw = await SecureStore.getItemAsync(GIFT_HIGH_WATER);
    const n = raw ? Number(raw) : -1;
    return Number.isInteger(n) ? n : -1;
  },
  async raiseGiftHighWater(index: number) {
    if (index > (await storage.giftHighWater())) await SecureStore.setItemAsync(GIFT_HIGH_WATER, String(index));
  },
  loadContacts(): Contact[] {
    const c = readFileJson<Contact[]>(CONTACTS_FILE, []);
    return Array.isArray(c) ? c : [];
  },
  saveContacts(c: Contact[]) {
    writeFileJson(CONTACTS_FILE, c);
  },
  loadGifts(): GiftRecord[] {
    const g = readFileJson<GiftRecord[]>(GIFTS_FILE, []);
    return Array.isArray(g) ? g : [];
  },
  saveGifts(g: GiftRecord[]) {
    writeFileJson(GIFTS_FILE, g);
  },

  async wipe() {
    await Promise.all([SECRET, META].map((k) => SecureStore.deleteItemAsync(k)));
    const files = [PENDING_FILE, CONTACTS_FILE, GIFTS_FILE, SNAPSHOT_FILE, RECIPIENTS_FILE, REFUSALS_FILE, PRICE_GUARD_FILE];
    // Also the half-written copies, so an old wallet's list can never come back.
    for (const name of [...files, ...files.map((n) => `${n}.tmp`)]) {
      try {
        const f = new File(Paths.document, name);
        if (f.exists) f.delete();
      } catch {
        // nothing to remove
      }
    }
  },
};
