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
import { WALLET_FEE_ADDRESS, walletFeeFor } from './walletFee';

/**
 * Refused-payment memory (guards against a dishonest wallet server).
 *
 * When the server says a payment was refused, its coins become free again and
 * the user usually tries once more. A dishonest server could relay the first
 * payment anyway and hide its coins, so the retry picks other coins and both
 * confirm. So for a while after a refusal:
 *  - every coin of the refused payment must still be listed as unspent, and
 *  - the next payment must spend at least one of them,
 * which makes the two payments mutually exclusive: at most one can confirm.
 */
const REFUSED_FOR_MS = 30 * 60_000;
let refused: { address: string; slots: number[]; at: number }[] = [];

function noteRefused(address: string, slots: number[], code: string) {
  // "inputs_spent" means those coins really are gone (spent elsewhere), so the
  // next payment cannot reuse them; remembering it would block sending for no reason.
  if (code === 'inputs_spent' || !slots.length) return;
  refused.push({ address, slots, at: Date.now() });
}

export class RefusedButSpent extends Error {
  readonly code = 'refused_but_spent';
  constructor() {
    super(
      'Your last payment was reported as refused, but the money it used is no longer in your balance. It may have gone through. Check Activity before paying again.',
    );
  }
}

/** Throws unless a new spend from `address` is safe given recent refusals. Exported for tests. */
export function checkRefusals(address: string, utxos: Utxo[], inputSlots: number[], now = Date.now()) {
  refused = refused.filter((r) => now - r.at < REFUSED_FOR_MS);
  const listed = new Set(utxos.map((u) => u.slotIndex));
  for (const r of refused) {
    if (r.address !== address) continue;
    if (r.slots.some((s) => !listed.has(s))) throw new RefusedButSpent();
    if (!r.slots.some((s) => inputSlots.includes(s))) throw new RefusedButSpent();
  }
}

function clearRefusals(address: string, inputSlots: number[]) {
  // The new payment shares coins with these, so only one of them can ever confirm.
  refused = refused.filter((r) => r.address !== address || !r.slots.some((s) => inputSlots.includes(s)));
}

/** For tests only. */
export function resetRefusals() {
  refused = [];
}

/**
 * A server-reported fee this far above normal is refused rather than paid:
 * the fee floor and network load figures come from the server.
 */
export function feeLooksWrong(fee: number, amount: number): boolean {
  return fee > Math.max(250_000, Math.floor(amount * 0.05));
}

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
  const walletFee = walletFeeFor(amount);
  const plan = await core.planSend({
    utxos,
    pendingInputSlots: pendingInputs(pending),
    amount,
    fee: null,
    walletFee,
    activeSlotCount: ctx.activeSlotCount,
    logSlots: ctx.logSlots,
    relayFloor: ctx.relayFloor,
  });
  if (plan.walletFee !== walletFee) throw new Error('The wallet core planned a different wallet fee. Update NOID.');
  if (feeLooksWrong(plan.fee, amount)) throw suspiciousFee();
  return { plan, utxos };
}

function suspiciousFee() {
  return Object.assign(new Error('The network fee looks wrong. Check your wallet server in Settings.'), { code: 'fee_suspicious' });
}

export async function planConsolidation(api: Api, address: string, pending: PendingTx[]) {
  const [{ utxos }, ctx] = await Promise.all([api.utxos(address), api.status()]);
  const core = await getCore();
  const plan = await core.planConsolidation({ utxos, pendingInputSlots: pendingInputs(pending), ...ctx });
  if (feeLooksWrong(plan.fee, 0)) throw suspiciousFee();
  return plan;
}

