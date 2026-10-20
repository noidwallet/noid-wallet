//! Coin selection, send / consolidation planning, and building + proving the
//! PagedSpend intent. Ports of the official wallet:
//! - select_utxos: noid_node/src/wallet/state.rs
//! - plan_send / plan_consolidation: noid_node/src/wallet/mod.rs
//! - build_and_prove_tx: noid_node/src/wallet/builder.rs
//!
//! The phone receives the owner's live UTXOs from the node
//! (paranoid_getSlotsByOwner) and tracks its own pending slots.

use std::collections::HashSet;

use noid_gkr::{prove_paged_spend_authorization, OwnerAuthWitness};
use noid_poseidon2b::primitives::{derive_address, Address};
use noid_tx::{
    output_bitmap_bit, PagedSpendIntent, TxBody, TxInput, TxOutput, TxPage, PAGED_SPEND_END_BIT,
    PAGED_SPEND_START_BIT, TX_INPUTS, TX_OUTPUTS,
};
use serde::{Deserialize, Serialize};

use crate::fees::{fee_breakdown, FeeBreakdown};
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
    pub change: u64,
    pub input_count: usize,
    pub output_count: usize,
    pub input_slots: Vec<u32>,
    pub output_slots: Vec<u32>,
    pub prove_ms: u64,
}

