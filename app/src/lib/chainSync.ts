// The chain-check sync loop, kept free of native and React imports so it can
// be tested in Node. lib/chain.ts wires it to the core, storage and screens.
import type { HeadersPage } from './api';
import type { ChainInfo, ChainState, SyncResult } from './core';

/** Pages per sync: 40 x 300 headers (12,000 blocks, about 4 days). More waits for the next refresh. */
export const MAX_PAGES_PER_SYNC = 40;
export const PAGE = 300;
/** Fork handling: when the next header doesn't link, ask again from this far back. */
export const FORK_LOOKBACK = 17;

export interface SyncDeps {
  headers: (from: number, count: number) => Promise<HeadersPage>;
  chainInfo: (state: ChainState | null) => Promise<ChainInfo>;
  syncHeaders: (state: ChainState | null, headersHex: string[], now: number) => Promise<SyncResult>;
  /** Seconds since the Unix epoch, the phone's clock. */
  now: () => number;
  load: () => ChainState | null;
  save: (state: ChainState) => void;
  clear: () => void;
  /** Called whenever the checked tip moves. */
  progress?: (info: ChainInfo, serverTip: number) => void;
}

export type SyncOutcome =
  | { kind: 'ready'; info: ChainInfo; serverTip: number }
  | { kind: 'problem'; info: ChainInfo | null; serverTip: number; code: string; height: number | null };

function isBadState(e: unknown): boolean {
  return !!e && typeof e === 'object' && (e as { code?: unknown }).code === 'bad_state';
}

/**
 * Bring the stored chain view up to `serverTip`, page by page. A refusal
 * leaves the stored view as it was (the core never adopts a refused header).
 */
export async function runSync(deps: SyncDeps, serverTip: number): Promise<SyncOutcome> {
  let current = deps.load();
  let info: ChainInfo;
  try {
    info = await deps.chainInfo(current);
  } catch (e) {
    if (!isBadState(e)) throw e;
    // Unusable saved data: start again from the built-in checkpoint.
    deps.clear();
    current = null;
    info = await deps.chainInfo(null);
  }
  let tip = serverTip;
  let from = info.tipHeight + 1;
  // The phone is ahead of the server: the server is on another branch (or
  // the phone was fed one). Ask from a little below the server's tip so the
  // core can weigh the two; it refuses the server's branch if it has less work.
  if (serverTip < info.tipHeight) from = Math.max(info.checkpointHeight + 1, serverTip - FORK_LOOKBACK);
  let retriedFork = false;
  for (let page = 0; page < MAX_PAGES_PER_SYNC && from <= tip; page++) {
    const r = await deps.headers(from, PAGE);
    tip = Math.max(tip, r.tip);
    if (r.headers.length === 0) break;
    const out = await deps.syncHeaders(current, r.headers, deps.now());
    if (out.accepted > 0) {
      current = out.state;
      info = out.info;
      deps.save(current);
      deps.progress?.(info, tip);
    }
    if (out.refused) {
      // The server's chain may have forked just below our tip: ask again from
      // a little further back, once, so the core can weigh that branch.
      if (out.refused.code === 'bad_parent_hash' && !retriedFork && out.refused.height === info.tipHeight + 1) {
        retriedFork = true;
        from = Math.max(info.checkpointHeight + 1, info.tipHeight - FORK_LOOKBACK);
        continue;
      }
      return { kind: 'problem', info, serverTip: tip, code: out.refused.code, height: out.refused.height };
    }
    from = info.tipHeight + 1;
  }
  return { kind: 'ready', info, serverTip: tip };
}
