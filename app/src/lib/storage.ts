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

const SECRET = 'noid.master.v1';
const META = 'noid.meta.v1';
const SETTINGS = 'noid.settings.v1';
const INSTALL_ID = 'noid.install.v1';
const PENDING_FILE = 'pending-v2.json';

export type WalletOrigin = 'generated' | 'imported' | 'photo';

export interface WalletMeta {
  keyId: string;
  address: string;
  keyIndex: number;
  origin: WalletOrigin;
  backedUp: boolean;
  createdAt: number;
}

export interface Settings {
  apiUrl: string;
}

export interface PendingTx {
  txid: string;
  kind: 'send' | 'consolidate';
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
  inputSlots: number[];
  outputSlots: number[];
  createdAt: number;
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

function pendingFile() {
  return new File(Paths.document, PENDING_FILE);
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
    return { apiUrl: defaultApiUrl, ...((await readJson<Partial<Settings>>(SETTINGS)) ?? {}) };
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
    try {
      const f = pendingFile();
      if (!f.exists) return [];
      const parsed = JSON.parse(f.textSync()) as PendingTx[];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  },
  savePending(p: PendingTx[]) {
    const f = pendingFile();
    if (!f.exists) f.create();
    f.write(JSON.stringify(p));
  },

  async wipe() {
    await Promise.all([SECRET, META].map((k) => SecureStore.deleteItemAsync(k)));
    try {
      const f = pendingFile();
      if (f.exists) f.delete();
    } catch {
      // nothing to remove
    }
  },
};
