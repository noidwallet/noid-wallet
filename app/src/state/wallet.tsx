import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AppState } from 'react-native';
import * as LocalAuthentication from 'expo-local-authentication';

import { createApi, type Api, type HistoryItem, type Price, type Status } from '@/lib/api';
import { core, type Utxo } from '@/lib/core';
import { createDirectPrice } from '@/lib/directPrice';
import { emitRelock } from '@/lib/lockEvents';
import { onPushTokenChange } from '@/lib/push';
import { reconcileOne } from '@/lib/send';
import {
  storage,
  type Contact,
  type GiftRecord,
  type PendingTx,
  type Settings,
  type WalletMeta,
  type WalletOrigin,
} from '@/lib/storage';

const REFRESH_MS = 15_000;
/** Used when the wallet server can't get the NOID price itself (see lib/directPrice). */
const directPrice = createDirectPrice();
const RELOCK_AFTER_MS = 60_000;

export type LockState = 'secure' | 'no-screen-lock';

interface WalletState {
  loading: boolean;
  meta: WalletMeta | null;
  settings: Settings;
  api: Api;
  locked: boolean;
  /** Re-locked after time in the background: the lock covers the open screens. */
  paused: boolean;
  lockState: LockState;
  status: Status | null;
  utxos: Utxo[];
  balance: number;
  pending: PendingTx[];
  history: HistoryItem[];
  error: string | null;
  refreshing: boolean;
  /** NOID price for display; null when off or unavailable. */
  price: Price | null;
  /** When balance and activity were last loaded from the server (ms), or null if never. */
  lastUpdated: number | null;
  contacts: Contact[];
  gifts: GiftRecord[];
  /** Addresses this wallet has sent to: the trusted set for look-alike checks. */
  sentTo: string[];
}

interface WalletActions {
  /** Re-fetch everything. `manual` shows the pull-to-refresh spinner. */
  refresh: (opts?: { manual?: boolean }) => Promise<void>;
  createWallet: (secretHex: string, origin: WalletOrigin, keyIndex?: number) => Promise<void>;
  markBackedUp: () => Promise<void>;
  removeWallet: () => Promise<void>;
  setApiUrl: (url: string) => Promise<void>;
  updateSettings: (patch: Partial<Settings>) => Promise<void>;
  saveContact: (name: string, address: string) => void;
  removeContact: (id: string) => void;
  /** Insert or replace a gift record (by index) and persist it. */
  saveGift: (g: GiftRecord) => void;
  removeGift: (index: number) => void;
  /** Insert or replace a pending record (by txid) and persist it. */
  recordPending: (p: PendingTx) => void;
  discardPending: (txid: string) => void;
  unlock: (reason?: string) => Promise<boolean>;
  /** Phone lock (biometric or PIN/pattern) before sensitive actions. */
  confirmUser: (reason: string) => Promise<boolean>;
}

const Ctx = createContext<(WalletState & WalletActions) | null>(null);

/** Does this phone have any screen lock (PIN, pattern, password or biometrics)? */
export async function screenLockState(): Promise<LockState> {
  const level = await LocalAuthentication.getEnrolledLevelAsync();
  return level === LocalAuthentication.SecurityLevel.NONE ? 'no-screen-lock' : 'secure';
}

/**
 * Ask for the phone's own lock: fingerprint/face, or PIN/pattern/password
 * (Android falls back to the device credential when no biometrics are set).
 * A phone with no screen lock at all has nothing to check against; the app
 * then shows a permanent warning instead.
 */
export async function authenticate(reason: string): Promise<boolean> {
  if ((await screenLockState()) === 'no-screen-lock') return true;
  // Strong (class 3) biometrics only; weaker face unlock falls back to the PIN.
  const res = await LocalAuthentication.authenticateAsync({
    promptMessage: reason,
    disableDeviceFallback: false,
    biometricsSecurityLevel: 'strong',
  });
  return res.success;
}

