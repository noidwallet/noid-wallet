import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ApiError, type Api, type NativePrepareBody } from './api';
import type { BuiltNativeSend, NativeSendReview, NativeTransfer } from './core';
import { executeNativeSend, NativeFeeChanged, reviewNativeSend } from './nativeSend';
import { checkRefusals, RefusedButSpent, resetRefusals, SubmitUnknown } from './send';
import type { PendingTx } from './storage';
import { NATIVE_WALLET_FEE } from './walletFee';

const ME = 'o1wrznmh6td3mgg9mu0a3kkxxn2lnfu827uykrnpaa90mex8su9zcs5sjxrk';
const TO = 'o1s32s5m9ughjv2ktvxm8m7y0gmu0swys5t0ufkdnyhv02nudc23cqg7y34s';
const ASSET = 'a'.repeat(64);
const transfer: NativeTransfer = { kind: 'token', assetId: ASSET, units: '30000000', recipient: TO };

function review(over: Partial<NativeSendReview> = {}): NativeSendReview {
  const networkFee = over.networkFee ?? 12_000;
  return {
    kind: 'token',
    recipient: TO,
    assetId: ASSET,
    units: '30000000',
    collectionId: null,
    serial: null,
    networkFee,
    walletFee: NATIVE_WALLET_FEE,
    noidDebit: networkFee + NATIVE_WALLET_FEE,
    inputCount: 2,
    outputCount: 4,
    parentHeight: 280_000,
    parentId: 'b'.repeat(64),
    txid: 't1',
    ...over,
  };
}

function harness(opts: { submits?: ('ok' | 'lost' | 'stale' | 'rejected')[]; reviews?: NativeSendReview[]; built?: Partial<BuiltNativeSend> } = {}) {
  resetRefusals();
  const store = new Map<string, PendingTx>();
  const calls = { prepare: [] as NativePrepareBody[], build: 0, submit: [] as string[] };
  const reviews = opts.reviews ?? [];
  const api = {
    nativePrepare: async (b: NativePrepareBody) => {
      calls.prepare.push(b);
      return { plan: { any: 'thing' }, slotHints: [500], relayFloor: 0 };
    },
    submit: async (_hex: string, txid: string) => {
      calls.submit.push(txid);
      const b = opts.submits?.shift() ?? 'ok';
      if (b === 'lost') throw new ApiError('offline', 'lost');
      if (b === 'stale') throw new ApiError('stale_anchor', 'new block', 422, true);
      if (b === 'rejected') throw new ApiError('rejected', 'no', 422, false);
      return { txid };
    },
  } as unknown as Api;
  const core = {
    checkNativeSend: async () => reviews.shift() ?? review(),
    buildNativeSend: async (): Promise<BuiltNativeSend> => {
      calls.build++;
      return {
        review: review(),
        intentHex: 'ab',
        txid: 't1',
        noidInputs: [{ slotIndex: 7, creationId: '42' }],
        recordInputSlots: [8],
        outputSlots: [500, 501, 502, 503],
        proveMs: 10,
        ...opts.built,
      };
    },
  };
  const c = {
    api,
    secretHex: 'x',
    keyIndex: 0,
    address: ME,
    pending: [] as PendingTx[],
    record: (p: PendingTx) => void store.set(p.txid, p),
    discard: (txid: string) => void store.delete(txid),
    transfer,
    reviewed: review(),
    itemLabel: '30 NEMO',
    core,
    utxos: async () => [{ slotIndex: 7, value: 1_000_000, creationId: '42' }],
  };
  return { c, store, calls };
}

test('review: asks for exactly the transfer, and refuses a plan that is something else', async () => {
  const h = harness();
  const r = await reviewNativeSend(h.c.api, ME, [], transfer, h.c.core);
  assert.equal(r.review.noidDebit, 17_000);
  assert.deepEqual(h.calls.prepare[0], { owner: ME, action: 'transfer_token', assetId: ASSET, units: '30000000', recipient: TO });
  for (const bad of [review({ recipient: ME }), review({ units: '30000001' }), review({ walletFee: 0, noidDebit: 12_000 }), review({ networkFee: 900_000 })]) {
    const g = harness({ reviews: [bad] });
    await assert.rejects(reviewNativeSend(g.c.api, ME, [], transfer, g.c.core), /not the one you asked for/);
  }
});

