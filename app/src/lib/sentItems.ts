// What a token or NFT send carried ("1 NEMO", "Cool Cats #3"), remembered by
// txid on this phone. The server's history lists such a send as a contract
// call with the NOID it cost; this lets Activity say what was sent.
import { storage } from './storage';

const MAX = 300;
let cache: Record<string, string> | null = null;

function load(): Record<string, string> {
  if (!cache) {
    try {
      cache = storage.loadSentItems();
    } catch {
      cache = {};
    }
  }
  return cache;
}

export function sentItem(txid: string): string | null {
  const v = load()[txid];
  return typeof v === 'string' ? v : null;
}

export function rememberSentItem(txid: string, item: string) {
  const m = { ...load(), [txid]: item.slice(0, 80) };
  const keys = Object.keys(m);
  for (const k of keys.slice(0, Math.max(0, keys.length - MAX))) delete m[k];
  cache = m;
  try {
    storage.saveSentItems(m);
  } catch {
    // Memory still has it for this session.
  }
}

/** The wallet was removed: its labels go with it (the file is wiped too). */
export function clearSentItems() {
  cache = {};
}
