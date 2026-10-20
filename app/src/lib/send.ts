// Plan -> (user reviews) -> forge proof on the phone -> save -> submit.
//
// Double-payment safety: every built transaction is saved BEFORE it is sent.
// If the reply is lost (network drop, timeout, server error) we do not know
// whether the network has it, so we never build a replacement. The wallet
// re-sends the same saved transaction instead, which can only ever be
// accepted once (same coins, same txid).
//
// Retries follow the official wallet: up to 3 attempts, rebuilding only after
// the node clearly refused (fee rose, new block, coins in use). A fee that
// changed after review is never charged silently.
import { ApiError, type Api } from './api';
import type { BuiltTx, ConsolidationPlan, SendPlan, Utxo } from './core';
import type { PendingTx } from './storage';

export class FeeChanged extends Error {
  constructor(readonly newPlan: SendPlan | ConsolidationPlan) {
    super('The network fee changed while sending. Review the new fee.');
  }
}

/** The transaction was saved and may have reached the network; the wallet keeps checking. */
export class SubmitUnknown extends Error {
  constructor(readonly txid: string) {
    super('No answer from the network yet. Your wallet is checking whether the transaction went through. Do not send it again.');
  }
}

export type Stage = 'preparing' | 'forging' | 'submitting' | 'retrying';

// Loaded lazily so this module (and its tests) can run without the native module.
async function getCore() {
  return (await import('./core')).core;
}

type Forge = (a: Parameters<Awaited<ReturnType<typeof getCore>>['buildTransaction']>[0]) => Promise<BuiltTx>;

interface Common {
  api: Api;
  secretHex: string;
  keyIndex: number;
  address: string;
  pending: PendingTx[];
  /** Persist (insert or replace by txid) before and after submitting. */
  record: (p: PendingTx) => Promise<void> | void;
  /** Drop a record the node definitely refused. */
  discard: (txid: string) => Promise<void> | void;
  onStage?: (stage: Stage, attempt: number) => void;
  /** Test hook; defaults to the Rust core. */
  forge?: Forge;
}

export function hasUnresolvedSend(pending: PendingTx[]) {
  return pending.some((p) => p.state === 'submitting');
}

function pendingInputs(pending: PendingTx[]) {
  return pending.flatMap((p) => p.inputSlots);
}
function pendingOutputs(pending: PendingTx[]) {
  return pending.flatMap((p) => p.outputSlots);
}

export async function planSend(api: Api, address: string, pending: PendingTx[], amount: number) {
  const [{ utxos }, ctx] = await Promise.all([api.utxos(address), api.status()]);
  const core = await getCore();
  const plan = await core.planSend({
    utxos,
    pendingInputSlots: pendingInputs(pending),
    amount,
    fee: null,
    activeSlotCount: ctx.activeSlotCount,
    logSlots: ctx.logSlots,
    relayFloor: ctx.relayFloor,
  });
  return { plan, utxos };
}

export async function planConsolidation(api: Api, address: string, pending: PendingTx[]) {
  const [{ utxos }, ctx] = await Promise.all([api.utxos(address), api.status()]);
  const core = await getCore();
  return core.planConsolidation({ utxos, pendingInputSlots: pendingInputs(pending), ...ctx });
}