fn spendable_utxos<'a>(utxos: &'a [Utxo], pending_inputs: &HashSet<u32>) -> Vec<&'a Utxo> {
    let mut seen = HashSet::new();
    utxos
        .iter()
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
pub fn plan_send(
    utxos: &[Utxo],
    pending_inputs: &HashSet<u32>,
    amount: u64,
    explicit_fee: Option<u64>,
    ctx: FeeContext,
) -> Result<SendPlan, Error> {
    if amount == 0 {
        return Err(Error::msg("Enter an amount greater than zero."));
    }
    let mut available = spendable_utxos(utxos, pending_inputs);
    available.sort_by_key(|u| (std::cmp::Reverse(u.value), u.slot_index));
    let spendable = sum(available.iter().map(|u| u.value))?;

    let (cheapest, _) = ctx.minimum(1, 1);
    if let Some(fee) = explicit_fee {
        if fee < cheapest {
            return Err(Error::msg(format!(
                "That fee is too low. The minimum right now is {} NOID.",
                crate::fmt_noid(cheapest)
            )));
        }
    }
    let minimum_fee = explicit_fee.unwrap_or(cheapest);
    let minimum_total = amount.checked_add(minimum_fee).ok_or_else(|| Error::msg("Amount is too large."))?;
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
            let outputs = 1 + usize::from(change > 0);
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

        let (one_output_fee, _) = ctx.minimum(input_count, 1);
        if selected_value > amount {
            let (two_output_fee, _) = ctx.minimum(input_count, 2);
            let need = amount.checked_add(two_output_fee).ok_or_else(|| Error::msg("Amount is too large."))?;
            if selected_value > need {
                planned = Some(two_output_fee);
                break;
            }
        }
        if selected_value >= amount {
            let no_change_fee = selected_value - amount;
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

    let Some((selected, change)) = select_utxos(&available, amount, fee) else {
        if available.len() > MAX_SEND_INPUTS {
            return Err(Error::coded(
                "input_limit",
                "This payment needs more than 504 coins. Merge small coins first (Consolidate), then send again.",
            ));
        }
        return Err(insufficient(amount.saturating_add(fee), spendable));
    };
    let input_count = selected.len();
    let output_count = 1 + usize::from(change > 0);
    let (minimum, breakdown) = ctx.minimum(input_count, output_count);
    if fee < minimum {
        return Err(Error::msg(format!(
            "That fee is too low for this transaction. The minimum is {} NOID.",
            crate::fmt_noid(minimum)
        )));
    }
    Ok(SendPlan {
        amount,
        fee,
        total_spend: amount + fee,
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
    let mut available = spendable_utxos(utxos, &HashSet::new());
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
    let available = spendable_utxos(utxos, pending_inputs);
    if available.is_empty() {
        return Err(Error::coded("empty", "There is nothing to claim here. It may have been claimed already."));
    }
    if available.len() > MAX_SEND_INPUTS {
        return Err(Error::msg(format!("This holds more than {MAX_SEND_INPUTS} coins; it cannot be moved in one go.")));
    }
    let spendable = sum(available.iter().map(|u| u.value))?;
    let (fee, breakdown) = ctx.minimum(available.len(), 1);
    let amount = spendable.checked_sub(fee).filter(|v| *v > 0).ok_or_else(|| {
        Error::coded("insufficient_funds", "This holds less than the network fee needed to move it.")
    })?;
    Ok(SendPlan {
        amount,
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
    pub fee: u64,
    pub epoch_anchor: [u8; 32],
    pub output_slot_hints: Vec<u32>,
    /// Consolidation: inputs must equal output + fee exactly (no change output),
    /// mirroring the official ConsolidationValueMismatch check.
    pub exact: bool,
}

/// Build the pages, forge the authorization proof and encode the intent
/// (official build_and_prove_tx). The secret never leaves this function.
pub fn build_and_prove(req: BuildRequest<'_>) -> Result<BuiltTx, Error> {
    if req.inputs.is_empty() || req.inputs.len() > MAX_SEND_INPUTS {
        return Err(Error::msg("Invalid number of inputs."));
    }
    let spend_secret = req.secret.derive_spend_secret(req.key_index);
    let owner = derive_address(&spend_secret);
    let total = sum(req.inputs.iter().map(|u| u.value))?;
    let change = total
        .checked_sub(req.amount)
        .and_then(|r| r.checked_sub(req.fee))
        .ok_or_else(|| insufficient(req.amount.saturating_add(req.fee), total))?;
    if req.exact && change != 0 {
        return Err(Error::coded("stale", "Your coins changed. Review the merge again."));
    }
    let mut seen = HashSet::new();
    if !req.inputs.iter().all(|u| seen.insert(u.slot_index)) {
        return Err(Error::msg("The same coin was selected twice."));
    }

    let needed_slots = if change > 0 { 2 } else { 1 };
    let mut hints: Vec<u32> = Vec::new();
    for slot in req.output_slot_hints {
        if !hints.contains(&slot) {
            hints.push(slot);
        }
    }
    if hints.len() < needed_slots {
        return Err(Error::coded("no_slots", "The network did not return enough free output slots. Try again."));
    }

    let mut outputs = [TxOutput::dummy(); TX_OUTPUTS];
    outputs[0] = TxOutput { slot_index: hints[0], amount: req.amount, owner: req.to };
    let mut validity = output_bitmap_bit(0);
    if change > 0 {
        outputs[1] = TxOutput { slot_index: hints[1], amount: change, owner };
        validity |= output_bitmap_bit(1);
    }

    let page_count = req.inputs.len().div_ceil(TX_INPUTS).max(1);
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
        if page_index == 0 {
            page_outputs = outputs;
            bitmap |= validity | PAGED_SPEND_START_BIT;
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
    let bundle = prove_paged_spend_authorization(&pages, OwnerAuthWitness::new(spend_secret))
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
    use noid_gkr::{verify_paged_spend_authorization, WalletAuthorizationBundle};

    fn ctx() -> FeeContext {
        FeeContext { active_slot_count: 0, log_slots: 24, relay_floor: 5_000 }
    }
    fn u(slot: u32, value: u64) -> Utxo {
        Utxo { slot_index: slot, value, creation_id: slot as u64 + 7 }
    }

    #[test]
    fn auto_fee_one_input_with_change() {
        let utxos = [u(10, 5_000_000), u(11, 1_000_000)];
        let p = plan_send(&utxos, &HashSet::new(), 2_000_000, None, ctx()).unwrap();
        assert_eq!((p.input_count, p.output_count, p.fee), (1, 2, 9_000));
        assert_eq!(p.change, 5_000_000 - 2_000_000 - 9_000);
        assert_eq!(p.selected_slots, vec![10]);
    }

    #[test]
    fn auto_fee_send_all_has_no_change() {
        let utxos = [u(1, 1_000_000)];
        // 1 -> 1 needs 5000 + 100 + 700 = 5,800.
        let p = plan_send(&utxos, &HashSet::new(), 1_000_000 - 5_800, None, ctx()).unwrap();
        assert_eq!((p.output_count, p.fee, p.change), (1, 5_800, 0));
    }

    #[test]
    fn pending_inputs_are_excluded() {
        let utxos = [u(1, 1_000_000), u(2, 1_000_000)];
        let pending: HashSet<u32> = [1].into_iter().collect();
        assert!(plan_send(&utxos, &pending, 1_500_000, None, ctx()).is_err());
        let p = plan_send(&utxos, &pending, 500_000, None, ctx()).unwrap();
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
            fee: 9_000,
            epoch_anchor: [1; 32],
            output_slot_hints: vec![10, 11],
            exact: false,
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
            fee: 6_000,
            epoch_anchor: [1; 32],
            output_slot_hints: vec![10, 11],
            exact: true,
        })
        .unwrap_err();
        assert_eq!(err.code, "stale");
        assert!(take_selected(&utxos, &[1, 1]).is_err());
    }

    #[test]
    fn built_intent_verifies_and_matches_plan() {
        let secret = MasterSecret::from_hex(&"11".repeat(32)).unwrap();
        let utxos = [u(100, 3_000_000), u(101, 250_000)];
        let plan = plan_send(&utxos, &HashSet::new(), 1_000_000, None, ctx()).unwrap();
        let to = MasterSecret::from_hex(&"22".repeat(32)).unwrap().derive_address(0);
        let built = build_and_prove(BuildRequest {
            secret: &secret,
            key_index: 0,
            inputs: take_selected(&utxos, &plan.selected_slots).unwrap(),
            to,
            amount: plan.amount,
            fee: plan.fee,
            epoch_anchor: [0x86; 32],
            output_slot_hints: vec![9_710_654, 9_710_655],
            exact: false,
        })
        .unwrap();
        assert_eq!((built.fee, built.input_count, built.output_count), (plan.fee, plan.input_count, plan.output_count));
        assert_eq!(built.output_slots, vec![9_710_654, 9_710_655]);

        // Decode exactly what the node receives and verify the authorization.
        let bytes = hex::decode(&built.intent_hex).unwrap();
        let intent = PagedSpendIntent::from_bytes(&bytes).unwrap();
        assert_eq!(hex::encode(intent.logical_txid().0), built.txid);
        let bundle = WalletAuthorizationBundle::from_bytes(&intent.authorization_bytes).unwrap();
        verify_paged_spend_authorization(&intent.pages, &bundle).unwrap();
        assert_eq!(intent.pages[0].body.input_owner, secret.derive_address(0));
    }
}
