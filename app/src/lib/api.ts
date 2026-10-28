// Client for the wallet backend (/backend). The phone never sends secrets here:
// it only reads public chain data and submits finished, proven transactions.
import type { FeeContext, Utxo } from './core';

const DEFINITE_REJECTIONS = new Set(['fee_too_low', 'stale_anchor', 'stale_inputs', 'inputs_spent', 'busy', 'rejected']);

/**
 * What the wallet shows for each answer the server can give. The server's own
 * words are never shown: a dishonest server could use them to tell the user
 * to do something unsafe.
 */
const APP_TEXT: Record<string, string> = {
  fee_too_low: 'The network fee rose while you were sending. Try again.',
  stale_anchor: 'A new block arrived while your payment was being prepared. Try again.',
  stale_inputs: 'Your balance changed while your payment was being prepared. Try again.',
  inputs_spent: 'Some of the money this payment used was already spent. Refresh and try again.',
  busy: 'The network is busy. Try again in a minute.',
  rejected: 'The network refused this payment.',
  node_error: 'The wallet server had a problem. Try again in a minute.',
  node_unavailable: 'The wallet server cannot reach the network right now. Try again in a minute.',
  price_unavailable: 'The NOID price is not available right now.',
  fx_unavailable: 'Exchange rates are not available right now.',
  push_disabled: 'This wallet server does not send notifications.',
  push_refused: 'The wallet server could not turn on notifications for this address right now.',
  unknown_status: 'The network did not answer in time. Your wallet is checking whether it went through.',
  bad_request: 'The wallet server could not read this request.',
  rate_limited: 'Too many requests. Wait a minute and try again.',
  bad_response: 'The wallet server sent an answer this wallet cannot use.',
  assets_unsupported: 'This wallet server does not show tokens yet.',
  media_missing: 'This token has no published name or picture.',
  media_unavailable: 'Token names and pictures are not available right now.',
  media_disabled: 'This wallet server does not show token names and pictures.',
  media_too_large: 'This token’s picture is too large to show.',
};

/** App text for a server answer (exported for tests). */
export function appText(code: string, status: number): string {
  if (status === 429) return APP_TEXT.rate_limited!;
  if (Object.prototype.hasOwnProperty.call(APP_TEXT, code)) return APP_TEXT[code]!;
  // Only a short, plain code is ever repeated back (never server-written text).
  const shown = /^[a-z0-9_]{1,40}$/.test(code) ? code : 'unknown';
  return `The wallet server could not do this right now (error ${status || shown}).`;
}

const DIRECTIONS = new Set(['sent', 'received', 'self', 'mined', 'contract']);
const ADDRESS_RE = /^o1[02-9ac-hj-np-z]{20,100}$/;
const VERSION_RE = /^\d{1,3}\.\d{1,3}\.\d{1,3}$/;
const isCountValue = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;

/**
 * One history row as the app will show it. Exported so a saved snapshot is
 * checked the same way when it is loaded again.
 */
export function isHistoryItem(i: unknown): i is HistoryItem {
  const h = i as HistoryItem | null;
  return (
    !!h &&
    typeof h === 'object' &&
    typeof h.txid === 'string' &&
    /^[0-9a-f]{64}$/.test(h.txid) &&
    isCountValue(h.height) &&
    isCountValue(h.time) &&
    typeof h.direction === 'string' &&
    DIRECTIONS.has(h.direction) &&
    isCountValue(h.amount) &&
    isCountValue(h.fee) &&
    (h.walletFee === undefined || h.walletFee === null || isCountValue(h.walletFee)) &&
    (h.counterparty === null || (typeof h.counterparty === 'string' && ADDRESS_RE.test(h.counterparty)))
  );
}

/** App versions the server announces: x.y.z or nothing. */
function okAppVersions(app: unknown): boolean {
  if (app === undefined) return true;
  if (!app || typeof app !== 'object') return false;
  const a = app as { latest?: unknown; min?: unknown };
  const ok = (v: unknown) => v === undefined || v === null || (typeof v === 'string' && VERSION_RE.test(v));
  return ok(a.latest) && ok(a.min);
}