test('send: saved before submitting, then marked submitted, with NOID coins as its inputs', async () => {
  const h = harness();
  const { pending } = await executeNativeSend(h.c);
  assert.equal(pending.state, 'submitted');
  assert.deepEqual(
    { kind: pending.kind, item: pending.item, to: pending.to, amount: pending.amount, fee: pending.fee, walletFee: pending.walletFee },
    { kind: 'token', item: '30 NEMO', to: TO, amount: 0, fee: 12_000, walletFee: NATIVE_WALLET_FEE },
  );
  assert.deepEqual([pending.inputSlots, pending.inputIds], [[7], ['42']]);
  assert.deepEqual(h.calls.submit, ['t1']);
  assert.equal(h.store.get('t1')?.state, 'submitted');
});

test('send: a changed fee is never charged silently', async () => {
  const h = harness({ reviews: [review({ networkFee: 13_000 })] });
  await assert.rejects(executeNativeSend(h.c), (e) => e instanceof NativeFeeChanged && e.review.noidDebit === 18_000);
  assert.equal(h.calls.build, 0);
});

test('send: a built transfer that differs from the review is not sent', async () => {
  const h = harness({ built: { review: review({ units: '1' }) } });
  await assert.rejects(executeNativeSend(h.c), /different transfer/);
  assert.equal(h.calls.submit.length, 0);
  assert.equal(h.store.size, 0);
});

test('send: a lost reply keeps the saved transfer and never builds another', async () => {
  const h = harness({ submits: ['lost'] });
  await assert.rejects(executeNativeSend(h.c), (e) => e instanceof SubmitUnknown && e.txid === 't1');
  assert.equal(h.store.get('t1')?.state, 'submitting');
  assert.equal(h.calls.build, 1);
});

test('send: a clear refusal is dropped and remembered, so the next spend must reuse its NOID', async () => {
  const h = harness({ submits: ['rejected'] });
  await assert.rejects(executeNativeSend(h.c), (e) => e instanceof ApiError && e.code === 'rejected');
  assert.equal(h.store.size, 0);
  const utxos = [{ slotIndex: 7, value: 1_000_000, creationId: '42' }, { slotIndex: 9, value: 5_000_000, creationId: '43' }];
  assert.throws(() => checkRefusals(ME, utxos, [9]), (e) => e instanceof RefusedButSpent && !e.missing);
  assert.doesNotThrow(() => checkRefusals(ME, utxos, [7]));
});

test('send: a new block while sending rebuilds once and sends the new transfer', async () => {
  const h = harness({ submits: ['stale', 'ok'] });
  const { pending } = await executeNativeSend(h.c);
  assert.equal(pending.state, 'submitted');
  assert.equal(h.calls.build, 2);
  assert.deepEqual(h.calls.submit, ['t1', 't1']);
});

test('send: refuses to reuse NOID from a payment still pending', async () => {
  const h = harness();
  h.c.pending = [
    { txid: 'p', kind: 'send', state: 'submitted', intentHex: '', to: TO, amount: 1, fee: 1, inputSlots: [7], outputSlots: [], createdAt: 0 },
  ];
  await assert.rejects(executeNativeSend(h.c), /hasn’t confirmed/);
  assert.equal(h.calls.submit.length, 0);
});

test('review: a plan built on a block the phone knows differently is refused', async () => {
  const h = harness();
  await assert.rejects(
    reviewNativeSend(h.c.api, ME, [], transfer, h.c.core, (height) => (height === 280_000 ? 'c'.repeat(64) : null)),
    /different chain/,
  );
  const ok = await reviewNativeSend(h.c.api, ME, [], transfer, h.c.core, (height) => (height === 280_000 ? 'b'.repeat(64) : null));
  assert.equal(ok.review.parentHeight, 280_000);
  // Unknown to the phone (the usual case: the plan is on the newest block): no verdict.
  await reviewNativeSend(h.c.api, ME, [], transfer, h.c.core, () => null);
});