export async function submitLoop(
  c: Common,
  kind: PendingTx['kind'],
  to: string | null,
  reviewedFee: number,
  build: () => Promise<{ utxos: Utxo[]; plan: SendPlan | ConsolidationPlan; outputs: 1 | 2 | 3 }>,
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
    const walletFee = isSend ? plan.walletFee : 0;
    const forge = c.forge ?? (await getCore()).buildTransaction;
    const built = await forge({
      secretHex: c.secretHex,
      keyIndex: c.keyIndex,
      utxos,
      selectedSlots: isSend ? plan.selectedSlots : plan.selectedInputSlots,
      to,
      amount: isSend ? plan.amount : plan.outputValue,
      ...(walletFee > 0 ? { walletFee, walletFeeTo: WALLET_FEE_ADDRESS } : {}),
      fee: plan.fee,
      epochAnchorHex: prep.epochAnchorHex,
      slotHints: prep.slotHints,
      pendingOutputSlots: pendingOutputs(c.pending),
    });

    // Claims spend the gift's coins, not this wallet's: tracked under the gift's address.
    checkRefusals(c.address, utxos, built.inputSlots);

    const record: PendingTx = {
      txid: built.txid,
      kind,
      state: 'submitting',
      intentHex: built.intentHex,
      to,
      amount: built.amount,
      fee: built.fee,
      ...(built.walletFee ? { walletFee: built.walletFee } : {}),
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
      noteRefused(c.address, built.inputSlots, e.code);
      lastError = e;
      if (!e.retryable) throw e;
      await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
      continue;
    }
    clearRefusals(c.address, built.inputSlots);
    const sent: PendingTx = { ...record, state: 'submitted' };
    await c.record(sent);
    return { built, pending: sent };
  }
  throw lastError instanceof Error ? lastError : new Error('The transaction could not be sent. Try again.');
}

export function executeSend(c: Common & { to: string; amount: number; reviewedFee: number; kind?: 'send' | 'gift' }) {
  return submitLoop(c, c.kind ?? 'send', c.to, c.reviewedFee, async () => {
    const { plan, utxos } = await planSend(c.api, c.address, c.pending, c.amount);
    return { plan, utxos, outputs: plan.outputCount as 1 | 2 | 3 };
  });
}

export function executeConsolidation(c: Common & { reviewedFee: number }) {
  return submitLoop(c, 'consolidate', null, c.reviewedFee, async () => {
    const [{ utxos }, ctx] = await Promise.all([c.api.utxos(c.address), c.api.status()]);
    const core = await getCore();
    const plan = await core.planConsolidation({ utxos, pendingInputSlots: pendingInputs(c.pending), ...ctx });
    if (feeLooksWrong(plan.fee, 0)) throw suspiciousFee();
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
  // A server-reported fee floor far above the network minimum would let fees
  // eat the gift: refuse instead (see gifts.sweepFeeTooHigh).
  const minimum = 5_000 + 100 * plan.inputCount + 700;
  if (plan.fee > Math.max(3 * minimum, 20_000)) {
    throw Object.assign(new Error('The network fee looks wrong. Check your wallet server in Settings.'), { code: 'fee_suspicious' });
  }
  return { plan, utxos };
}

/** Codes after which a saved transaction can never confirm and its coins are free again. */
const DEAD = new Set(['inputs_spent', 'stale_anchor', 'fee_too_low', 'rejected', 'bad_request']);

/**
 * Decide what to do with one saved transaction. Pure apart from the API calls,
 * so the logic is easy to test.
 * - confirmed -> marked confirmedAt (the wallet drops it once history lists it)
 * - pending in mempool -> keep as submitted
 * - unknown -> re-send the identical intent; drop only if the node definitely refuses it
 */
export async function reconcileOne(api: Api, p: PendingTx, walletAddress?: string): Promise<PendingTx | null> {
  // Already confirmed: only waiting for the history to list it (see confirmedAt).
  if (p.confirmedAt) return p;
  const status = await api.tx(p.txid);
  if (status.status === 'confirmed') return { ...p, state: 'submitted', confirmedAt: Date.now() };
  if (status.status === 'pending') return p.state === 'submitted' ? p : { ...p, state: 'submitted' };
  try {
    await api.submit(p.intentHex, p.txid);
    return { ...p, state: 'submitted' };
  } catch (e) {
    if (e instanceof ApiError && !e.ambiguous && DEAD.has(e.code)) {
      if (walletAddress && p.kind !== 'claim') noteRefused(walletAddress, p.inputSlots, e.code);
      return null;
    }
    return p;
  }
}