/** Exchange rates: currency code to a positive finite number. */
function okRates(rates: unknown): boolean {
  if (rates === undefined) return true;
  if (!rates || typeof rates !== 'object' || Array.isArray(rates)) return false;
  return Object.entries(rates as Record<string, unknown>).every(
    ([k, v]) => /^[A-Z]{3}$/.test(k) && typeof v === 'number' && Number.isFinite(v) && v > 0,
  );
}

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 0,
    readonly retryable = false,
  ) {
    super(message);
  }
  /**
   * True when we cannot know whether the server acted on the request
   * (network drop, timeout, 5xx). A submit that ends this way may have
   * gone through and must never be rebuilt.
   */
  get ambiguous(): boolean {
    // Only answers our own server gives BEFORE relaying count as a definite
    // "not sent". Anything else (a proxy's 4xx, a timeout, a 5xx) might have
    // reached the network, so the saved transaction must be kept and re-sent.
    if (this.status === 422 && DEFINITE_REJECTIONS.has(this.code)) return false;
    if (this.status === 400 && this.code === 'bad_request') return false;
    if (this.status === 429) return false;
    return true;
  }
}

export interface Status extends FeeContext {
  height: number;
  synced: boolean;
  syncStage: string;
  peers: number | null;
  /** Optional server features; missing on older servers. */
  features?: { price?: boolean; push?: boolean; assets?: boolean; media?: boolean };
  /** App versions the server announces (see backend config). */
  app?: { latest?: string | null; min?: string | null };
}

export interface Price {
  usd: number;
  ngn: number | null;
  /** Units of each supported currency per 1 USD (see lib/currencies). */
  rates?: Record<string, number>;
  source: string;
  updatedAt: number;
  /** How old the price was when the server sent it (ms; server clock, so no phone clock skew). */
  ageMs?: number;
  /** When this phone received it (set by the wallet, phone clock). */
  receivedAt?: number;
  /** False when it is far off the last price this phone trusted: no typed-currency amounts. */
  typingOk?: boolean;
}

export interface Prepared extends FeeContext {
  epochAnchorHex: string;
  slotHints: number[];
  height: number;
}

export interface HistoryItem {
  txid: string;
  height: number;
  time: number;
  direction: 'sent' | 'received' | 'self' | 'mined' | 'contract';
  amount: number;
  fee: number;
  /** NOID wallet fee paid with this send (servers that know the fee address). */
  walletFee?: number;
  counterparty: string | null;
}

/** One Parano1d v2.1 State record, passed on as the node sent it (checked by the core). */
export interface AssetRecord {
  root: string;
  kind: number;
  openingHex: string;
  dependencyHex: string | null;
  slotIndex: number;
  creationId: string;
  amountMicronoid: string;
  /** Decimal string (u64: a sender can lock tokens until any height). */
  unlockHeight: string;
  reserved: boolean;
}

export interface AssetsPage {
  owner: string;
  height: number;
  blockHash: string;
  stateRoot: string;
  holdings: AssetRecord[];
  /** False when the address holds more records than the server reads at once. */
  complete: boolean;
}

export interface AssetMarket {
  height: number;
  blockHash: string;
  stateRoot: string;
  item: { key: string; primary: AssetRecord; related: AssetRecord[] } | null;
}

export type TxStatus =
  | { txid: string; status: 'pending' | 'unknown' }
  | { txid: string; status: 'confirmed'; height: number; confirmations: number };

