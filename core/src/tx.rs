//! Coin selection, send / consolidation planning, and building + proving the
//! PagedSpend intent. Ports of the official wallet:
//! - select_utxos: noid_node/src/wallet/state.rs
//! - plan_send / plan_consolidation: noid_node/src/wallet/mod.rs
//! - build_and_prove_tx: noid_node/src/wallet/builder.rs
//!
//! The phone receives the owner's live UTXOs from the node
//! (paranoid_getSlotsByOwner) and tracks its own pending slots.

use std::collections::HashSet;

use noid_gkr::wallet_authorization::prove_paged_spend_authorization_for_version;
use noid_gkr::OwnerAuthWitness;
use noid_tx::OwnerAuthorizationVersion;

/// Parano1d v2.1 activation (noid_chain consensus params,
/// MAINNET_V2_1_ACTIVATION_HEIGHT in v2.1.0). From this block on, wallet
/// authorization proofs must use the V4 construction; before it, V3.
pub const V2_1_ACTIVATION_HEIGHT: u64 = 279_370;

/// Proof construction for a transaction that will be mined in the block after
/// `tip_height` (the node checks against tip + 1, like the official wallet's
/// `owner_authorization_version(candidate_height)`).
pub fn authorization_version(tip_height: u64) -> OwnerAuthorizationVersion {
    if tip_height.saturating_add(1) >= V2_1_ACTIVATION_HEIGHT {
        OwnerAuthorizationVersion::V4
    } else {
        OwnerAuthorizationVersion::V3
    }
}
use noid_poseidon2b::primitives::{derive_address, Address};
use noid_tx::{
    output_bitmap_bit, PagedSpendIntent, TxBody, TxInput, TxOutput, TxPage, PAGED_SPEND_END_BIT,
    PAGED_SPEND_START_BIT, TX_INPUTS, TX_OUTPUTS,
};
use serde::{Deserialize, Serialize};

use crate::fees::{fee_breakdown, FeeBreakdown, FEE_PER_INPUT};
use crate::keys::MasterSecret;
use crate::Error;

/// V2 admits at most 504 live inputs per block budget (Small class: 63 pages).
/// The format allows 1,020 but the mempool rejects anything above 504.
pub const MAX_SEND_INPUTS: usize = 504;
/// Official wallet consolidation limit (noid_rpc WALLET_CONSOLIDATION_INPUT_LIMIT).
pub const MAX_CONSOLIDATION_INPUTS: usize = 64;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Utxo {
    pub slot_index: u32,
    pub value: u64,
    /// Full u64. Mined coins use `1 << 63 | height`, which JavaScript numbers
    /// cannot hold, so this travels as a decimal string (numbers also accepted).
    #[serde(with = "u64_string")]
    pub creation_id: u64,
}

