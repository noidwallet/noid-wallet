import { test } from 'node:test';
import assert from 'node:assert/strict';

import { FORK_LOOKBACK, MAX_PAGES_PER_SYNC, PAGE, runSync, type SyncDeps } from './chainSync';
import type { ChainInfo, ChainState, SyncResult } from './core';

const CP = 274_821;

/** A fake core: header "hex" is just the height as a string; `bad` heights are refused. */
function fakeCore(opts: { bad?: Map<number, string>; forkAt?: number; serverTip?: number } = {}) {
  const info = (tip: number): ChainInfo => ({ checkpointHeight: CP, tipHeight: tip, tipId: `id${tip}`, tipTimestamp: 1_793_627_659 + (tip - CP) * 30 });
  const stateFor = (tip: number): ChainState => ({ v: 1, checkpoint: CP, headers: [], workBefore: '00', ids: { [tip]: `id${tip}` } });
  const tipOf = (s: ChainState | null) => (s ? Number(Object.keys(s.ids)[0]) : CP);
  const calls: { from: number; n: number }[] = [];
  const deps: SyncDeps & { calls: typeof calls; saved: ChainState[]; cleared: number } = {
    calls,
    saved: [],
    cleared: 0,
    headers: async (from, count) => {
      calls.push({ from, n: count });
      const tip = opts.serverTip ?? 276_000;
      const headers: string[] = [];
      for (let h = from; h < from + count && h <= tip; h++) headers.push(String(h));
      return { from, tip, headers };
    },
    chainInfo: async (s) => {
      if (s && s.v !== 1) throw Object.assign(new Error('bad'), { code: 'bad_state' });
      return info(tipOf(s));
    },
    syncHeaders: async (s, hex, now): Promise<SyncResult> => {
      let tip = tipOf(s);
      let accepted = 0;
      let refused: SyncResult['refused'] = null;
      for (const h of hex) {
        const height = Number(h);
        if (height <= tip) continue; // already known
        if (height !== tip + 1) {
          refused = { height, code: 'gap' };
          break;
        }
        const bad = opts.bad?.get(height);
        if (bad) {
          refused = { height, code: bad };
          break;
        }
        if (opts.forkAt === height && now < 0) break;
        tip = height;
        accepted++;
      }
      return { state: stateFor(tip), info: info(tip), accepted, refused, reorgDepth: 0 };
    },
    now: () => 1_800_000_000,
    load: () => null,
    save: (s) => deps.saved.push(s),
    clear: () => deps.cleared++,
  };
  return deps;
}

test('syncs page by page up to the server tip and saves after each page', async () => {
  const deps = fakeCore();
  const out = await runSync(deps, 276_000);
  assert.equal(out.kind, 'ready');
  assert.equal(out.info.tipHeight, 276_000);
  assert.equal(deps.calls.length, Math.ceil((276_000 - CP) / PAGE));
  assert.deepEqual(deps.calls[0], { from: CP + 1, n: PAGE });
  assert.equal(deps.saved.length, deps.calls.length);
});

test('a refused header stops the sync, keeps the good prefix, and reports the reason', async () => {
  const deps = fakeCore({ bad: new Map([[CP + 350, 'bad_pow']]) });
  const out = await runSync(deps, 276_000);
  assert.equal(out.kind, 'problem');
  if (out.kind === 'problem') {
    assert.equal(out.code, 'bad_pow');
    assert.equal(out.height, CP + 350);
    assert.equal(out.info?.tipHeight, CP + 349);
  }
  assert.equal(deps.calls.length, 2);
});

test('a parent mismatch at tip + 1 is retried once from 17 blocks back', async () => {
  const deps = fakeCore({ bad: new Map([[CP + 1, 'bad_parent_hash']]) });
  const out = await runSync(deps, 276_000);
  // Our fake core keeps refusing, so this ends as a problem, but the second
  // request must have asked from further back, and only once.
  assert.equal(out.kind, 'problem');
  assert.equal(deps.calls[1]!.from, Math.max(CP + 1, CP - FORK_LOOKBACK));
  assert.equal(deps.calls.length, 2);
});

test('bounded work per sync, and nothing to do when already at the tip', async () => {
  const deps = fakeCore({ serverTip: CP + PAGE * (MAX_PAGES_PER_SYNC + 5) });
  const far = await runSync(deps, CP + PAGE * (MAX_PAGES_PER_SYNC + 5));
  assert.equal(far.kind, 'ready');
  assert.equal(deps.calls.length, MAX_PAGES_PER_SYNC);
  const deps2 = fakeCore();
  deps2.load = () => ({ v: 1, checkpoint: CP, headers: [], workBefore: '00', ids: { 276_000: 'id276000' } });
  const done = await runSync(deps2, 276_000);
  assert.equal(done.kind, 'ready');
  assert.equal(deps2.calls.length, 0);
});

test('unusable saved data is cleared and the sync restarts from the checkpoint', async () => {
  const deps = fakeCore();
  deps.load = () => ({ v: 2, checkpoint: CP, headers: [], workBefore: '00', ids: {} });
  const out = await runSync(deps, CP + 10);
  assert.equal(out.kind, 'ready');
  assert.equal(deps.cleared, 1);
  assert.equal(deps.calls[0]!.from, CP + 1);
});
