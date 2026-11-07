// The phone's own chain check (NOID 1.2).
//
// Starting from a checkpoint built into the app (block 274,821), the core
// checks every block header the server sends: proof of work, difficulty,
// timing, links and a floor on total work (core/src/chain.rs). A block only
// counts as checked once it is 8 deep with enough real work on top. The
// result is kept on the phone between runs. Screens read it with useChain().
//
// What it gives: a wallet server can't get a block counted as checked
// without real mining work. Coin proofs (lib/coinProofs.ts) build on it:
// once the server offers them, the phone checks its coins against these
// headers. Payments inside a block are not proven yet.
import { useSyncExternalStore } from 'react';

import type { Api } from './api';
import { runSync } from './chainSync';
import { core, CoreError, type ChainInfo, type ChainState } from './core';
import { storage } from './storage';

/** The checked tip is "stale" past this (server tip well ahead, or no sync in a while). */
export const STALE_AFTER_MS = 30 * 60_000;

export interface ChainProblem {
  /** A refusal code from the core (bad_pow, too_far_in_future, work_too_low...), or `server`. */
  code: string;
  /** Height of the header that was refused, when known. */
  height: number | null;
  message: string;
}

export interface ChainStatus {
  /** No server feature yet, or never synced. */
  kind: 'off' | 'syncing' | 'ready' | 'problem';
  info: ChainInfo | null;
  /** Highest block the server reported in the last sync. */
  serverTip: number | null;
  lastSyncAt: number | null;
  problem: ChainProblem | null;
}

let state: ChainState | null | undefined;
let status: ChainStatus = { kind: 'off', info: null, serverTip: null, lastSyncAt: null, problem: null };
const listeners = new Set<() => void>();
let inFlight: Promise<void> | null = null;

function set(next: Partial<ChainStatus>) {
  status = { ...status, ...next };
  for (const l of listeners) l();
}

function loadState(): ChainState | null {
  if (state !== undefined) return state;
  const raw = storage.loadChain();
  state = isState(raw) ? raw : null;
  return state;
}

function isState(x: unknown): x is ChainState {
  const s = x as ChainState | null;
  return (
    !!s &&
    typeof s === 'object' &&
    s.v === 1 &&
    typeof s.checkpoint === 'number' &&
    Array.isArray(s.headers) &&
    s.headers.every((h) => typeof h === 'string') &&
    typeof s.workBefore === 'string' &&
    !!s.ids &&
    typeof s.ids === 'object'
  );
}

export function problemText(code: string, height: number | null): string {
  const at = height !== null ? ` at block ${height.toLocaleString()}` : '';
  switch (code) {
    case 'too_far_in_future':
      return `A block${at} is dated later than your phone's clock allows. Check that your phone's date and time are right.`;
    case 'work_too_low':
      return 'The chain this server sends has far less mining work behind it than the real network. Do not trust balances from this server.';
    case 'bad_state':
      return 'The saved chain data was unusable and has been reset. The check starts again from the built-in checkpoint.';
    case 'less_work':
    case 'too_deep':
      return `This server follows a branch of the chain${at} that your phone will not take (${code.replace(/_/g, ' ')}). Do not trust balances from this server until this clears.`;
    default:
      return `A block${at} failed the check (${code.replace(/_/g, ' ')}). Do not trust balances from this server until this clears.`;
  }
}

/**
 * Bring the phone's chain view up to the server's tip, page by page. Safe to
 * call often: one sync runs at a time, and a refusal leaves the saved view as
 * it was. `serverTip` is what /v1/status reported.
 */
export function syncChain(api: Api, serverTip: number): Promise<void> {
  if (inFlight) return inFlight;
  inFlight = run(api, serverTip).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function run(api: Api, serverTip: number) {
  set({ kind: 'syncing', serverTip });
  try {
    const out = await runSync(
      {
        headers: (from, count) => api.headers(from, count),
        chainInfo: (s) => core.chainInfo(s),
        syncHeaders: (s, hex, now) => core.syncHeaders(s, hex, now),
        now: () => Math.floor(Date.now() / 1000),
        load: loadState,
        save: (s) => {
          state = s;
          storage.saveChain(s);
        },
        clear: () => {
          state = null;
          storage.clearChain();
        },
        progress: (info, tip) => set({ info, serverTip: tip }),
      },
      serverTip,
    );
    if (out.kind === 'ready') set({ kind: 'ready', info: out.info, serverTip: out.serverTip, lastSyncAt: Date.now(), problem: null });
    else set({ kind: 'problem', info: out.info, serverTip: out.serverTip, problem: { code: out.code, height: out.height, message: problemText(out.code, out.height) } });
  } catch (e) {
    if (e instanceof CoreError) {
      set({ kind: 'problem', problem: { code: e.code, height: null, message: problemText(e.code, null) } });
    } else {
      // A dropped request or a server without the route: not a verdict on the
      // chain. Keep what was verified; the next refresh tries again.
      set({ kind: status.info ? 'ready' : 'off' });
    }
  }
}

/**
 * Forget the saved chain view and check again from the built-in checkpoint.
 * For when the phone refuses the server's chain as a deeper branch: blocks
 * that never counted as checked may have come from a server holding back the
 * real chain.
 */
export function restartChain(api: Api, serverTip: number): Promise<void> {
  if (inFlight) return inFlight;
  state = null;
  storage.clearChain();
  set({ info: null, problem: null });
  return syncChain(api, serverTip);
}

/** The saved chain view, for checks against the phone's own headers (coin proofs). */
export function chainState(): ChainState | null {
  return loadState();
}

/** The block id the phone verified at `height`, if it still remembers it (any depth). */
export function knownBlockId(height: number): string | null {
  const s = loadState();
  return s?.ids[String(height)] ?? null;
}

/**
 * Whether the block the server reported for a payment is on the chain the
 * phone checked: true (same id), false (a different block at that height),
 * or null (that height is not checked or no longer remembered).
 */
export function blockChecked(height: number, blockHash: string | null | undefined): boolean | null {
  if (!blockHash) return null;
  const info = status.info;
  // Blocks near the tip don't count yet: a block counts once it is 8 deep
  // and enough real mining work is built on top of it (core/src/chain.rs,
  // checked_height), so cheap blocks from a server can't make it count.
  if (!info || height > info.checkedHeight || height <= info.checkpointHeight) return null;
  const s = loadState();
  const id = s?.ids[String(height)];
  if (!id) return null;
  return id === blockHash.toLowerCase();
}

export function useChain(): ChainStatus {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => status,
  );
}

/** For a fresh wallet or a server change: forget nothing (the chain is public), just re-read. */
export function reloadChain() {
  state = undefined;
}

/** Test seam. */
export const _test = { set, isState };
