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
 * confirm. So after a refusal:
 *  - every coin of the refused payment must still be listed as unspent, and
 *  - the next payment must spend at least one of them,
 * which makes the two payments mutually exclusive: at most one can confirm.
 *
 * Every refusal is remembered, whatever reason the server gives, on disk (so a
 * restart doesn't forget it), for at least 12 hours, and longer while the
 * chain height says the refused transaction could still be mined (until the
 * end of the epoch after the one it was built in; an epoch is 144 blocks,
 * about 72 minutes). Heights come from the server, so they can only extend
 * the 12 hours, never shorten them. When the refused coins have vanished, the
 * user can override after checking Activity.
 */
export interface Refusal {
  address: string;
  slots: number[];
  at: number;
  /** Chain height the refused transaction was built at. */
  height?: number;
}
const REFUSED_MIN_MS = 12 * 3600_000;
const EPOCH_BLOCKS = 144;
let refused: Refusal[] = [];
let refusalStore: { load: () => Refusal[]; save: (r: Refusal[]) => void } | null = null;

/** Keep refusals on disk (the wallet sets this at start). */
export function setRefusalStore(store: { load: () => Refusal[]; save: (r: Refusal[]) => void }) {
  refusalStore = store;
  try {
    refused = store.load().filter((r) => r && typeof r.address === 'string' && Array.isArray(r.slots));
  } catch {
    refused = [];
  }
}

function persist() {
  try {
    refusalStore?.save(refused);
  } catch {
    // Memory still holds it for this session.
  }
}

/** Could the refused transaction still be mined? Exported for tests. */
export function refusalLive(r: Refusal, now: number, height?: number): boolean {
  if (now - r.at < REFUSED_MIN_MS) return true;
  if (r.height === undefined || height === undefined) return false;
  // Valid until the end of the epoch after the one it was built in.
  return height < (Math.floor(r.height / EPOCH_BLOCKS) + 2) * EPOCH_BLOCKS;
}

function noteRefused(address: string, slots: number[], height?: number) {
  if (!slots.length) return;
  refused.push({ address, slots, at: Date.now(), ...(height !== undefined ? { height } : {}) });
  persist();
}

export class RefusedButSpent extends Error {
  readonly code = 'refused_but_spent';
  /**
   * True when the refused payment's coins are no longer listed (it may have
   * gone through). False when they are, but this payment can't use them.
   */
  readonly missing: boolean;
  constructor(missing = true) {
    super(
      missing
        ? 'Your last payment was reported as refused, but the money it used is no longer in your balance. It may have gone through. Check Activity before paying again.'
        : 'Your last payment was refused a short while ago. To be safe, the next payment must reuse the same money, and this one can’t. Try a different amount, or try again in a few hours.',
    );
    this.missing = missing;
  }
}

/** Live refusals for `address` (pure read; used to steer coin choice). */
function liveRefusals(address: string, now: number, height?: number): Refusal[] {
  return refused.filter((r) => r.address === address && refusalLive(r, now, height));
}

/**
 * Coins to leave out of the next plan so the core (which takes the largest
 * coins first) starts with a refused coin: every other coin at least as large
 * as the largest refused one. Null when nothing needs steering.
 */
export function steerToRefused(address: string, utxos: Utxo[], now = Date.now(), height?: number): number[] | null {
  const live = liveRefusals(address, now, height);
  if (!live.length) return null;
  const listed = new Map(utxos.map((u) => [u.slotIndex, u.value]));
  const refusedSlots = new Set(live.flatMap((r) => r.slots));
  if ([...refusedSlots].some((s) => !listed.has(s))) return null; // checkRefusals reports it
  const top = Math.max(...[...refusedSlots].map((s) => listed.get(s)!));
  return utxos.filter((u) => !refusedSlots.has(u.slotIndex) && u.value >= top).map((u) => u.slotIndex);
}

/** Throws unless a new spend from `address` is safe given recent refusals. Exported for tests. */
export function checkRefusals(address: string, utxos: Utxo[], inputSlots: number[], now = Date.now(), height?: number) {
  const before = refused.length;
  refused = refused.filter((r) => refusalLive(r, now, height));
  if (refused.length !== before) persist();
  const listed = new Set(utxos.map((u) => u.slotIndex));
  for (const r of refused) {
    if (r.address !== address) continue;
    if (r.slots.some((s) => !listed.has(s))) throw new RefusedButSpent(true);
    if (!r.slots.some((s) => inputSlots.includes(s))) throw new RefusedButSpent(false);
  }
}

/**
 * The user checked Activity and wants to pay anyway (for example the coins
 * really were spent from another wallet with the same secret).
 */
export function overrideRefusals(address: string) {
  refused = refused.filter((r) => r.address !== address);
  persist();
}

function clearRefusals(address: string, inputSlots: number[]) {
  // The new payment shares coins with these, so only one of them can ever confirm.
  const before = refused.length;
  refused = refused.filter((r) => r.address !== address || !r.slots.some((s) => inputSlots.includes(s)));
  if (refused.length !== before) persist();
}

/** For tests only. */
export function resetRefusals() {
  refused = [];
  refusalStore = null;
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
  const request = (skip: number[]) =>
    core.planSend({
      utxos,
      pendingInputSlots: [...pendingInputs(pending), ...skip],
      amount,
      fee: null,
      walletFee,
      activeSlotCount: ctx.activeSlotCount,
      logSlots: ctx.logSlots,
      relayFloor: ctx.relayFloor,
    });
  let plan = await request([]);
  // After a refusal the next payment must reuse one of its coins (see
  // checkRefusals). If the usual choice doesn't, plan again starting from one.
  const skip = steerToRefused(address, utxos, Date.now(), ctx.height);
  if (skip && skip.length && !liveRefusals(address, Date.now(), ctx.height).every((r) => r.slots.some((s) => plan.selectedSlots.includes(s)))) {
    plan = await request(skip).catch(() => plan);
  }
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
      tipHeight: prep.height,
      slotHints: prep.slotHints,
      pendingOutputSlots: pendingOutputs(c.pending),
    });

    // Claims spend the gift's coins, not this wallet's: tracked under the gift's address.
    checkRefusals(c.address, utxos, built.inputSlots, Date.now(), prep.height);

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
      builtAtHeight: prep.height,
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
      noteRefused(c.address, built.inputSlots, prep.height);
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
      if (walletAddress && p.kind !== 'claim') noteRefused(walletAddress, p.inputSlots, p.builtAtHeight);
      return null;
    }
    return p;
  }
}