export async function submitLoop(
  c: Common,
  kind: PendingTx['kind'],
  to: string | null,
  reviewedFee: number,
  build: () => Promise<{ utxos: Utxo[]; plan: SendPlan | ConsolidationPlan; outputs: 1 | 2 }>,
): Promise<{ built: BuiltTx; pending: PendingTx }> {
  if (hasUnresolvedSend(c.pending)) {
    throw new Error('Your last send is still being checked. Wait until it shows as sent or failed.');
  }
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    c.onStage?.(attempt === 0 ? 'preparing' : 'retrying', attempt);
    const { utxos, plan, outputs } = await build();
    if (plan.fee !== reviewedFee) throw new FeeChanged(plan);
    const prep = await c.api.prepare(outputs);

    c.onStage?.('forging', attempt);
    const isSend = 'selectedSlots' in plan;
    const forge = c.forge ?? (await getCore()).buildTransaction;
    const built = await forge({
      secretHex: c.secretHex,
      keyIndex: c.keyIndex,
      utxos,
      selectedSlots: isSend ? plan.selectedSlots : plan.selectedInputSlots,
      to,
      amount: isSend ? plan.amount : plan.outputValue,
      fee: plan.fee,
      epochAnchorHex: prep.epochAnchorHex,
      slotHints: prep.slotHints,
      pendingOutputSlots: pendingOutputs(c.pending),
    });

    const record: PendingTx = {
      txid: built.txid,
      kind,
      state: 'submitting',
      intentHex: built.intentHex,
      to,
      amount: built.amount,
      fee: built.fee,
      inputSlots: built.inputSlots,
      outputSlots: built.outputSlots,
      createdAt: Date.now(),
    };
    // Saved before sending: from here on, this exact transaction is the only one.
    await c.record(record);

    c.onStage?.('submitting', attempt);
    try {
      await c.api.submit(built.intentHex, built.txid);
    } catch (e) {
      if (!(e instanceof ApiError) || e.ambiguous) throw new SubmitUnknown(built.txid);
      // The node clearly refused it, so it was never relayed and cannot confirm.
      await c.discard(built.txid);
      lastError = e;
      if (!e.retryable) throw e;
      await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
      continue;
    }
    const sent: PendingTx = { ...record, state: 'submitted' };
    await c.record(sent);
    return { built, pending: sent };
  }
  throw lastError instanceof Error ? lastError : new Error('The transaction could not be sent. Try again.');
}

export function executeSend(c: Common & { to: string; amount: number; reviewedFee: number; kind?: 'send' | 'gift' }) {
  return submitLoop(c, c.kind ?? 'send', c.to, c.reviewedFee, async () => {
    const { plan, utxos } = await planSend(c.api, c.address, c.pending, c.amount);
    return { plan, utxos, outputs: plan.outputCount as 1 | 2 };
  });
}

export function executeConsolidation(c: Common & { reviewedFee: number }) {
  return submitLoop(c, 'consolidate', null, c.reviewedFee, async () => {
    const [{ utxos }, ctx] = await Promise.all([c.api.utxos(c.address), c.api.status()]);
    const core = await getCore();
    const plan = await core.planConsolidation({ utxos, pendingInputSlots: pendingInputs(c.pending), ...ctx });
    return { plan, utxos, outputs: 1 };
  });
}

/**
 * Move everything at an address (a gift) to `to`. `c.secretHex` is the gift's
 * secret, `c.address` the gift's address, and `c.pending` this wallet's own
 * pending list (so output slots already in use are avoided).
 */
export function executeSweep(c: Common & { to: string; reviewedFee: number; kind: 'claim' }) {
  return submitLoop(c, c.kind, c.to, c.reviewedFee, async () => {
    const { plan, utxos } = await planSweep(c.api, c.address, c.pending);
    return { plan, utxos, outputs: 1 };
  });
}

export async function planSweep(api: Api, address: string, pending: PendingTx[]) {
  const [{ utxos }, ctx] = await Promise.all([api.utxos(address), api.status()]);
  const core = await getCore();
  const plan = await core.planSweep({
    utxos,
    pendingInputSlots: pendingInputs(pending),
    activeSlotCount: ctx.activeSlotCount,
    logSlots: ctx.logSlots,
    relayFloor: ctx.relayFloor,
  });
  return { plan, utxos };
}

/** Codes after which a saved transaction can never confirm and its coins are free again. */
const DEAD = new Set(['inputs_spent', 'stale_anchor', 'fee_too_low', 'rejected', 'bad_request']);

/**
 * Decide what to do with one saved transaction. Pure apart from the API calls,
 * so the logic is easy to test.
 * - confirmed -> drop
 * - pending in mempool -> keep as submitted
 * - unknown -> re-send the identical intent; drop only if the node definitely refuses it
 */
export async function reconcileOne(api: Api, p: PendingTx): Promise<PendingTx | null> {
  const status = await api.tx(p.txid);
  if (status.status === 'confirmed') return null;
  if (status.status === 'pending') return p.state === 'submitted' ? p : { ...p, state: 'submitted' };
  try {
    await api.submit(p.intentHex, p.txid);
    return { ...p, state: 'submitted' };
  } catch (e) {
    if (e instanceof ApiError && !e.ambiguous && DEAD.has(e.code)) return null;
    return p;
  }
}