/** Hermes may not ship AbortSignal.timeout, so build the timeout by hand. */
function timeoutSignal(ms: number): { signal: AbortSignal; clear: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

export function createApi(baseUrl: string, _installId = '') {
  const base = baseUrl.replace(/\/+$/, '');

  async function request<T>(path: string, init?: RequestInit, timeoutMs = 20_000): Promise<T> {
    const t = timeoutSignal(timeoutMs);
    let res: Response;
    try {
      res = await fetch(base + path, {
        ...init,
        // No device identifier is sent: the server limits by IP address only.
        headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
        signal: t.signal,
      });
    } catch {
      throw new ApiError('offline', 'Cannot reach the wallet server. Check your connection.');
    } finally {
      t.clear();
    }
    const body = (await res.json().catch(() => ({}))) as {
      error?: { code: string; message: string; retryable?: boolean };
    } & T;
    if (!res.ok || body.error) {
      const code = typeof body.error?.code === 'string' ? body.error.code : 'http_error';
      throw new ApiError(code, appText(code, res.status), res.status, body.error?.retryable === true);
    }
    return body;
  }

  /** A field that must be a whole number of base units (or height), 0 or more. */
  const isCount = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
  const isHex64 = (s: unknown): s is string => typeof s === 'string' && /^[0-9a-f]{64}$/.test(s);
  const isDecimal = (s: unknown): s is string => typeof s === 'string' && /^(0|[1-9]\d{0,19})$/.test(s);
  const isRecord = (h: AssetRecord | null | undefined): boolean =>
    !!h &&
    isHex64(h.root) &&
    isCount(h.kind) &&
    typeof h.openingHex === 'string' &&
    h.openingHex.length <= 4096 &&
    (h.dependencyHex === null || (typeof h.dependencyHex === 'string' && h.dependencyHex.length <= 4096)) &&
    isCount(h.slotIndex) &&
    isDecimal(h.creationId) &&
    isDecimal(h.amountMicronoid) &&
    isDecimal(h.unlockHeight) &&
    typeof h.reserved === 'boolean';
  function check<T>(value: T, ok: boolean): T {
    if (!ok) throw new ApiError('bad_response', APP_TEXT.bad_response!, 200);
    return value;
  }

  return {
    status: async () => {
      const r = await request<Status>('/v1/status');
      return check(
        r,
        isCount(r.height) &&
          isCount(r.activeSlotCount) &&
          isCount(r.logSlots) &&
          isCount(r.relayFloor) &&
          typeof r.synced === 'boolean' &&
          okAppVersions(r.app),
      );
    },
    utxos: async (address: string) => {
      const r = await request<{ address: string; balance: number; utxos: Utxo[] }>(`/v1/address/${address}/utxos`);
      const ok =
        r.address === address &&
        Array.isArray(r.utxos) &&
        r.utxos.every((u) => u && isCount(u.slotIndex) && isCount(u.value) && /^\d+$/.test(String(u.creationId))) &&
        new Set(r.utxos.map((u) => u.slotIndex)).size === r.utxos.length &&
        isCount(r.balance) &&
        r.balance === r.utxos.reduce((sum, u) => sum + u.value, 0);
      return check(r, ok);
    },
    prepare: async (outputs: 1 | 2 | 3) => {
      const r = await request<Prepared>('/v1/prepare', { method: 'POST', body: JSON.stringify({ outputs }) });
      const ok =
        isCount(r.height) &&
        isCount(r.activeSlotCount) &&
        isCount(r.logSlots) &&
        isCount(r.relayFloor) &&
        typeof r.epochAnchorHex === 'string' &&
        /^[0-9a-f]+$/i.test(r.epochAnchorHex) &&
        Array.isArray(r.slotHints) &&
        r.slotHints.every(isCount);
      return check(r, ok);
    },
    /** Idempotent: resubmitting the same intent returns success, never a second payment. */
    submit: (intentHex: string, txid: string) =>
      request<{ txid: string; already?: boolean }>(
        '/v1/submit',
        { method: 'POST', body: JSON.stringify({ intentHex, txid }) },
        100_000,
      ),
    tx: async (txid: string) => {
      const r = await request<TxStatus>(`/v1/tx/${txid}`);
      const ok =
        r.txid === txid &&
        (r.status === 'pending' ||
          r.status === 'unknown' ||
          (r.status === 'confirmed' && isCount(r.height) && isCount(r.confirmations)));
      return check(r, ok);
    },
    /** Tokens and NFTs: the node's raw records, checked by the core before use. */
    assets: async (address: string) => {
      const r = await request<AssetsPage>(`/v1/address/${address}/assets`, undefined, 30_000);
      const ok =
        r.owner === address &&
        isCount(r.height) &&
        isHex64(r.blockHash) &&
        isHex64(r.stateRoot) &&
        typeof r.complete === 'boolean' &&
        Array.isArray(r.holdings) &&
        r.holdings.length <= 4096 &&
        r.holdings.every(isRecord);
      return check(r, ok);
    },
    asset: async (assetId: string) => {
      const r = await request<AssetMarket>(`/v1/asset/${assetId}`);
      const item = r.item;
      const ok =
        isCount(r.height) &&
        isHex64(r.blockHash) &&
        isHex64(r.stateRoot) &&
        (item === null ||
          (!!item &&
            typeof item.key === 'string' &&
            isRecord(item.primary) &&
            Array.isArray(item.related) &&
            item.related.length <= 4 &&
            item.related.every(isRecord)));
      return check(r, ok);
    },
    /** Public token or NFT details (checked by the core against the hash in State). */
    mediaMetadata: async (hash: string) => {
      const r = await request<{ hash: string; text: string }>(`/v1/media/metadata/${hash}`);
      return check(r, r.hash === hash && typeof r.text === 'string' && r.text.length <= 8192);
    },
    /** Where to download a token or NFT picture (checked by the core after download). */
    mediaImageUrl: (hash: string) => `${base}/v1/media/image/${hash}`,
    price: async () => {
      const r = await request<Price>('/v1/price', undefined, 10_000);
      const ok =
        typeof r.usd === 'number' &&
        Number.isFinite(r.usd) &&
        r.usd > 0 &&
        (r.ngn === null || r.ngn === undefined || (typeof r.ngn === 'number' && Number.isFinite(r.ngn) && r.ngn > 0)) &&
        okRates(r.rates) &&
        isCount(r.updatedAt) &&
        (r.ageMs === undefined || (typeof r.ageMs === 'number' && Number.isFinite(r.ageMs)));
      // A negative age would keep a price "fresh" forever.
      return check({ ...r, ...(r.ageMs !== undefined ? { ageMs: Math.max(0, r.ageMs) } : {}) }, ok);
    },
    /** Exchange rates only (units per 1 USD), for when the server has no NOID price. */
    fx: async () => {
      const r = await request<{ rates: Record<string, number>; updatedAt: number; ageMs?: number }>('/v1/fx', undefined, 10_000);
      const ok =
        r.rates !== undefined &&
        okRates(r.rates) &&
        isCount(r.updatedAt) &&
        (r.ageMs === undefined || (typeof r.ageMs === 'number' && Number.isFinite(r.ageMs)));
      return check({ ...r, ...(r.ageMs !== undefined ? { ageMs: Math.max(0, r.ageMs) } : {}) }, ok);
    },
    pushSubscribe: (address: string, token: string) =>
      request<{ ok: true }>('/v1/push/subscribe', { method: 'POST', body: JSON.stringify({ address, token }) }),
    pushUnsubscribe: (address: string, token: string) =>
      request<{ ok: true }>('/v1/push/unsubscribe', { method: 'POST', body: JSON.stringify({ address, token }) }),
    /** Which of these addresses were ever used (servers from before this return 404). */
    addressesUsed: (addresses: string[]) =>
      request<{ used: string[] }>('/v1/addresses/used', { method: 'POST', body: JSON.stringify({ addresses }) }),
    history: async (address: string, before?: string) => {
      const r = await request<{ items: HistoryItem[]; nextBefore: string | null; indexedFrom: number | null }>(
        `/v1/address/${address}/history${before ? `?before=${encodeURIComponent(before)}` : ''}`,
      );
      const ok =
        Array.isArray(r.items) &&
        r.items.length <= 200 &&
        r.items.every(isHistoryItem) &&
        (r.nextBefore === null || r.nextBefore === undefined || typeof r.nextBefore === 'string');
      return check(r, ok);
    },
  };
}

export type Api = ReturnType<typeof createApi>;

declare const __DEV__: boolean | undefined;
const DEV_BUILD = typeof __DEV__ !== 'undefined' && !!__DEV__;

/**
 * https everywhere. Plain http only in test builds, for a server on your own
 * Wi-Fi: the release app never talks to a server without encryption.
 */
export function isAllowedServerUrl(url: string, allowHttp: boolean = DEV_BUILD): boolean {
  // No user:pass@ part, a plain host, an optional port and path.
  const m = /^(https?):\/\/([a-z0-9.-]+)(:\d{1,5})?(\/[^\s]*)?$/i.exec(url.trim());
  if (!m) return false;
  if (m[1]!.toLowerCase() === 'https') return true;
  if (!allowHttp) return false;
  const host = m[2]!.toLowerCase();
  if (host === 'localhost') return true;
  // Plain http only to a private IP address written as numbers.
  const ip = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!ip || ip.slice(1).some((p) => Number(p) > 255)) return false;
  const [a, b] = [Number(ip[1]), Number(ip[2])];
  return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
}
