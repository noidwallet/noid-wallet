// Client for the wallet backend (/backend). The phone never sends secrets here:
// it only reads public chain data and submits finished, proven transactions.
import type { FeeContext, Utxo } from './core';

const DEFINITE_REJECTIONS = new Set(['fee_too_low', 'stale_anchor', 'stale_inputs', 'inputs_spent', 'busy', 'rejected']);

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
  features?: { price?: boolean; push?: boolean };
}

export interface Price {
  usd: number;
  ngn: number | null;
  source: string;
  updatedAt: number;
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
  counterparty: string | null;
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
      throw new ApiError(
        body.error?.code ?? 'http_error',
        body.error?.message ?? `Server error (${res.status}).`,
        res.status,
        body.error?.retryable ?? false,
      );
    }
    return body;
  }

  return {
    status: () => request<Status>('/v1/status'),
    utxos: (address: string) =>
      request<{ address: string; balance: number; utxos: Utxo[] }>(`/v1/address/${address}/utxos`),
    prepare: (outputs: 1 | 2) => request<Prepared>('/v1/prepare', { method: 'POST', body: JSON.stringify({ outputs }) }),
    /** Idempotent: resubmitting the same intent returns success, never a second payment. */
    submit: (intentHex: string, txid: string) =>
      request<{ txid: string; already?: boolean }>(
        '/v1/submit',
        { method: 'POST', body: JSON.stringify({ intentHex, txid }) },
        100_000,
      ),
    tx: (txid: string) => request<TxStatus>(`/v1/tx/${txid}`),
    price: () => request<Price>('/v1/price', undefined, 10_000),
    pushSubscribe: (address: string, token: string) =>
      request<{ ok: true }>('/v1/push/subscribe', { method: 'POST', body: JSON.stringify({ address, token }) }),
    pushUnsubscribe: (address: string, token: string) =>
      request<{ ok: true }>('/v1/push/unsubscribe', { method: 'POST', body: JSON.stringify({ address, token }) }),
    history: (address: string, before?: string) =>
      request<{ items: HistoryItem[]; nextBefore: string | null; indexedFrom: number | null }>(
        `/v1/address/${address}/history${before ? `?before=${encodeURIComponent(before)}` : ''}`,
      ),
  };
}

export type Api = ReturnType<typeof createApi>;

/** https everywhere, plain http only for a server on your own Wi-Fi during testing. */
export function isAllowedServerUrl(url: string): boolean {
  // No user:pass@ part, a plain host, an optional port and path.
  const m = /^(https?):\/\/([a-z0-9.-]+)(:\d{1,5})?(\/[^\s]*)?$/i.exec(url.trim());
  if (!m) return false;
  if (m[1]!.toLowerCase() === 'https') return true;
  const host = m[2]!.toLowerCase();
  if (host === 'localhost') return true;
  // Plain http only to a private IP address written as numbers.
  const ip = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!ip || ip.slice(1).some((p) => Number(p) > 255)) return false;
  const [a, b] = [Number(ip[1]), Number(ip[2])];
  return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
}
