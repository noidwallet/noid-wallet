import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ApiError, type Api } from './api';
import { hasUnresolvedSend, reconcileOne, submitLoop, SubmitUnknown } from './send';
import type { BuiltTx, SendPlan } from './core';
import type { PendingTx } from './storage';

const plan = (fee = 9000): SendPlan => ({
  amount: 1_000_000,
  fee,
  totalSpend: 1_000_000 + fee,
  inputCount: 1,
  outputCount: 2,
  change: 5,
  spendable: 2_000_000,
  selectedSlots: [7],
  feeBreakdown: { base: 5000, input: 100, output: 1400, stateGrowth: 2500, requiredTotal: fee, burned: 2500 },
});

function harness(submitBehaviour: ('ok' | 'lost' | 'stale' | 'spent')[]) {
  const store = new Map<string, PendingTx>();
  const calls = { forge: 0, submit: [] as string[] };
  let n = 0;
  const api = {
    prepare: async () => ({ epochAnchorHex: '00'.repeat(32), slotHints: [1, 2], height: 1, activeSlotCount: 0, logSlots: 24, relayFloor: 5000 }),
    submit: async (_hex: string, txid: string) => {
      calls.submit.push(txid);
      const b = submitBehaviour.shift();
      if (b === 'lost') throw new ApiError('offline', 'lost');
      if (b === 'stale') throw new ApiError('stale_anchor', 'new block', 422, true);
      if (b === 'spent') throw new ApiError('inputs_spent', 'spent', 422, false);
      return { txid };
    },
  } as unknown as Api;
  const common = {
    api,
    secretHex: 'x',
    keyIndex: 0,
    address: 'o1me',
    pending: [] as PendingTx[],
    record: (p: PendingTx) => void store.set(p.txid, p),
    discard: (txid: string) => void store.delete(txid),
    forge: async (): Promise<BuiltTx> => {
      calls.forge++;
      n++;
      return {
        txid: `tx${n}`,
        intentHex: `a3${n}`,
        fee: 9000,
        amount: 1_000_000,
        change: 5,
        inputCount: 1,
        outputCount: 2,
        inputSlots: [7],
        outputSlots: [1, 2],
        proveMs: 1,
      };
    },
  };
  const build = async () => ({ utxos: [], plan: plan(), outputs: 2 as const });
  return { store, calls, common, build };
}

test('lost reply: keeps the saved tx, never builds a second one', async () => {
  const h = harness(['lost']);
  await assert.rejects(submitLoop(h.common, 'send', 'o1to', 9000, h.build), SubmitUnknown);
  assert.equal(h.calls.forge, 1);
  assert.deepEqual([...h.store.values()].map((p) => [p.txid, p.state]), [['tx1', 'submitting']]);
  assert.ok(hasUnresolvedSend([...h.store.values()]));
});

test('new sends are blocked while one is unresolved', async () => {
  const h = harness(['ok']);
  h.common.pending = [{ txid: 'tx0', state: 'submitting' } as PendingTx];
  await assert.rejects(submitLoop(h.common, 'send', 'o1to', 9000, h.build), /still being checked/);
  assert.equal(h.calls.forge, 0);
});

test('clear refusal (new block) discards and rebuilds; only the accepted tx is kept', async () => {
  const h = harness(['stale', 'ok']);
  const res = await submitLoop(h.common, 'send', 'o1to', 9000, h.build);
  assert.equal(h.calls.forge, 2);
  assert.equal(res.pending.txid, 'tx2');
  assert.deepEqual([...h.store.values()].map((p) => [p.txid, p.state]), [['tx2', 'submitted']]);
});

test('permanent refusal is not retried', async () => {
  const h = harness(['spent']);
  await assert.rejects(submitLoop(h.common, 'send', 'o1to', 9000, h.build), /spent/);
  assert.equal(h.calls.forge, 1);
  assert.equal(h.store.size, 0);
});

test('fee changed after review stops before forging', async () => {
  const h = harness(['ok']);
  await assert.rejects(
    submitLoop(h.common, 'send', 'o1to', 8000, h.build),
    (e: Error) => e.name === 'Error' && /fee changed/.test(e.message),
  );
  assert.equal(h.calls.forge, 0);
});

test('reconcile: resend the identical intent, drop only on definite refusal', async () => {
  const saved = { txid: 'abc', state: 'submitting', intentHex: 'a3ff' } as PendingTx;
  const sent: string[] = [];
  const mk = (status: string, submit: () => Promise<unknown>) =>
    ({
      tx: async () => ({ txid: 'abc', status }),
      submit: async (hex: string) => {
        sent.push(hex);
        return submit();
      },
    }) as unknown as Api;

  assert.equal(await reconcileOne(mk('confirmed', async () => ({})), saved), null);
  assert.equal((await reconcileOne(mk('pending', async () => ({})), saved))?.state, 'submitted');
  assert.equal((await reconcileOne(mk('unknown', async () => ({ txid: 'abc' })), saved))?.state, 'submitted');
  assert.deepEqual(sent, ['a3ff']);
  assert.equal(
    await reconcileOne(mk('unknown', async () => Promise.reject(new ApiError('inputs_spent', 'x', 422))), saved),
    null,
  );
  assert.equal(
    (await reconcileOne(mk('unknown', async () => Promise.reject(new ApiError('offline', 'x'))), saved))?.state,
    'submitting',
  );
  assert.equal(
    (await reconcileOne(mk('unknown', async () => Promise.reject(new ApiError('busy', 'x', 422))), saved))?.state,
    'submitting',
  );
});
