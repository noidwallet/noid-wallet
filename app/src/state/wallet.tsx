import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AppState } from 'react-native';
import * as LocalAuthentication from 'expo-local-authentication';

import { createApi, type Api, type HistoryItem, type Status } from '@/lib/api';
import { core, type Utxo } from '@/lib/core';
import { reconcileOne } from '@/lib/send';
import { storage, type PendingTx, type Settings, type WalletMeta, type WalletOrigin } from '@/lib/storage';

const REFRESH_MS = 15_000;
const RELOCK_AFTER_MS = 60_000;

export type LockState = 'secure' | 'no-screen-lock';

interface WalletState {
  loading: boolean;
  meta: WalletMeta | null;
  settings: Settings;
  api: Api;
  locked: boolean;
  lockState: LockState;
  status: Status | null;
  utxos: Utxo[];
  balance: number;
  pending: PendingTx[];
  history: HistoryItem[];
  error: string | null;
  refreshing: boolean;
}

interface WalletActions {
  refresh: () => Promise<void>;
  createWallet: (secretHex: string, origin: WalletOrigin, keyIndex?: number) => Promise<void>;
  markBackedUp: () => Promise<void>;
  removeWallet: () => Promise<void>;
  setApiUrl: (url: string) => Promise<void>;
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
  const res = await LocalAuthentication.authenticateAsync({ promptMessage: reason, disableDeviceFallback: false });
  return res.success;
}

export function WalletProvider({ children }: { children: ReactNode }) {
  const [loading, setLoading] = useState(true);
  const [meta, setMeta] = useState<WalletMeta | null>(null);
  const [settings, setSettings] = useState<Settings>({ apiUrl: '' });
  const [installId, setInstallId] = useState('');
  const [locked, setLocked] = useState(true);
  const [lockState, setLockState] = useState<LockState>('secure');
  const [status, setStatus] = useState<Status | null>(null);
  const [utxos, setUtxos] = useState<Utxo[]>([]);
  const [pending, setPending] = useState<PendingTx[]>([]);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
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
        if (backgroundedAt.current && Date.now() - backgroundedAt.current > RELOCK_AFTER_MS) setLocked(true);
      }
    });
    return () => sub.remove();
  }, []);

  const refresh = useCallback(async () => {
    if (!meta || refreshInFlight.current) return;
    if (!settings.apiUrl) {
      // Nothing to talk to yet; the home screen asks the user to add a server.
      setStatus(null);
      setError(null);
      return;
    }
    refreshInFlight.current = true;
    setRefreshing(true);
    try {
      const [st, coins, hist] = await Promise.all([
        api.status(),
        api.utxos(meta.address),
        api.history(meta.address).catch(() => null),
      ]);
      setStatus(st);
      setUtxos(coins.utxos);
      if (hist) setHistory(hist.items);

      // Check every saved transaction; re-send the identical one if the network lost it.
      for (const p of pendingRef.current) {
        const next = await reconcileOne(api, p).catch(() => p);
        if (next === p) continue;
        updatePending((prev) =>
          next === null ? prev.filter((x) => x.txid !== p.txid) : prev.map((x) => (x.txid === p.txid ? next : x)),
        );
      }
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      refreshInFlight.current = false;
      setRefreshing(false);
    }
  }, [api, meta, settings.apiUrl, updatePending]);

  useEffect(() => {
    if (!meta || locked) return;
    const first = setTimeout(() => void refresh(), 0);
    const t = setInterval(() => void refresh(), REFRESH_MS);
    return () => {
      clearTimeout(first);
      clearInterval(t);
    };
  }, [meta, locked, refresh]);

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
      setMeta(m);
      setLocked(false);
    },
    [updatePending],
  );

  const unlock = useCallback(async (reason = 'Unlock NOID') => {
    const ok = await authenticate(reason);
    if (ok) setLocked(false);
    return ok;
  }, []);

  const value = useMemo(
    () => ({
      loading,
      meta,
      settings,
      api,
      locked,
      lockState,
      status,
      utxos,
      balance: utxos.reduce((s, u) => s + u.value, 0),
      pending,
      history,
      error,
      refreshing,
      refresh,
      createWallet,
      async markBackedUp() {
        if (!meta) return;
        const m = { ...meta, backedUp: true };
        await storage.saveMeta(m);
        setMeta(m);
      },
      async removeWallet() {
        await storage.wipe();
        pendingRef.current = [];
        setPending([]);
        setMeta(null);
        setUtxos([]);
        setHistory([]);
        setLocked(true);
      },
      async setApiUrl(url: string) {
        const s = { ...settings, apiUrl: url.trim().replace(/\/+$/, '') };
        await storage.saveSettings(s);
        setSettings(s);
      },
      recordPending(p: PendingTx) {
        updatePending((prev) => [...prev.filter((x) => x.txid !== p.txid), p]);
      },
      discardPending(txid: string) {
        updatePending((prev) => prev.filter((x) => x.txid !== txid));
      },
      unlock,
      confirmUser: authenticate,
    }),
    [loading, meta, settings, api, locked, lockState, status, utxos, pending, history, error, refreshing, refresh, createWallet, unlock, updatePending],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useWallet() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useWallet must be used inside WalletProvider');
  return v;
}
