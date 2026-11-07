// Coin proofs for the open wallet: run after each refresh once the chain
// check has caught up, kept in memory, read by screens with useCoinProofs().
// The logic lives in lib/coinProofs.ts.
import { useSyncExternalStore } from 'react';

import type { Api } from './api';
import { blockChecked, chainState, syncChain } from './chain';
import { CoinMismatch, dropReplaced, ProofShapeError, proveCoins, toProve, type Records } from './coinProofs';
import { core, CoreError, type Utxo } from './core';

export interface CoinProofStatus {
  /** off: the server can't prove coins (yet). */
  kind: 'off' | 'checking' | 'ready' | 'problem';
  address: string | null;
  records: Records;
  problem: { code: 'mismatch' | 'invalid' | 'other_chain' | 'bad_response'; message: string } | null;
  lastAt: number | null;
}

let status: CoinProofStatus = { kind: 'off', address: null, records: new Map(), problem: null, lastAt: null };
const listeners = new Set<() => void>();
let inFlight: Promise<void> | null = null;

function set(next: Partial<CoinProofStatus>) {
  status = { ...status, ...next };
  for (const l of listeners) l();
}

const TEXT = {
  mismatch:
    'Your wallet server listed coins that the chain’s own records contradict. Do not trust the balance this server shows, and do not send based on it.',
  invalid: 'A coin proof from your wallet server did not check out. Do not trust the balance this server shows until this clears.',
  other_chain: 'Your wallet server proved coins against a different block than the one your phone checked. Do not trust its balance until this clears.',
  bad_response: 'Your wallet server sent proofs for other coins than the ones asked about. Do not trust its balance until this clears.',
};

/** The server stopped offering proofs (or never did). */
export function coinProofsOff(address: string | null) {
  if (status.kind !== 'off' || status.address !== address) set({ kind: 'off', address, records: new Map(), problem: null });
}

/**
 * Prove the listed coins of `address` that aren't proven yet. Call after the
 * chain check's sync for the same refresh. One round at a time.
 */
export function refreshCoinProofs(api: Api, address: string, utxos: Utxo[], serverTip: number): Promise<void> {
  if (inFlight) return inFlight;
  inFlight = run(api, address, utxos, serverTip).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function run(api: Api, address: string, utxos: Utxo[], serverTip: number) {
  const known: Records = status.address === address ? dropReplaced(status.records, blockChecked) : new Map();
  // Nothing new to prove: no request, no "Checking…" flicker.
  const quiet = toProve(utxos, known, Date.now()).length === 0 && status.address === address && status.kind !== 'off';
  set(quiet ? { address } : { kind: 'checking', address, records: known });
  try {
    const records = await proveCoins(
      {
        slotProofs: (indices) => api.slotProofs(indices),
        verify: async (proof, indices) => {
          const s = chainState();
          if (!s) return { status: 'unknown_block', height: 0, phoneTip: 0 };
          return core.verifySlotProof(s, proof, indices);
        },
        syncChain: () => syncChain(api, serverTip),
        utxos: async () => (await api.utxos(address)).utxos,
      },
      address,
      utxos,
      known,
    );
    set({ kind: 'ready', records, problem: null, lastAt: Date.now() });
  } catch (e) {
    const code =
      e instanceof CoinMismatch
        ? 'mismatch'
        : e instanceof ProofShapeError
          ? 'bad_response'
          : e instanceof CoreError && e.code === 'proof_other_chain'
            ? 'other_chain'
            : e instanceof CoreError && e.code === 'proof_invalid'
              ? 'invalid'
              : null;
    if (code) set({ kind: 'problem', problem: { code, message: TEXT[code] }, lastAt: Date.now() });
    // A dropped request or a busy server: not a verdict. Keep what was proven.
    else set({ kind: status.records.size > 0 || status.lastAt ? 'ready' : 'off' });
  }
}

export function useCoinProofs(): CoinProofStatus {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => status,
  );
}
