// Sending a token or NFT (NOID 1.2): ask the server for the node's plan,
// let the core check it and work out the review, then (after the user
// confirms) check it again, add the wallet fee, prove, save and submit.
//
// The same safety rules as NOID payments (lib/send.ts): the transfer is saved
// before it is sent and only ever re-sent as the identical bytes; a refusal
// is remembered so the next spend must reuse one of its NOID coins; a fee
// that changed after review is never charged silently.
import { ApiError, type Api, type NativePrepareBody } from './api';
import type { BuiltNativeSend, NativeSendRequest, NativeSendReview, NativeTransfer, Utxo } from './core';
import { checkRefusals, clearRefusals, feeLooksWrong, hasUnresolvedSend, noteRefused, SubmitUnknown, type Stage } from './send';
import type { PendingTx } from './storage';
import { NATIVE_WALLET_FEE } from './walletFee';

type NativeCore = {
  checkNativeSend: (owner: string, request: NativeSendRequest, pendingOutputSlots: number[]) => Promise<NativeSendReview>;
  buildNativeSend: (secretHex: string, keyIndex: number, request: NativeSendRequest, pendingOutputSlots: number[]) => Promise<BuiltNativeSend>;
};

// Loaded lazily so this module (and its tests) can run without the native module.
async function realCore(): Promise<NativeCore> {
  return (await import('./core')).core;
}

/** The plan changed what the user pays after review: show the new review. */
export class NativeFeeChanged extends Error {
  constructor(readonly review: NativeSendReview) {
    super('The network fee changed while sending. Review the new fee.');
  }
}

function body(owner: string, t: NativeTransfer): NativePrepareBody {
  return t.kind === 'token'
    ? { owner, action: 'transfer_token', assetId: t.assetId, units: t.units, recipient: t.recipient }
    : { owner, action: 'transfer_nft', collectionId: t.collectionId, serial: t.serial, recipient: t.recipient };
}

const pendingOutputs = (pending: PendingTx[]) => pending.flatMap((p) => p.outputSlots);
const pendingInputs = (pending: PendingTx[]) => new Set(pending.flatMap((p) => p.inputSlots));

/** Belt and braces on top of the core's checks: the review is what was asked. */
function reviewMatches(r: NativeSendReview, t: NativeTransfer): boolean {
  if (r.recipient !== t.recipient || r.kind !== t.kind) return false;
  if (r.walletFee !== NATIVE_WALLET_FEE || r.noidDebit !== r.networkFee + r.walletFee) return false;
  if (feeLooksWrong(r.networkFee, r.inputCount, r.outputCount)) return false;
  return t.kind === 'token'
    ? r.assetId === t.assetId && r.units === t.units
    : r.collectionId === t.collectionId && r.serial === t.serial;
}

/** Get a plan from the server and the phone's own review of it. */
export async function reviewNativeSend(
  api: Api,
  owner: string,
  pending: PendingTx[],
  transfer: NativeTransfer,
  core?: NativeCore,
): Promise<{ request: NativeSendRequest; review: NativeSendReview }> {
  const prepared = await api.nativePrepare(body(owner, transfer));
  const request: NativeSendRequest = { plan: prepared.plan, transfer, slotHints: prepared.slotHints, relayFloor: prepared.relayFloor };
  const review = await (core ?? (await realCore())).checkNativeSend(owner, request, pendingOutputs(pending));
  if (!reviewMatches(review, transfer)) {
    throw new Error('The transfer your wallet server prepared is not the one you asked for, so nothing was signed.');
  }
  return { request, review };
}

export interface NativeSendOpts {
  api: Api;
  secretHex: string;
  keyIndex: number;
  address: string;
  pending: PendingTx[];
  record: (p: PendingTx) => Promise<void> | void;
  discard: (txid: string) => Promise<void> | void;
  transfer: NativeTransfer;
  /** What the user reviewed: the NOID it costs must not change silently. */
  reviewed: NativeSendReview;
  /** Shown in Activity: "30 NEMO", "Cool Cats #3". */
  itemLabel: string;
  onStage?: (stage: Stage, attempt: number) => void;
  /** Test hooks. */
  core?: NativeCore;
  utxos?: () => Promise<Utxo[]>;
}

export async function executeNativeSend(c: NativeSendOpts): Promise<{ built: BuiltNativeSend; pending: PendingTx }> {
  if (hasUnresolvedSend(c.pending)) {
    throw new Error('Your last send is still being checked. Wait until it shows as sent or failed.');
  }
  const core = c.core ?? (await realCore());
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    c.onStage?.(attempt === 0 ? 'preparing' : 'retrying', attempt);
    const { request, review } = await reviewNativeSend(c.api, c.address, c.pending, c.transfer, core);
    if (review.noidDebit !== c.reviewed.noidDebit) throw new NativeFeeChanged(review);

    c.onStage?.('forging', attempt);
    const built = await core.buildNativeSend(c.secretHex, c.keyIndex, request, pendingOutputs(c.pending));
    const b = built.review;
    if (
      !reviewMatches(b, c.transfer) ||
      b.noidDebit !== review.noidDebit ||
      b.txid !== review.txid ||
      built.txid !== review.txid
    ) {
      throw new Error('The wallet built a different transfer than the one you reviewed, so it was not sent. Try again.');
    }
    const noidSlots = built.noidInputs.map((i) => i.slotIndex);
    const locked = pendingInputs(c.pending);
    if (noidSlots.some((s) => locked.has(s))) {
      throw new Error('This transfer would reuse NOID from a payment that hasn’t confirmed yet. Try again in a minute.');
    }
    const utxos = c.utxos ? await c.utxos() : (await c.api.utxos(c.address)).utxos;
    checkRefusals(c.address, utxos, noidSlots, Date.now(), b.parentHeight);

    const record: PendingTx = {
      txid: built.txid,
      kind: c.transfer.kind,
      item: c.itemLabel,
      state: 'submitting',
      intentHex: built.intentHex,
      to: c.transfer.recipient,
      amount: 0,
      fee: b.networkFee,
      walletFee: b.walletFee,
      inputSlots: noidSlots,
      inputIds: built.noidInputs.map((i) => i.creationId),
      outputSlots: built.outputSlots,
      createdAt: Date.now(),
      builtAtHeight: b.parentHeight,
    };
    // Saved before sending: from here on, this exact transfer is the only one.
    await c.record(record);

    c.onStage?.('submitting', attempt);
    try {
      await c.api.submit(built.intentHex, built.txid);
    } catch (e) {
      if (!(e instanceof ApiError) || e.ambiguous) throw new SubmitUnknown(built.txid);
      await c.discard(built.txid);
      noteRefused(c.address, noidSlots, b.parentHeight);
      lastError = e;
      if (!e.retryable) throw e;
      await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
      continue;
    }
    clearRefusals(c.address, noidSlots);
    const sent: PendingTx = { ...record, state: 'submitted' };
    await c.record(sent);
    return { built, pending: sent };
  }
  throw lastError instanceof Error ? lastError : new Error('The transfer could not be sent. Try again.');
}