export function WalletProvider({ children }: { children: ReactNode }) {
  const [loading, setLoading] = useState(true);
  const [meta, setMeta] = useState<WalletMeta | null>(null);
  const [settings, setSettings] = useState<Settings>({ apiUrl: '' });
  const [installId, setInstallId] = useState('');
  const [locked, setLocked] = useState(true);
  const [paused, setPaused] = useState(false);
  const [lockState, setLockState] = useState<LockState>('secure');
  const [status, setStatus] = useState<Status | null>(null);
  const [utxos, setUtxos] = useState<Utxo[]>([]);
  const [pending, setPending] = useState<PendingTx[]>([]);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [price, setPrice] = useState<Price | null>(null);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [recipients, setRecipients] = useState<string[]>([]);
  const [gifts, setGifts] = useState<GiftRecord[]>([]);
  const giftsRef = useRef<GiftRecord[]>([]);
  const backgroundedAt = useRef<number | null>(null);
  const pendingRef = useRef<PendingTx[]>([]);
  const refreshInFlight = useRef(false);

  const api = useMemo(() => createApi(settings.apiUrl, installId), [settings.apiUrl, installId]);

  /** Single write path for pending: functional, persisted, never from a stale copy. */
  const updatePending = useCallback((fn: (prev: PendingTx[]) => PendingTx[]) => {
    const next = fn(pendingRef.current);
    pendingRef.current = next;
    storage.savePending(next);
    setPending(next);
  }, []);

  useEffect(() => {
    (async () => {
      const [m, s, id, lock] = await Promise.all([
        storage.loadMeta(),
        storage.loadSettings(),
        storage.installId(),
        screenLockState().catch(() => 'secure' as LockState),
      ]);
      const p = storage.loadPending();
      pendingRef.current = p;
      setPending(p);
      setContacts(storage.loadContacts());
      setRecipients(storage.loadRecipients());
      const g = storage.loadGifts();
      giftsRef.current = g;
      setGifts(g);
      if (m) {
        const snap = storage.loadSnapshot(m.address);
        if (snap) {
          setUtxos(snap.utxos);
          setHistory(snap.history as HistoryItem[]);
          setLastUpdated(snap.at);
        }
      }
      setMeta(m);
      setSettings(s);
      setInstallId(id);
      setLockState(lock);
      setLoading(false);
    })();
  }, []);

  // Re-lock after the app has been in the background for a while.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'background') backgroundedAt.current = Date.now();
      if (next === 'active') {
        void screenLockState().then(setLockState, () => {});
        if (backgroundedAt.current && Date.now() - backgroundedAt.current > RELOCK_AFTER_MS) {
          emitRelock();
          setPaused(true);
        }
      }
    });
    return () => sub.remove();
  }, []);

  const refresh = useCallback(async (opts?: { manual?: boolean }) => {
    // Only a pull-to-refresh shows the spinner; the background poll is silent.
    // A pull during a poll keeps spinning until that poll finishes.
    if (opts?.manual) setRefreshing(true);
    if (refreshInFlight.current) return;
    if (!meta) {
      setRefreshing(false);
      return;
    }
    if (!settings.apiUrl) {
      setRefreshing(false);
      // Nothing to talk to yet; the home screen asks the user to add a server.
      setStatus(null);
      setError(null);
      return;
    }
    refreshInFlight.current = true;
    try {
      const wantPrice = (settings.currency ?? 'none') !== 'none';
      const [st, coins, hist, px] = await Promise.all([
        api.status(),
        api.utxos(meta.address),
        api.history(meta.address).catch(() => null),
        wantPrice
          ? api
              .price()
              .catch(() => directPrice.get(() => api.fx()))
              .catch(() => null)
          : Promise.resolve(null),
      ]);
      setStatus(st);
      // A failed price check keeps the last good price (it carries its own age),
      // so a value never flickers away mid-typing.
      if (px) setPrice({ ...px, receivedAt: Date.now() });
      else if (!wantPrice) setPrice(null);
      setUtxos(coins.utxos);
      if (hist) setHistory(hist.items);
      // A failed history call keeps the last saved history rather than an empty one.
      const savedHistory = hist?.items ?? storage.loadSnapshot(meta.address)?.history ?? [];
      setLastUpdated(storage.saveSnapshot({ address: meta.address, utxos: coins.utxos, history: savedHistory }));

      // Check every saved transaction; re-send the identical one if the network lost it.
      const listed = new Set((hist?.items ?? []).map((h) => h.txid));
      for (const p of pendingRef.current) {
        let next = await reconcileOne(api, p, meta.address).catch(() => p);
        // A confirmed payment stays listed until the history shows it (or for two
        // minutes at most), so it never disappears from Activity in between.
        if (next?.confirmedAt && (listed.has(next.txid) || Date.now() - next.confirmedAt > 120_000)) next = null;
        if (next === p) continue;
        updatePending((prev) => {
          if (next === null) return prev.filter((x) => x.txid !== p.txid);
          // If a send screen dropped this record meanwhile but the network has
          // it after all, track it again so its coins are never reused.
          return prev.some((x) => x.txid === p.txid) ? prev.map((x) => (x.txid === p.txid ? next : x)) : [...prev, next];
        });
      }
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      refreshInFlight.current = false;
      setRefreshing(false);
    }
  }, [api, meta, settings.apiUrl, settings.currency, updatePending]);

  // The server forgets notification subscriptions the app does not renew.
  useEffect(() => {
    if (!meta || !settings.pushToken || !settings.apiUrl) return;
    void api.pushSubscribe(meta.address, settings.pushToken).catch(() => {});
  }, [api, meta, settings.apiUrl, settings.pushToken]);

  // Firebase can rotate a phone's push token; keep the server's copy current.
  useEffect(() => {
    if (!meta || !settings.pushToken) return;
    return onPushTokenChange((token) => {
      void api
        .pushSubscribe(meta.address, token)
        .then(async () => {
          const s = { ...settings, pushToken: token };
          await storage.saveSettings(s);
          setSettings(s);
        })
        .catch(() => {});
    });
  }, [api, meta, settings]);

  useEffect(() => {
    if (!meta || locked || paused) return;
    const first = setTimeout(() => void refresh(), 0);
    const t = setInterval(() => void refresh(), REFRESH_MS);
    return () => {
      clearTimeout(first);
      clearInterval(t);
    };
  }, [meta, locked, paused, refresh]);

  const createWallet = useCallback(
    async (secretHex: string, origin: WalletOrigin, keyIndex = 0) => {
      const info = await core.inspectSecret(secretHex);
      const address =
        keyIndex === 0 ? info.address : (await core.deriveAddresses(secretHex, keyIndex, 1))[0]!.address;
      await storage.saveSecret(secretHex);
      const m: WalletMeta = {
        keyId: info.keyId,
        address,
        keyIndex,
        origin,
        // A restored secret is already backed up, and a new one is only created
        // after the user typed two groups back from their paper copy. Photo
        // wallets still need the hex backup: the photo alone is too easy to edit or lose.
        backedUp: origin === 'imported' || origin === 'generated',
        createdAt: Date.now(),
      };
      await storage.saveMeta(m);
      updatePending(() => []);
      setHistory([]);
      setUtxos([]);
      setLastUpdated(null);
      giftsRef.current = [];
      storage.saveGifts([]);
      setGifts([]);
      setMeta(m);
      setLocked(false);
      setPaused(false);
    },
    [updatePending],
  );

  const unlock = useCallback(async (reason = 'Unlock NOID') => {
    const ok = await authenticate(reason);
    if (ok) {
      setLocked(false);
      setPaused(false);
    }
    return ok;
  }, []);

  const value = useMemo(
    () => ({
      loading,
      meta,
      settings,
      api,
      locked,
      paused,
      lockState,
      status,
      utxos,
      balance: utxos.reduce((s, u) => s + u.value, 0),
      pending,
      history,
      error,
      refreshing,
      price,
      lastUpdated,
      contacts,
      gifts,
      // Only what this phone itself sent: server-supplied history could plant
      // an address here and silence the first-payment warning.
      sentTo: [...new Set([...recipients, ...pending.filter((p) => p.kind === 'send' && p.to).map((p) => p.to!)])],
      refresh,
      createWallet,
      async markBackedUp() {
        if (!meta) return;
        const m = { ...meta, backedUp: true };
        await storage.saveMeta(m);
        setMeta(m);
      },
      async removeWallet() {
        if (meta && settings.pushToken) await api.pushUnsubscribe(meta.address, settings.pushToken).catch(() => {});
        await storage.wipe();
        setContacts([]);
        setRecipients([]);
        giftsRef.current = [];
        setGifts([]);
        const s = { ...settings, pushToken: null };
        await storage.saveSettings(s);
        setSettings(s);
        pendingRef.current = [];
        setPending([]);
        setMeta(null);
        setUtxos([]);
        setHistory([]);
        setLocked(true);
        setPaused(false);
      },
      async setApiUrl(url: string) {
        const s = { ...settings, apiUrl: url.trim().replace(/\/+$/, '') };
        await storage.saveSettings(s);
        setSettings(s);
      },
      async updateSettings(patch: Partial<Settings>) {
        const s = { ...settings, ...patch };
        await storage.saveSettings(s);
        setSettings(s);
        if (patch.currency === 'none') setPrice(null);
      },
      saveContact(name: string, address: string) {
        setContacts((prev) => {
          const existing = prev.find((c) => c.address === address);
          const next = existing
            ? prev.map((c) => (c.address === address ? { ...c, name } : c))
            : [...prev, { id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, name, address, createdAt: Date.now() }];
          storage.saveContacts(next);
          return next;
        });
      },
      removeContact(id: string) {
        setContacts((prev) => {
          const next = prev.filter((c) => c.id !== id);
          storage.saveContacts(next);
          return next;
        });
      },
      saveGift(g: GiftRecord) {
        const next = [...giftsRef.current.filter((x) => x.index !== g.index), g].sort((a, b) => b.createdAt - a.createdAt);
        giftsRef.current = next;
        storage.saveGifts(next);
        setGifts(next);
      },
      removeGift(index: number) {
        const next = giftsRef.current.filter((x) => x.index !== index);
        giftsRef.current = next;
        storage.saveGifts(next);
        setGifts(next);
      },
      recordPending(p: PendingTx) {
        if (p.kind === 'send' && p.to && p.state === 'submitted') {
          const to = p.to;
          setRecipients((prev) => {
            if (prev.includes(to)) return prev;
            const next = [...prev, to];
            storage.saveRecipients(next);
            return next;
          });
        }
        updatePending((prev) => [...prev.filter((x) => x.txid !== p.txid), p]);
      },
      discardPending(txid: string) {
        updatePending((prev) => prev.filter((x) => x.txid !== txid));
      },
      unlock,
      confirmUser: authenticate,
    }),
    [loading, meta, settings, api, locked, paused, lockState, status, utxos, pending, history, error, refreshing, price, lastUpdated, contacts, recipients, gifts, refresh, createWallet, unlock, updatePending],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useWallet() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useWallet must be used inside WalletProvider');
  return v;
}