mod u64_string {
    use serde::{de, Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(v: &u64, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&v.to_string())
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<u64, D::Error> {
        #[derive(Deserialize)]
        #[serde(untagged)]
        enum Raw {
            Str(String),
            Num(u64),
        }
        match Raw::deserialize(d)? {
            Raw::Num(n) => Ok(n),
            Raw::Str(s) => s
                .parse::<u64>()
                .map_err(|_| de::Error::custom("creationId must be a decimal u64 string")),
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub struct FeeContext {
    pub active_slot_count: u64,
    pub log_slots: u32,
    pub relay_floor: u64,
}

impl FeeContext {
    fn minimum(&self, inputs: usize, outputs: usize) -> (u64, FeeBreakdown) {
        let b = fee_breakdown(inputs as u64, outputs as u64, self.active_slot_count, self.log_slots);
        (b.required_total.max(self.relay_floor), b)
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SendPlan {
    pub amount: u64,
    /// NOID wallet fee, paid as its own output to the wallet's fee address (0 = none).
    pub wallet_fee: u64,
    pub fee: u64,
    pub total_spend: u64,
    pub input_count: usize,
    pub output_count: usize,
    pub change: u64,
    pub spendable: u64,
    pub selected_slots: Vec<u32>,
    pub fee_breakdown: FeeBreakdown,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsolidationPlan {
    pub input_value: u64,
    pub fee: u64,
    pub output_value: u64,
    pub balance_before: u64,
    pub balance_after: u64,
    pub input_count: usize,
    pub untouched_count: usize,
    pub freed_slots: usize,
    pub selected_input_slots: Vec<u32>,
    pub fee_breakdown: FeeBreakdown,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BuiltTx {
    pub txid: String,
    pub intent_hex: String,
    pub fee: u64,
    pub amount: u64,
    pub wallet_fee: u64,
    pub change: u64,
    pub input_count: usize,
    pub output_count: usize,
    pub input_slots: Vec<u32>,
    pub output_slots: Vec<u32>,
    pub prove_ms: u64,
}

/// A v2.1 token, NFT or market record (not plain NOID): bit 62 set, bit 63 clear.
fn is_native_record(creation_id: u64) -> bool {
    creation_id & (3u64 << 62) == 1u64 << 62
}

fn spendable_utxos<'a>(utxos: &'a [Utxo], pending_inputs: &HashSet<u32>) -> Vec<&'a Utxo> {
    let mut seen = HashSet::new();
    utxos
        .iter()
        // Never plan with a token/NFT record a server passed off as a coin.
        .filter(|u| !is_native_record(u.creation_id))
        .filter(|u| !pending_inputs.contains(&u.slot_index))
        .filter(|u| seen.insert(u.slot_index))
        .collect()
}

fn sum(mut values: impl Iterator<Item = u64>) -> Result<u64, Error> {
    values.try_fold(0u64, u64::checked_add).ok_or_else(|| Error::msg("Wallet balance arithmetic overflow."))
}

/// Exact single input first, then largest-first prefix (official select_utxos).
pub fn select_utxos<'a>(available: &[&'a Utxo], target: u64, fee: u64) -> Option<(Vec<&'a Utxo>, u64)> {
    let needed = target.checked_add(fee)?;
    if let Some(exact) = available.iter().copied().filter(|u| u.value == needed).min_by_key(|u| u.slot_index) {
        return Some((vec![exact], 0));
    }
    let mut sorted: Vec<&Utxo> = available.to_vec();
    sorted.sort_unstable_by_key(|u| (std::cmp::Reverse(u.value), u.slot_index));
    let mut selected = Vec::new();
    let mut total = 0u64;
    for utxo in sorted.into_iter().take(MAX_SEND_INPUTS) {
        selected.push(utxo);
        total = total.checked_add(utxo.value)?;
        if total >= needed {
            return Some((selected, total - needed));
        }
    }
    None
}

fn insufficient(needed: u64, available: u64) -> Error {
    Error::coded(
        "insufficient_funds",
        format!(
            "Not enough NOID. This send needs {} NOID including the network fee, and {} NOID is available.",
            crate::fmt_noid(needed),
            crate::fmt_noid(available)
        ),
    )
}

/// Plan a payment. `explicit_fee = None` is the official wallet's Auto fee.
/// `wallet_fee > 0` adds a second output (the NOID wallet fee) next to the
/// recipient's; coins are chosen to cover both, and the network fee counts it.
pub fn plan_send(
    utxos: &[Utxo],
    pending_inputs: &HashSet<u32>,
    amount: u64,
    explicit_fee: Option<u64>,
    ctx: FeeContext,
    wallet_fee: u64,
) -> Result<SendPlan, Error> {
    if amount == 0 {
        return Err(Error::msg("Enter an amount greater than zero."));
    }
    // Everything leaving the wallet except the network fee, and the outputs
    // that always exist (recipient, plus the wallet fee when there is one).
    let pay = amount.checked_add(wallet_fee).ok_or_else(|| Error::msg("Amount is too large."))?;
    let fixed_outputs = 1 + usize::from(wallet_fee > 0);
    let mut available = spendable_utxos(utxos, pending_inputs);
    available.sort_by_key(|u| (std::cmp::Reverse(u.value), u.slot_index));
    let spendable = sum(available.iter().map(|u| u.value))?;

    // The cheapest shape this balance allows: below `fixed_outputs` inputs each
    // extra input saves a state-growth slot, so the fewest-fee shape uses
    // min(coins, outputs) inputs (1 -> 2 pays growth, 2 -> 2 doesn't).
    let (cheapest, _) = ctx.minimum(available.len().clamp(1, fixed_outputs), fixed_outputs);
    if let Some(fee) = explicit_fee {
        if fee < cheapest {
            return Err(Error::msg(format!(
                "That fee is too low. The minimum right now is {} NOID.",
                crate::fmt_noid(cheapest)
            )));
        }
    }
    let minimum_fee = explicit_fee.unwrap_or(cheapest);
    let minimum_total = pay.checked_add(minimum_fee).ok_or_else(|| Error::msg("Amount is too large."))?;
    if spendable < minimum_total {
        return Err(insufficient(minimum_total, spendable));
    }

    let mut planned: Option<u64> = explicit_fee.filter(|_| available.iter().any(|u| u.value == minimum_total));
    let mut selected_value = 0u64;
    for input_count in 1..=MAX_SEND_INPUTS {
        if planned.is_some() {
            break;
        }
        let Some(utxo) = available.get(input_count - 1) else { break };
        selected_value = selected_value.checked_add(utxo.value).ok_or_else(|| Error::msg("Balance overflow."))?;

        if let Some(fee) = explicit_fee {
            if selected_value < minimum_total {
                continue;
            }
            let change = selected_value - minimum_total;
            let outputs = fixed_outputs + usize::from(change > 0);
            let (minimum, _) = ctx.minimum(input_count, outputs);
            if fee < minimum {
                return Err(Error::msg(format!(
                    "That fee is too low for this transaction. The minimum is {} NOID.",
                    crate::fmt_noid(minimum)
                )));
            }
            planned = Some(fee);
            break;
        }

        let (one_output_fee, _) = ctx.minimum(input_count, fixed_outputs);
        if selected_value > pay {
            let (two_output_fee, _) = ctx.minimum(input_count, fixed_outputs + 1);
            let need = pay.checked_add(two_output_fee).ok_or_else(|| Error::msg("Amount is too large."))?;
            if selected_value > need {
                planned = Some(two_output_fee);
                break;
            }
        }
        if selected_value >= pay {
            let no_change_fee = selected_value - pay;
            if no_change_fee >= one_output_fee {
                planned = Some(no_change_fee);
                break;
            }
        }
    }

    let Some(fee) = planned else {
        if available.len() > MAX_SEND_INPUTS {
            return Err(Error::coded(
                "input_limit",
                "This payment needs more than 504 coins. Merge small coins first (Consolidate), then send again.",
            ));
        }
        return Err(insufficient(minimum_total, spendable));
    };

    let Some((selected, change)) = select_utxos(&available, pay, fee) else {
        if available.len() > MAX_SEND_INPUTS {
            return Err(Error::coded(
                "input_limit",
                "This payment needs more than 504 coins. Merge small coins first (Consolidate), then send again.",
            ));
        }
        return Err(insufficient(pay.saturating_add(fee), spendable));
    };
    let input_count = selected.len();
    let output_count = fixed_outputs + usize::from(change > 0);
    let (minimum, breakdown) = ctx.minimum(input_count, output_count);
    if fee < minimum {
        return Err(Error::msg(format!(
            "That fee is too low for this transaction. The minimum is {} NOID.",
            crate::fmt_noid(minimum)
        )));
    }
    Ok(SendPlan {
        amount,
        wallet_fee,
        fee,
        total_spend: pay + fee,
        input_count,
        output_count,
        change,
        spendable,
        selected_slots: selected.iter().map(|u| u.slot_index).collect(),
        fee_breakdown: breakdown,
    })
}

/// Merge the smallest coins into one (official plan_consolidation).
/// Like the official wallet, refuses while any transaction is pending.
pub fn plan_consolidation(
    utxos: &[Utxo],
    pending_inputs: &HashSet<u32>,
    max_inputs: usize,
    ctx: FeeContext,
) -> Result<ConsolidationPlan, Error> {
    if !pending_inputs.is_empty() {
        return Err(Error::coded("pending", "Wait until your pending transaction confirms, then merge coins."));
    }
    if !(2..=MAX_CONSOLIDATION_INPUTS).contains(&max_inputs) {
        return Err(Error::msg(format!("Merge between 2 and {MAX_CONSOLIDATION_INPUTS} coins at a time.")));
    }
    // Dust worth no more than the fee it adds is left alone, so someone
    // sending many tiny coins can't make merging impossible.
    let mut available: Vec<&Utxo> = spendable_utxos(utxos, &HashSet::new())
        .into_iter()
        .filter(|u| u.value > FEE_PER_INPUT)
        .collect();
    available.sort_by_key(|u| (u.value, u.slot_index));
    if available.len() < 2 {
        return Err(Error::msg("You need at least two coins to consolidate."));
    }
    let balance_before = sum(available.iter().map(|u| u.value))?;
    let input_count = available.len().min(max_inputs);
    let selected = &available[..input_count];
    let input_value = sum(selected.iter().map(|u| u.value))?;
    let (fee, breakdown) = ctx.minimum(input_count, 1);
    let output_value = input_value.checked_sub(fee).filter(|v| *v > 0).ok_or_else(|| {
        Error::coded(
            "insufficient_funds",
            "These coins are worth less than the network fee to merge them.",
        )
    })?;
    Ok(ConsolidationPlan {
        input_value,
        fee,
        output_value,
        balance_before,
        balance_after: balance_before - fee,
        input_count,
        untouched_count: available.len() - input_count,
        freed_slots: input_count - 1,
        selected_input_slots: selected.iter().map(|u| u.slot_index).collect(),
        fee_breakdown: breakdown,
    })
}

/// Move every coin at an address to one recipient, fee taken from the total
/// (gift claims and gift take-backs). One output, so no change and no state
/// growth: spending n >= 1 coins into 1 never adds a slot.
pub fn plan_sweep(utxos: &[Utxo], pending_inputs: &HashSet<u32>, ctx: FeeContext) -> Result<SendPlan, Error> {
    // Anyone can send coins to a public gift address. Coins worth no more than
    // the fee they add are skipped, and at most the largest MAX_SEND_INPUTS are
    // taken, so dust cannot freeze or drain a gift.
    let mut available: Vec<&Utxo> = spendable_utxos(utxos, pending_inputs)
        .into_iter()
        .filter(|u| u.value > FEE_PER_INPUT)
        .collect();
    available.sort_by(|a, b| b.value.cmp(&a.value).then(a.slot_index.cmp(&b.slot_index)));
    available.truncate(MAX_SEND_INPUTS);
    if available.is_empty() {
        return Err(Error::coded("empty", "There is nothing to claim here. It may have been claimed already."));
    }
    let spendable = sum(available.iter().map(|u| u.value))?;
    let (fee, breakdown) = ctx.minimum(available.len(), 1);
    let amount = spendable.checked_sub(fee).filter(|v| *v > 0).ok_or_else(|| {
        Error::coded("insufficient_funds", "This holds less than the network fee needed to move it.")
    })?;
    Ok(SendPlan {
        amount,
        wallet_fee: 0,
        fee,
        total_spend: spendable,
        input_count: available.len(),
        output_count: 1,
        change: 0,
        spendable,
        selected_slots: available.iter().map(|u| u.slot_index).collect(),
        fee_breakdown: breakdown,
    })
}

pub struct BuildRequest<'a> {
    pub secret: &'a MasterSecret,
    pub key_index: u32,
    pub inputs: Vec<Utxo>,
    pub to: Address,
    pub amount: u64,
    /// The NOID wallet fee output (fee address, amount), if any.
    pub wallet_fee: Option<(Address, u64)>,
    pub fee: u64,
    pub epoch_anchor: [u8; 32],
    pub output_slot_hints: Vec<u32>,
    /// Consolidation: inputs must equal output + fee exactly (no change output),
    /// mirroring the official ConsolidationValueMismatch check.
    pub exact: bool,
    /// Current chain tip; picks the proof construction (see authorization_version).
    pub tip_height: u64,
}

/// Build the pages, forge the authorization proof and encode the intent
/// (official build_and_prove_tx). The secret never leaves this function.
/// The NOID wallet fee address and rule. Must match app/src/lib/walletFee.ts:
/// the core refuses to build a wallet-fee output that differs from them.
pub const WALLET_FEE_ADDRESS: &str = "o155fsn6m5au9ardteuw0qc77agzzp6a99c8j5k60qumdwus5ajwesf9magf";
pub const WALLET_FEE_BPS: u64 = 25;
pub const WALLET_FEE_MIN: u64 = 5_000;
pub const WALLET_FEE_MAX: u64 = 500_000;

/// Wallet fee in μNOID for sending `amount` μNOID (0.25%, at least 0.005, at most 0.5 NOID).
pub fn wallet_fee_for(amount: u64) -> u64 {
    if amount == 0 {
        return 0;
    }
    let pct = (u128::from(amount) * u128::from(WALLET_FEE_BPS) / 10_000) as u64;
    pct.clamp(WALLET_FEE_MIN, WALLET_FEE_MAX)
}

/// Room above the network's worst case. Same as FEE_MARGIN in app/src/lib/send.ts.
pub const FEE_MARGIN: u64 = 20_000;
/// The node's relay floor (90% of recent median fees once its mempool is 80%
/// full) is a flat amount, not sized to the transaction: allow up to this much
/// of it. Same as RELAY_FLOOR_CEILING in app/src/lib/send.ts.
pub const RELAY_FLOOR_CEILING: u64 = 100_000;

/// The most network fee the core will ever put in a transaction: the larger of
/// the consensus minimum at full network load and a busy relay floor, plus
/// FEE_MARGIN. `outputs` includes a change output a send may have folded into
/// the fee. The load figures and floor come from the wallet server, so this
/// caps what a dishonest server could add (at most about 0.12 NOID).
pub fn max_network_fee(inputs: u64, outputs: u64) -> u64 {
    let worst = crate::fees::MIN_FEE_BASE
        + crate::fees::FEE_PER_INPUT * inputs
        + crate::fees::FEE_PER_OUTPUT * outputs
        + crate::fees::STATE_GROWTH_FEE_BASE * 8 * outputs.saturating_sub(inputs);
    worst.max(RELAY_FLOOR_CEILING) + FEE_MARGIN
}

pub fn build_and_prove(req: BuildRequest<'_>) -> Result<BuiltTx, Error> {
    if req.inputs.is_empty() || req.inputs.len() > MAX_SEND_INPUTS {
        return Err(Error::msg("Invalid number of inputs."));
    }
    if req.exact && !(2..=MAX_CONSOLIDATION_INPUTS).contains(&req.inputs.len()) {
        return Err(Error::msg(format!("Merge between 2 and {MAX_CONSOLIDATION_INPUTS} coins at a time.")));
    }
    if req.amount == 0 {
        return Err(Error::msg("Enter an amount greater than zero."));
    }
    if req.inputs.iter().any(|u| is_native_record(u.creation_id)) {
        return Err(Error::msg("A token or NFT record can't be spent as NOID."));
    }
    if let Some((to, v)) = req.wallet_fee.filter(|(_, v)| *v > 0) {
        if to.to_bech32() != WALLET_FEE_ADDRESS || v != wallet_fee_for(req.amount) {
            return Err(Error::msg("The wallet fee differs from NOID's fee rule, so nothing was built."));
        }
    }
    let spend_secret = req.secret.derive_spend_secret(req.key_index);
    let owner = derive_address(&spend_secret);
    let total = sum(req.inputs.iter().map(|u| u.value))?;
    let wallet_fee = req.wallet_fee.filter(|(_, v)| *v > 0);
    if req.exact && wallet_fee.is_some() {
        return Err(Error::msg("A merge never pays a wallet fee."));
    }
    let fee_amount = wallet_fee.map_or(0, |(_, v)| v);
    let pay = req.amount.checked_add(fee_amount).ok_or_else(|| Error::msg("Amount is too large."))?;
    let change = total
        .checked_sub(pay)
        .and_then(|r| r.checked_sub(req.fee))
        .ok_or_else(|| insufficient(pay.saturating_add(req.fee), total))?;
    if req.exact && change != 0 {
        return Err(Error::coded("stale", "Your coins changed. Review the merge again."));
    }
    let mut seen = HashSet::new();
    if !req.inputs.iter().all(|u| seen.insert(u.slot_index)) {
        return Err(Error::msg("The same coin was selected twice."));
    }

    // Outputs in order: recipient, wallet fee, change.
    let mut wanted: Vec<(u64, Address)> = vec![(req.amount, req.to)];
    if let Some((fee_to, v)) = wallet_fee {
        wanted.push((v, fee_to));
    }
    if change > 0 {
        wanted.push((change, owner));
    }
    let (n_in, n_out) = (req.inputs.len() as u64, wanted.len() as u64);
    let lowest = crate::fees::fee_breakdown(n_in, n_out, 0, 32).required_total;
    // A send without change may have folded a too-small change into the fee:
    // allow for the shape with that extra output. A merge is exact.
    let cap_outputs = if req.exact || change > 0 { n_out } else { n_out + 1 };
    if req.fee < lowest || req.fee > max_network_fee(n_in, cap_outputs) {
        return Err(Error::coded(
            "fee_suspicious",
            "The network fee is outside what the network can require, so nothing was built.",
        ));
    }
    let needed_slots = wanted.len();
    let mut hints: Vec<u32> = Vec::new();
    for slot in req.output_slot_hints {
        if !hints.contains(&slot) {
            hints.push(slot);
        }
    }
    if hints.len() < needed_slots {
        return Err(Error::coded("no_slots", "The network did not return enough free output slots. Try again."));
    }

    let all_outputs: Vec<TxOutput> = wanted
        .iter()
        .zip(&hints)
        .map(|(&(amount, owner), &slot_index)| TxOutput { slot_index, amount, owner })
        .collect();

    // Two outputs fit on a page: a third (recipient, wallet fee, change) goes on
    // the next page. Consensus wants the fewest pages for inputs and outputs.
    let page_count = req.inputs.len().div_ceil(TX_INPUTS).max(all_outputs.len().div_ceil(TX_OUTPUTS)).max(1);
    let mut pages = Vec::with_capacity(page_count);
    for page_index in 0..page_count {
        let mut page_inputs = [TxInput::dummy(); TX_INPUTS];
        let mut page_outputs = [TxOutput::dummy(); TX_OUTPUTS];
        let mut bitmap = 0u16;
        for (slot, input) in page_inputs.iter_mut().enumerate() {
            if let Some(u) = req.inputs.get(page_index * TX_INPUTS + slot) {
                *input = TxInput { slot_index: u.slot_index, amount: u.value, creation_id: u.creation_id };
                bitmap |= 1u16 << slot;
            }
        }
        for (slot, output) in page_outputs.iter_mut().enumerate() {
            if let Some(o) = all_outputs.get(page_index * TX_OUTPUTS + slot) {
                *output = *o;
                bitmap |= output_bitmap_bit(slot);
            }
        }
        if page_index == 0 {
            bitmap |= PAGED_SPEND_START_BIT;
        }
        if page_index + 1 == page_count {
            bitmap |= PAGED_SPEND_END_BIT;
        }
        pages.push(
            TxPage::new(TxBody {
                epoch_anchor: req.epoch_anchor,
                fee: if page_index == 0 { req.fee } else { 0 },
                input_owner: owner,
                inputs: page_inputs,
                outputs: page_outputs,
                validity_bitmap: bitmap,
                is_coinbase: false,
            })
            .map_err(|e| Error::msg(format!("Transaction page rejected: {e}")))?,
        );
    }

    let started = std::time::Instant::now();
    let bundle = prove_paged_spend_authorization_for_version(
        &pages,
        OwnerAuthWitness::new(spend_secret),
        authorization_version(req.tip_height),
    )
        .map_err(|e| Error::msg(format!("Could not forge the proof: {e}")))?;
    let prove_ms = started.elapsed().as_millis() as u64;
    let auth = bundle.to_bytes().map_err(|e| Error::msg(format!("Could not encode the proof: {e}")))?;
    let intent = PagedSpendIntent::new(pages, auth).map_err(|e| Error::msg(format!("Invalid transaction: {e}")))?;
    let facts = noid_tx::validate_paged_spend(&intent.pages)
        .map_err(|e| Error::msg(format!("Invalid transaction: {e}")))?;
    let output_slots = intent.pages.iter().flat_map(|p| p.body.live_outputs()).map(|(_, o)| o.slot_index).collect();
    let bytes = intent.to_bytes().map_err(|e| Error::msg(format!("Could not encode the transaction: {e}")))?;
    Ok(BuiltTx {
        txid: hex::encode(intent.logical_txid().0),
        intent_hex: hex::encode(bytes),
        fee: facts.fee,
        amount: req.amount,
        wallet_fee: fee_amount,
        change,
        input_count: usize::from(facts.live_inputs),
        output_count: usize::from(facts.live_outputs),
        input_slots: req.inputs.iter().map(|u| u.slot_index).collect(),
        output_slots,
        prove_ms,
    })
}

/// Resolve a plan's selected slots back to full UTXOs, in plan order.
pub fn take_selected(utxos: &[Utxo], slots: &[u32]) -> Result<Vec<Utxo>, Error> {
    let mut seen = HashSet::new();
    if !slots.iter().all(|s| seen.insert(*s)) {
        return Err(Error::msg("The same coin was selected twice."));
    }
    slots
        .iter()
        .map(|s| {
            utxos
                .iter()
                .find(|u| u.slot_index == *s)
                .copied()
                .ok_or_else(|| Error::coded("stale", "Your balance changed. Review the send again."))
        })
        .collect()
}

#[cfg(test)]
mod tests {

    #[test]
    fn sweep_ignores_dust_and_caps_inputs() {
        let ctx = FeeContext { active_slot_count: 0, log_slots: 24, relay_floor: 5_000 };
        let mut utxos: Vec<Utxo> = (0..600).map(|i| Utxo { slot_index: i, value: 50, creation_id: i as u64 }).collect();
        utxos.push(Utxo { slot_index: 10_000, value: 2_000_000, creation_id: 9 });
        let plan = plan_sweep(&utxos, &HashSet::new(), ctx).unwrap();
        assert_eq!(plan.selected_slots, vec![10_000], "dust coins worth less than their fee are left behind");
        assert_eq!(plan.amount, 2_000_000 - 5_800);

        let many: Vec<Utxo> = (0..600).map(|i| Utxo { slot_index: i, value: 10_000 + i as u64, creation_id: i as u64 }).collect();
        let p2 = plan_sweep(&many, &HashSet::new(), ctx).unwrap();
        assert_eq!(p2.input_count, MAX_SEND_INPUTS);
        assert!(p2.selected_slots.contains(&599) && !p2.selected_slots.contains(&0), "largest coins first");
    }

    #[test]
    fn sweep_spends_everything_into_one_output() {
        let ctx = FeeContext { active_slot_count: 0, log_slots: 24, relay_floor: 5_000 };
        let utxos = vec![
            Utxo { slot_index: 7, value: 1_005_800, creation_id: 1 },
        ];
        let plan = plan_sweep(&utxos, &HashSet::new(), ctx).unwrap();
        // 5000 base + 100 per input + 700 for one output; no state growth.
        assert_eq!((plan.fee, plan.amount, plan.output_count, plan.change), (5_800, 1_000_000, 1, 0));
        assert_eq!(plan.fee_breakdown.state_growth, 0);

        let two = vec![
            Utxo { slot_index: 1, value: 3_000, creation_id: 1 },
            Utxo { slot_index: 2, value: 4_000, creation_id: 2 },
        ];
        let p2 = plan_sweep(&two, &HashSet::new(), ctx).unwrap();
        assert_eq!((p2.fee, p2.amount, p2.selected_slots.len()), (5_900, 1_100, 2));

        assert!(plan_sweep(&[], &HashSet::new(), ctx).is_err());
        let dust = vec![Utxo { slot_index: 3, value: 5_000, creation_id: 3 }];
        assert!(plan_sweep(&dust, &HashSet::new(), ctx).is_err());
        let locked: HashSet<u32> = [7].into_iter().collect();
        assert!(plan_sweep(&utxos, &locked, ctx).is_err());
    }
    use super::*;
    use noid_gkr::wallet_authorization::verify_paged_spend_authorization_for_version;
    use noid_gkr::WalletAuthorizationBundle;

    fn ctx() -> FeeContext {
        FeeContext { active_slot_count: 0, log_slots: 24, relay_floor: 5_000 }
    }
    fn u(slot: u32, value: u64) -> Utxo {
        Utxo { slot_index: slot, value, creation_id: slot as u64 + 7 }
    }

    #[test]
    fn auto_fee_one_input_with_change() {
        let utxos = [u(10, 5_000_000), u(11, 1_000_000)];
        let p = plan_send(&utxos, &HashSet::new(), 2_000_000, None, ctx(), 0).unwrap();
        assert_eq!((p.input_count, p.output_count, p.fee), (1, 2, 9_000));
        assert_eq!(p.change, 5_000_000 - 2_000_000 - 9_000);
        assert_eq!(p.selected_slots, vec![10]);
    }

    #[test]
    fn auto_fee_send_all_has_no_change() {
        let utxos = [u(1, 1_000_000)];
        // 1 -> 1 needs 5000 + 100 + 700 = 5,800.
        let p = plan_send(&utxos, &HashSet::new(), 1_000_000 - 5_800, None, ctx(), 0).unwrap();
        assert_eq!((p.output_count, p.fee, p.change), (1, 5_800, 0));
    }

    #[test]
    fn pending_inputs_are_excluded() {
        let utxos = [u(1, 1_000_000), u(2, 1_000_000)];
        let pending: HashSet<u32> = [1].into_iter().collect();
        assert!(plan_send(&utxos, &pending, 1_500_000, None, ctx(), 0).is_err());
        let p = plan_send(&utxos, &pending, 500_000, None, ctx(), 0).unwrap();
        assert_eq!(p.selected_slots, vec![2]);
    }

    #[test]
    fn consolidation_takes_smallest_first() {
        let utxos = [u(1, 900), u(2, 50_000), u(3, 20_000), u(4, 9_000_000)];
        let p = plan_consolidation(&utxos, &HashSet::new(), 3, ctx()).unwrap();
        assert_eq!(p.selected_input_slots, vec![1, 3, 2]);
        assert_eq!(p.fee, 5_000 + 300 + 700);
        assert_eq!(p.output_value, 900 + 20_000 + 50_000 - 6_000);
    }

    #[test]
    fn consolidation_skips_dust() {
        // 64 coins of 1 μNOID would otherwise be picked first and never cover the fee.
        let mut utxos: Vec<Utxo> = (0..64).map(|i| u(i + 1, 1)).collect();
        utxos.push(u(500, 40_000));
        utxos.push(u(501, 60_000));
        let p = plan_consolidation(&utxos, &HashSet::new(), 64, ctx()).unwrap();
        assert_eq!(p.selected_input_slots, vec![500, 501]);
        assert_eq!(p.output_value, 100_000 - (5_000 + 200 + 700));
    }

    #[test]
    fn coinbase_creation_id_survives_json_and_reaches_the_input() {
        // Mined coin: creation_id = 1 << 63 | height (noid_chain params.rs).
        let id: u64 = (1u64 << 63) | 141_337;
        let json = format!(r#"[{{"slotIndex":7,"value":14400000,"creationId":"{id}"}}]"#);
        let utxos: Vec<Utxo> = serde_json::from_str(&json).unwrap();
        assert_eq!(utxos[0].creation_id, id);
        assert_eq!(serde_json::to_value(utxos[0]).unwrap()["creationId"], id.to_string());
        // Plain numbers (normal coins) are still accepted.
        let small: Vec<Utxo> = serde_json::from_str(r#"[{"slotIndex":1,"value":5,"creationId":42}]"#).unwrap();
        assert_eq!(small[0].creation_id, 42);

        let secret = MasterSecret::from_hex(&"33".repeat(32)).unwrap();
        let built = build_and_prove(BuildRequest {
            secret: &secret,
            key_index: 0,
            inputs: utxos.clone(),
            to: MasterSecret::from_hex(&"44".repeat(32)).unwrap().derive_address(0),
            amount: 1_000_000,
            wallet_fee: None,
            fee: 9_000,
            epoch_anchor: [1; 32],
            output_slot_hints: vec![10, 11],
            exact: false,
            tip_height: 1_000,
        })
        .unwrap();
        let intent = PagedSpendIntent::from_bytes(&hex::decode(&built.intent_hex).unwrap()).unwrap();
        assert_eq!(intent.pages[0].body.inputs[0].creation_id, id);
    }

    #[test]
    fn consolidation_refuses_while_pending_and_requires_exact_value() {
        let utxos = [u(1, 900_000), u(2, 50_000)];
        let pending: HashSet<u32> = [9].into_iter().collect();
        assert_eq!(plan_consolidation(&utxos, &pending, 64, ctx()).unwrap_err().code, "pending");
        let secret = MasterSecret::from_hex(&"55".repeat(32)).unwrap();
        let err = build_and_prove(BuildRequest {
            secret: &secret,
            key_index: 0,
            inputs: utxos.to_vec(),
            to: secret.derive_address(0),
            amount: 900_000,
            wallet_fee: None,
            fee: 6_000,
            epoch_anchor: [1; 32],
            output_slot_hints: vec![10, 11],
            exact: true,
            tip_height: 1_000,
        })
        .unwrap_err();
        assert_eq!(err.code, "stale");
        assert!(take_selected(&utxos, &[1, 1]).is_err());
    }

    #[test]
    fn wallet_fee_is_its_own_output_and_counted_in_the_network_fee() {
        let utxos = [u(10, 5_000_000), u(11, 1_000_000)];
        // 1 input -> recipient + wallet fee + change: 5000 + 100 + 3*700 + 2*2500.
        let p = plan_send(&utxos, &HashSet::new(), 2_000_000, None, ctx(), 5_000).unwrap();
        assert_eq!((p.input_count, p.output_count, p.fee, p.wallet_fee), (1, 3, 12_200, 5_000));
        assert_eq!(p.change, 5_000_000 - 2_000_000 - 5_000 - 12_200);
        assert_eq!(p.total_spend, 2_000_000 + 5_000 + 12_200);

        // Sending everything: recipient + wallet fee, no change (1 -> 2 adds one slot).
        let all = [u(1, 1_000_000)];
        let fee = 5_000 + 100 + 1_400 + 2_500;
        let p = plan_send(&all, &HashSet::new(), 1_000_000 - 5_000 - fee, None, ctx(), 5_000).unwrap();
        assert_eq!((p.output_count, p.fee, p.change), (2, fee, 0));

        // The wallet fee must be covered too.
        assert!(plan_send(&all, &HashSet::new(), 1_000_000 - fee, None, ctx(), 5_000).is_err());
    }

    #[test]
    fn send_max_with_wallet_fee_works_for_any_number_of_coins() {
        // What the app's Send Max asks for: every coin, recipient + wallet fee, no change.
        for p_slots in [0u64, 1 << 23, 3 << 22, 15 << 20] {
            let ctx = FeeContext { active_slot_count: p_slots, log_slots: 24, relay_floor: 5_000 };
            for n in [1usize, 2, 3, 7, 8, 9, 16, 25, 26, 40] {
                let utxos: Vec<Utxo> = (0..n as u32).map(|i| u(i + 1, 1_000_000)).collect();
                let (net, _) = ctx.minimum(n, 2);
                let amount = n as u64 * 1_000_000 - net - 5_000;
                let p = plan_send(&utxos, &HashSet::new(), amount, None, ctx, 5_000)
                    .unwrap_or_else(|e| panic!("{n} coins at {p_slots}: {}", e.message));
                assert_eq!((p.input_count, p.output_count, p.change, p.fee), (n, 2, 0, net), "{n} coins at {p_slots}");
            }
        }
    }

    #[test]
    fn every_plan_the_core_makes_passes_the_fee_cap() {
        // Full network load, and a busy flat relay floor; leftovers that fold into the fee.
        let full = FeeContext { active_slot_count: 1u64 << 24, log_slots: 24, relay_floor: 5_000 };
        let busy = FeeContext { active_slot_count: 0, log_slots: 24, relay_floor: 90_000 };
        for ctx in [full, busy, ctx()] {
            for coins in [1u32, 2, 3, 10] {
                let utxos: Vec<Utxo> = (0..coins).map(|i| u(100 + i, 1_000_000)).collect();
                for leftover in (0..130_000u64).step_by(700) {
                    let total = coins as u64 * 1_000_000;
                    let Some(amount) = total.checked_sub(leftover + 200_000) else { continue };
                    let Ok(plan) = plan_send(&utxos, &HashSet::new(), amount, None, ctx, wallet_fee_for(amount)) else { continue };
                    let n_out = plan.output_count as u64;
                    let cap_outputs = if plan.change == 0 { n_out + 1 } else { n_out };
                    assert!(
                        plan.fee <= max_network_fee(plan.input_count as u64, cap_outputs),
                        "coins {coins} leftover {leftover} fee {} cap {}",
                        plan.fee,
                        max_network_fee(plan.input_count as u64, cap_outputs)
                    );
                }
            }
        }
    }

    #[test]
    fn build_refuses_what_was_not_reviewed_or_allowed() {
        let secret = MasterSecret::from_hex(&"11".repeat(32)).unwrap();
        let utxos = [u(100, 3_000_000), u(101, 2_000_000)];
        let to = MasterSecret::from_hex(&"22".repeat(32)).unwrap().derive_address(0);
        let fee_to = crate::keys::parse_address(WALLET_FEE_ADDRESS).unwrap();
        let other = MasterSecret::from_hex(&"66".repeat(32)).unwrap().derive_address(0);
        let req = |amount: u64, fee: u64, wallet_fee: Option<(Address, u64)>, exact: bool, inputs: Vec<Utxo>| BuildRequest {
            secret: &secret,
            key_index: 0,
            inputs,
            to,
            amount,
            wallet_fee,
            fee,
            epoch_anchor: [0x86; 32],
            output_slot_hints: vec![500, 501, 502],
            exact,
            tip_height: 1_000,
        };
        let one = vec![utxos[0]];
        let err = |r: BuildRequest<'_>| build_and_prove(r).err().map(|e| e.message).unwrap_or_default();
        // A fee far above what the network can require (a server inflating it).
        assert!(err(req(1_000_000, 500_000, Some((fee_to, 5_000)), false, one.clone())).contains("network fee"));
        assert!(err(req(1_000_000, 120_001, Some((fee_to, 5_000)), false, one.clone())).contains("network fee"));
        // A busy relay floor (flat 0.1 NOID) is still allowed.
        assert!(max_network_fee(10, 1) >= 120_000);
        // A fee below the network minimum.
        assert!(err(req(1_000_000, 1, Some((fee_to, 5_000)), false, one.clone())).contains("network fee"));
        // A wallet fee to another address, or of another size.
        assert!(err(req(1_000_000, 9_700, Some((other, 5_000)), false, one.clone())).contains("wallet fee"));
        assert!(err(req(1_000_000, 9_700, Some((fee_to, 6_000)), false, one.clone())).contains("wallet fee"));
        // Nothing to send.
        assert!(err(req(0, 9_000, None, false, one.clone())).contains("greater than zero"));
        // A merge of one coin.
        assert!(err(req(2_994_300, 5_700, None, true, one.clone())).contains("Merge between"));
        // A token record passed off as a coin.
        let token = vec![Utxo { slot_index: 7, value: 0, creation_id: (1u64 << 62) | 5 }];
        assert!(err(req(1, 9_000, None, false, token)).contains("token"));
        assert!(spendable_utxos(&[Utxo { slot_index: 7, value: 9, creation_id: (1u64 << 62) | 5 }], &HashSet::new()).is_empty());
        // Mined coins (bit 63) stay spendable.
        assert_eq!(spendable_utxos(&[Utxo { slot_index: 8, value: 9, creation_id: (1u64 << 63) | 5 }], &HashSet::new()).len(), 1);
        assert_eq!(wallet_fee_for(1_000_000), 5_000);
        assert_eq!(wallet_fee_for(100_000_000), 250_000);
        assert_eq!(wallet_fee_for(1_000_000_000), 500_000);
    }

    #[test]
    fn three_outputs_use_a_second_page_and_verify() {
        let secret = MasterSecret::from_hex(&"11".repeat(32)).unwrap();
        let utxos = [u(100, 3_000_000)];
        let plan = plan_send(&utxos, &HashSet::new(), 1_000_000, None, ctx(), 5_000).unwrap();
        let to = MasterSecret::from_hex(&"22".repeat(32)).unwrap().derive_address(0);
        let fee_to = crate::keys::parse_address(WALLET_FEE_ADDRESS).unwrap();
        let built = build_and_prove(BuildRequest {
            secret: &secret,
            key_index: 0,
            inputs: take_selected(&utxos, &plan.selected_slots).unwrap(),
            to,
            amount: plan.amount,
            wallet_fee: Some((fee_to, plan.wallet_fee)),
            fee: plan.fee,
            epoch_anchor: [0x86; 32],
            output_slot_hints: vec![500, 501, 502],
            exact: false,
            tip_height: 1_000,
        })
        .unwrap();
        assert_eq!((built.output_count, built.fee, built.wallet_fee), (3, plan.fee, 5_000));
        assert_eq!(built.change, plan.change);

        let intent = PagedSpendIntent::from_bytes(&hex::decode(&built.intent_hex).unwrap()).unwrap();
        assert_eq!(intent.pages.len(), 2, "third output on a second page");
        let outs: Vec<(u64, Address)> = intent.pages.iter().flat_map(|p| p.body.live_outputs()).map(|(_, o)| (o.amount, o.owner)).collect();
        assert_eq!(outs, vec![(1_000_000, to), (5_000, fee_to), (plan.change, secret.derive_address(0))]);
        let facts = noid_tx::validate_paged_spend(&intent.pages).unwrap();
        assert_eq!(facts.fee, plan.fee);
        let bundle = WalletAuthorizationBundle::from_bytes(&intent.authorization_bytes).unwrap();
        verify_paged_spend_authorization_for_version(&intent.pages, &bundle, OwnerAuthorizationVersion::V3).unwrap();

        // Not enough output slots from the network: refused, nothing built.
        let err = build_and_prove(BuildRequest {
            secret: &secret,
            key_index: 0,
            inputs: take_selected(&utxos, &plan.selected_slots).unwrap(),
            to,
            amount: plan.amount,
            wallet_fee: Some((fee_to, plan.wallet_fee)),
            fee: plan.fee,
            epoch_anchor: [0x86; 32],
            output_slot_hints: vec![500, 501],
            exact: false,
            tip_height: 1_000,
        })
        .unwrap_err();
        assert_eq!(err.code, "no_slots");
    }

    #[test]
    fn built_intent_verifies_and_matches_plan() {
        let secret = MasterSecret::from_hex(&"11".repeat(32)).unwrap();
        let utxos = [u(100, 3_000_000), u(101, 250_000)];
        let plan = plan_send(&utxos, &HashSet::new(), 1_000_000, None, ctx(), 0).unwrap();
        let to = MasterSecret::from_hex(&"22".repeat(32)).unwrap().derive_address(0);
        let built = build_and_prove(BuildRequest {
            secret: &secret,
            key_index: 0,
            inputs: take_selected(&utxos, &plan.selected_slots).unwrap(),
            to,
            amount: plan.amount,
            wallet_fee: None,
            fee: plan.fee,
            epoch_anchor: [0x86; 32],
            output_slot_hints: vec![9_710_654, 9_710_655],
            exact: false,
            tip_height: 1_000,
        })
        .unwrap();
        assert_eq!((built.fee, built.input_count, built.output_count), (plan.fee, plan.input_count, plan.output_count));
        assert_eq!(built.output_slots, vec![9_710_654, 9_710_655]);

        // Decode exactly what the node receives and verify the authorization.
        let bytes = hex::decode(&built.intent_hex).unwrap();
        let intent = PagedSpendIntent::from_bytes(&bytes).unwrap();
        assert_eq!(hex::encode(intent.logical_txid().0), built.txid);
        let bundle = WalletAuthorizationBundle::from_bytes(&intent.authorization_bytes).unwrap();
        verify_paged_spend_authorization_for_version(&intent.pages, &bundle, OwnerAuthorizationVersion::V3).unwrap();
        assert_eq!(intent.pages[0].body.input_owner, secret.derive_address(0));
    }

    #[test]
    fn proof_version_switches_at_v2_1_activation() {
        assert_eq!(authorization_version(V2_1_ACTIVATION_HEIGHT - 2), OwnerAuthorizationVersion::V3);
        // The transaction lands in tip + 1, so the block before activation already proves V4.
        assert_eq!(authorization_version(V2_1_ACTIVATION_HEIGHT - 1), OwnerAuthorizationVersion::V4);
        assert_eq!(authorization_version(V2_1_ACTIVATION_HEIGHT + 500), OwnerAuthorizationVersion::V4);

        // A transaction built after activation carries a V4 proof (and not a V3 one).
        let secret = MasterSecret::from_hex(&"11".repeat(32)).unwrap();
        let utxos = [u(100, 3_000_000)];
        let plan = plan_send(&utxos, &HashSet::new(), 1_000_000, None, ctx(), 0).unwrap();
        let to = MasterSecret::from_hex(&"22".repeat(32)).unwrap().derive_address(0);
        let built = build_and_prove(BuildRequest {
            secret: &secret,
            key_index: 0,
            inputs: take_selected(&utxos, &plan.selected_slots).unwrap(),
            to,
            amount: plan.amount,
            wallet_fee: None,
            fee: plan.fee,
            epoch_anchor: [0x86; 32],
            output_slot_hints: vec![9_710_654, 9_710_655],
            exact: false,
            tip_height: V2_1_ACTIVATION_HEIGHT,
        })
        .unwrap();
        let intent = PagedSpendIntent::from_bytes(&hex::decode(&built.intent_hex).unwrap()).unwrap();
        let bundle = WalletAuthorizationBundle::from_bytes(&intent.authorization_bytes).unwrap();
        verify_paged_spend_authorization_for_version(&intent.pages, &bundle, OwnerAuthorizationVersion::V4).unwrap();
        assert!(verify_paged_spend_authorization_for_version(&intent.pages, &bundle, OwnerAuthorizationVersion::V3).is_err());
    }
}
