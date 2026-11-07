//! Sending tokens and NFTs (NOID 1.2).
//!
//! The wallet server asks its node's planner (`paranoid_prepareNativeIntent`,
//! Parano1d v2.1, docs/reference/client-native-rpc.md) for an unsigned
//! transfer from this phone's address. Nothing in that plan is trusted. This
//! module:
//!
//! 1. decodes the unsigned intent with the official `noid_tx` code and runs
//!    its full semantic check (`NativeIntent::checked`);
//! 2. checks every input and output against what the user asked for: the
//!    phone's own address signs; the recipient gets exactly the requested
//!    token units (or the requested NFT), unlocked; every other token and
//!    every plain NOID output comes back to this address; no other asset is
//!    touched; the network fee is within the same cap as payments;
//! 3. adds the NOID wallet fee as one more plain output (consensus allows
//!    plain NOID outputs in a native transfer and prices them like a
//!    payment's), taking it and the extra network fee from the NOID change;
//! 4. runs the official check again on the result, and only then proves with
//!    the official `prove_native_asset_authorization`, verifies the proof and
//!    encodes the intent for `paranoid_submitTxIntent`.
//!
//! [`check_native_send`] does 1 to 3 without the secret (the review screen);
//! [`build_native_send`] repeats them and proves.

use std::collections::BTreeSet;

use noid_gkr::wallet_authorization::{prove_native_asset_authorization, verify_native_asset_authorization};
use noid_gkr::OwnerAuthWitness;
use noid_poseidon2b::primitives::{derive_address, Address};
use noid_tx::native_assets::transition::NativeOperation;
use noid_tx::native_assets::wire::{NativeIntent, NATIVE_PAGE_BIT};
use noid_tx::native_assets::NativeOpening;
use noid_tx::{
    output_bitmap_bit, OwnerAuthorizationVersion, TxBody, TxInput, TxOutput, TxPage, MAX_PAGED_SPEND_PAGES,
    PAGED_SPEND_END_BIT, TX_INPUTS, TX_OUTPUTS,
};
use serde::{Deserialize, Serialize};

use crate::fees::fee_breakdown;
use crate::headers::Header;
use crate::keys::{parse_address, MasterSecret};
use crate::tx::{authorization_version, max_network_fee, WALLET_FEE_ADDRESS};
use crate::Error;

/// Native-operation chain identity: the block id of mainnet's genesis header
/// (`noid_chain::state::native_assets::native_chain_id`). Checked against the
/// official crate by tools/headers-check and against the genesis header in
/// the tests below.
pub const NATIVE_CHAIN_ID_HEX: &str = "860e70453390bf815718e933aa4927167a13d098b0151391eefd722ee1add610";

/// The NOID wallet fee for one token or NFT send, in μNOID (0.005 NOID).
/// Must match NATIVE_WALLET_FEE in app/src/lib/walletFee.ts.
pub const NATIVE_WALLET_FEE: u64 = 5_000;

/// The node's plan (`NativeClientPlan`), the fields this module uses. The
/// rest (the planner's own review, plan id) is ignored: the review shown to
/// the user is computed here from the decoded intent.
#[derive(Debug, Clone, Deserialize)]
pub struct NativePlan {
    pub schema_version: u16,
    pub owner: String,
    pub candidate_height: u64,
    pub parent_header_hex: String,
    pub chain_id: String,
    pub epoch_anchor: String,
    pub owner_authorization_version: u8,
    pub intent_kind: String,
    pub unsigned_intent_hex: String,
}

/// What the user asked to send.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Transfer {
    #[serde(rename_all = "camelCase")]
    Token { asset_id: String, units: String, recipient: String },
    #[serde(rename_all = "camelCase")]
    Nft { collection_id: String, serial: String, recipient: String },
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeSendRequest {
    pub plan: NativePlan,
    pub transfer: Transfer,
    /// Free output slots from the server, for the wallet fee output.
    pub slot_hints: Vec<u32>,
    /// The node's relay floor (μNOID), as for payments.
    pub relay_floor: u64,
}

/// The review: every figure computed on the phone from the decoded intent.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeSendReview {
    pub kind: &'static str,
    pub recipient: String,
    pub asset_id: Option<String>,
    pub units: Option<String>,
    pub collection_id: Option<String>,
    pub serial: Option<String>,
    /// Network fee, μNOID (including the extra output for the wallet fee).
    pub network_fee: u64,
    pub wallet_fee: u64,
    /// NOID leaving this address in all: network fee plus wallet fee.
    pub noid_debit: u64,
    pub input_count: usize,
    pub output_count: usize,
    /// Block the plan was built on (the transfer is meant for the next one).
    pub parent_height: u64,
    pub parent_id: String,
    pub txid: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BuiltNativeSend {
    pub review: NativeSendReview,
    pub intent_hex: String,
    pub txid: String,
    /// This address's NOID coins the send spends (slot, origin id as a
    /// decimal string: the app's pending and refusal tracking uses them).
    pub noid_inputs: Vec<NoidInput>,
    /// Token and NFT records the send spends.
    pub record_input_slots: Vec<u32>,
    /// Every output slot it creates.
    pub output_slots: Vec<u32>,
    pub prove_ms: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NoidInput {
    pub slot_index: u32,
    pub creation_id: String,
}

fn bad(message: &str) -> Error {
    Error::coded("plan_refused", format!("The server's transfer was refused: {message}. Nothing was signed."))
}

fn hex32(s: &str, what: &str) -> Result<[u8; 32], Error> {
    let v = hex::decode(s).map_err(|_| bad(what))?;
    v.try_into().map_err(|_| bad(what))
}

fn parse_u64(s: &str, what: &str) -> Result<u64, Error> {
    if s.is_empty() || s.len() > 20 || !s.bytes().all(|b| b.is_ascii_digit()) {
        return Err(Error::msg(format!("{what} must be a whole number.")));
    }
    s.parse::<u64>().map_err(|_| Error::msg(format!("{what} is out of range.")))
}

/// The checked plan, with the wallet fee output added, ready to prove.
struct Prepared {
    intent: NativeIntent,
    chain: [u8; 32],
    height: u64,
    review: NativeSendReview,
}

fn prepare(owner: Address, req: &NativeSendRequest) -> Result<Prepared, Error> {
    let plan = &req.plan;
    // The plan's frame.
    if plan.schema_version != 1 || plan.intent_kind != "operation" {
        return Err(bad("not a plain transfer"));
    }
    if parse_address(&plan.owner).map_err(|_| bad("owner"))? != owner {
        return Err(bad("it is for another address"));
    }
    let chain = hex32(&plan.chain_id, "chain")?;
    if hex::encode(chain) != NATIVE_CHAIN_ID_HEX {
        return Err(bad("it is for another network"));
    }
    let parent = Header::from_hex(&plan.parent_header_hex).ok_or_else(|| bad("parent block"))?;
    let height = plan.candidate_height;
    if parent.height.checked_add(1) != Some(height) {
        return Err(bad("parent block height"));
    }
    if authorization_version(parent.height) != OwnerAuthorizationVersion::V4 || plan.owner_authorization_version != 4 {
        return Err(bad("proof version"));
    }
    let anchor = hex32(&plan.epoch_anchor, "anchor")?;

    // The intent itself, decoded and checked by the official code.
    let bytes = hex::decode(&plan.unsigned_intent_hex).map_err(|_| bad("encoding"))?;
    let mut intent = NativeIntent::from_bytes(&bytes).map_err(|e| bad(&format!("{e}")))?;
    if !intent.authorization_bytes.is_empty() || !intent.dependencies.is_empty() {
        return Err(bad("unexpected attachments"));
    }
    let facts = intent.checked(chain, height).map_err(|e| bad(&format!("{e}")))?;
    if facts.pages.authority != owner || facts.pages.chain != chain || facts.pages.epoch_anchor != anchor {
        return Err(bad("signer, network or anchor"));
    }

    // What the user asked for.
    let (recipient, wanted_asset, wanted_units, wanted_nft) = match &req.transfer {
        Transfer::Token { asset_id, units, recipient } => {
            let units = parse_u64(units, "The amount")?;
            if units == 0 {
                return Err(Error::msg("Enter an amount greater than zero."));
            }
            (recipient, Some(hex32(asset_id, "token id")?), units, None)
        }
        Transfer::Nft { collection_id, serial, recipient } => {
            (recipient, None, 0, Some((hex32(collection_id, "collection id")?, parse_u64(serial, "The serial")?)))
        }
    };
    let to = parse_address(recipient)?;
    if to == owner {
        return Err(Error::msg("You can't send to your own address."));
    }
    match (facts.pages.operation, wanted_asset, wanted_nft) {
        (NativeOperation::TransferToken { asset }, Some(a), None) if asset.0 == a => {}
        (NativeOperation::TransferNft, None, Some(_)) => {}
        _ => return Err(bad("it is a different operation")),
    }

    // Inputs: this address's NOID, and only the token or NFT being sent.
    if facts.inputs.len() > crate::tx::MAX_SEND_INPUTS {
        return Err(bad("too many inputs"));
    }
    let mut spent_nft = false;
    for claim in &facts.inputs {
        match &claim.opening {
            None if claim.root == owner => {}
            Some(NativeOpening::TokenBalance(b)) if Some(b.asset.0) == wanted_asset && b.owner == owner => {}
            Some(NativeOpening::NftItem(n)) if Some((n.collection.0, n.serial)) == wanted_nft && n.owner == owner && !spent_nft => {
                spent_nft = true;
            }
            _ => return Err(bad("it spends something you didn't choose")),
        }
    }
    if wanted_nft.is_some() && !spent_nft {
        return Err(bad("the NFT is missing"));
    }

    // Outputs: the recipient gets exactly what was asked, unlocked; all else
    // comes back here. Plain NOID outputs are change to this address only.
    // The planner's shape (noid_rpc planner `finish`): one record to the
    // recipient, at most one token change record, one NOID change output.
    // Anything more would only add fees or leave the recipient with dust.
    let mut to_recipient = 0u64;
    let mut recipient_records = 0usize;
    let mut change_records = 0usize;
    let mut nft_out = false;
    let mut change: Vec<usize> = Vec::new();
    for (i, claim) in facts.outputs.iter().enumerate() {
        match &claim.opening {
            None if claim.output.owner == owner => change.push(i),
            Some(NativeOpening::TokenBalance(b)) if Some(b.asset.0) == wanted_asset && b.unlock_height == 0 => {
                if b.owner == to {
                    to_recipient = to_recipient.checked_add(b.units).ok_or_else(|| bad("amount"))?;
                    recipient_records += 1;
                } else if b.owner == owner {
                    change_records += 1;
                } else {
                    return Err(bad("tokens go to a third address"));
                }
            }
            Some(NativeOpening::NftItem(n))
                if Some((n.collection.0, n.serial)) == wanted_nft && n.owner == to && n.unlock_height == 0 && !nft_out =>
            {
                nft_out = true;
            }
            _ => return Err(bad("an output you didn't ask for")),
        }
    }
    if wanted_asset.is_some() && to_recipient != wanted_units {
        return Err(bad("the amount differs"));
    }
    if recipient_records > 1 || change_records > 1 || change.len() > 1 {
        return Err(bad("more outputs than a transfer needs"));
    }
    if wanted_nft.is_some() && !nft_out {
        return Err(bad("the NFT doesn't reach the recipient"));
    }

    // The planner's network fee, within the same bounds as a payment's.
    let n_in = facts.inputs.len() as u64;
    let n_out = facts.outputs.len() as u64;
    let old_fee = facts.pages.fee;
    let asc = parent.active_slot_count;
    let ls = parent.log_slots;
    let lowest = fee_breakdown(n_in, n_out, 0, 32).required_total;
    if old_fee < lowest || old_fee > max_network_fee(n_in, n_out + 1) {
        return Err(bad("the network fee is outside what the network can require"));
    }

    // One more output: the wallet fee. The network fee grows by what one
    // output adds, and never below the new minimum or the relay floor.
    let required_now = fee_breakdown(n_in, n_out, asc, ls).required_total;
    let required_next = fee_breakdown(n_in, n_out + 1, asc, ls).required_total;
    let floor = req.relay_floor.min(crate::tx::RELAY_FLOOR_CEILING);
    let new_fee = old_fee
        .checked_add(required_next.saturating_sub(required_now))
        .ok_or_else(|| bad("fee"))?
        .max(required_next)
        .max(floor);
    if new_fee > max_network_fee(n_in, n_out + 1) {
        return Err(bad("the network fee is outside what the network can require"));
    }
    let cost = new_fee - old_fee + NATIVE_WALLET_FEE;
    // Take it from the largest NOID change output; at least 1 μNOID stays.
    let Some(&change_index) = change.iter().max_by_key(|&&i| facts.outputs[i].output.amount) else {
        return Err(Error::coded("no_change", "This transfer has no NOID change to pay the fee from. Receive a little more NOID and try again."));
    };
    if facts.outputs[change_index].output.amount <= cost {
        return Err(Error::coded("no_change", "Not enough NOID for the fees. Receive a little more NOID and try again."));
    }
    let used: BTreeSet<u32> = facts
        .inputs
        .iter()
        .map(|c| c.input.slot_index)
        .chain(facts.outputs.iter().map(|c| c.output.slot_index))
        .collect();
    let Some(slot) = req.slot_hints.iter().copied().find(|s| !used.contains(s)) else {
        return Err(Error::coded("no_slots", "The network did not return a free output slot. Try again."));
    };
    let fee_to = parse_address(WALLET_FEE_ADDRESS)?;

    // Edit the pages: lower the change, raise the fee, append the output.
    let mut seen = 0usize;
    'outer: for page in intent.pages.iter_mut().skip(1) {
        for i in 0..TX_OUTPUTS {
            if page.body.output_is_live(i) {
                if seen == change_index {
                    page.body.outputs[i].amount -= cost;
                    break 'outer;
                }
                seen += 1;
            }
        }
    }
    intent.pages[0].body.fee = new_fee;
    append_plain_output(&mut intent, TxOutput { slot_index: slot, amount: NATIVE_WALLET_FEE, owner: fee_to })?;
    intent.output_openings.push(None);

    // The official check again, on exactly what will be signed.
    let after = intent.checked(chain, height).map_err(|e| bad(&format!("after adding the fee: {e}")))?;
    let fee_outputs = after
        .outputs
        .iter()
        .filter(|c| c.opening.is_none() && c.output.owner == fee_to && c.output.amount == NATIVE_WALLET_FEE)
        .count();
    if after.pages.fee != new_fee || after.outputs.len() as u64 != n_out + 1 || fee_outputs != 1 {
        return Err(bad("the fee could not be added"));
    }

    let (kind, asset_id, units, collection_id, serial) = match &req.transfer {
        Transfer::Token { asset_id, .. } => ("token", Some(asset_id.clone()), Some(wanted_units.to_string()), None, None),
        Transfer::Nft { collection_id, .. } => {
            ("nft", None, None, Some(collection_id.clone()), wanted_nft.map(|(_, s)| s.to_string()))
        }
    };
    let review = NativeSendReview {
        kind,
        recipient: to.to_bech32(),
        asset_id,
        units,
        collection_id,
        serial,
        network_fee: new_fee,
        wallet_fee: NATIVE_WALLET_FEE,
        noid_debit: new_fee + NATIVE_WALLET_FEE,
        input_count: after.inputs.len(),
        output_count: after.outputs.len(),
        parent_height: parent.height,
        parent_id: hex::encode(crate::headers::block_id(&parent)),
        txid: hex::encode(after.pages.logical_txid.0),
    };
    Ok(Prepared { intent, chain, height, review })
}

/// Append `output` after the intent's last output, keeping the layout the
/// native format requires: outputs fill pages in order, two per page, and a
/// page with fewer than two is the last one with any.
fn append_plain_output(intent: &mut NativeIntent, output: TxOutput) -> Result<(), Error> {
    let pages = &mut intent.pages;
    // The first data page with room: a page with fewer than two outputs.
    // Pages before it are full; pages after it have none.
    let target = (1..pages.len()).find(|&i| pages[i].body.live_output_count() < TX_OUTPUTS);
    match target {
        Some(i) => {
            let body = &mut pages[i].body;
            let n = body.live_output_count();
            body.outputs[n] = output;
            body.validity_bitmap |= output_bitmap_bit(n);
        }
        None => {
            if pages.len() >= MAX_PAGED_SPEND_PAGES {
                return Err(bad("no room for the fee output"));
            }
            let anchor = pages[0].body.epoch_anchor;
            let last = pages.len() - 1;
            pages[last].body.validity_bitmap &= !PAGED_SPEND_END_BIT;
            let mut outputs = [TxOutput::dummy(); TX_OUTPUTS];
            outputs[0] = output;
            pages.push(TxPage {
                body: TxBody {
                    epoch_anchor: anchor,
                    fee: 0,
                    input_owner: Address([0; 32]),
                    inputs: [TxInput::dummy(); TX_INPUTS],
                    outputs,
                    validity_bitmap: NATIVE_PAGE_BIT | output_bitmap_bit(0) | PAGED_SPEND_END_BIT,
                    is_coinbase: false,
                },
            });
        }
    }
    Ok(())
}

/// Check a plan for `owner` and work out the review, without the secret.
pub fn check_native_send(owner: &str, req: &NativeSendRequest) -> Result<NativeSendReview, Error> {
    Ok(prepare(parse_address(owner)?, req)?.review)
}

/// Check, add the wallet fee, prove and encode. The secret never leaves here.
pub fn build_native_send(secret: &MasterSecret, key_index: u32, req: &NativeSendRequest) -> Result<BuiltNativeSend, Error> {
    let spend = secret.derive_spend_secret(key_index);
    let owner = derive_address(&spend);
    let Prepared { mut intent, chain, height, review } = prepare(owner, req)?;
    let started = std::time::Instant::now();
    let bundle = prove_native_asset_authorization(&intent, chain, height, OwnerAuthWitness::new(spend), OwnerAuthorizationVersion::V4)
        .map_err(|e| Error::msg(format!("Could not forge the proof: {e}")))?;
    let prove_ms = started.elapsed().as_millis() as u64;
    verify_native_asset_authorization(&intent, chain, height, &bundle, OwnerAuthorizationVersion::V4)
        .map_err(|e| Error::msg(format!("The proof did not verify: {e:?}")))?;
    intent.authorization_bytes = bundle.to_bytes().map_err(|e| Error::msg(format!("Could not encode the proof: {e}")))?;
    let bytes = intent.to_bytes().map_err(|e| Error::msg(format!("Could not encode the transfer: {e}")))?;
    // What goes out must decode to the same transfer.
    let back = NativeIntent::from_bytes(&bytes).map_err(|e| Error::msg(format!("Encoded transfer is invalid: {e}")))?;
    let facts = back.checked(chain, height).map_err(|e| Error::msg(format!("Encoded transfer is invalid: {e}")))?;
    if hex::encode(facts.pages.logical_txid.0) != review.txid {
        return Err(Error::msg("Encoded transfer differs from the review."));
    }
    Ok(BuiltNativeSend {
        txid: review.txid.clone(),
        intent_hex: hex::encode(bytes),
        noid_inputs: facts
            .inputs
            .iter()
            .filter(|c| c.opening.is_none())
            .map(|c| NoidInput { slot_index: c.input.slot_index, creation_id: c.input.creation_id.to_string() })
            .collect(),
        record_input_slots: facts.inputs.iter().filter(|c| c.opening.is_some()).map(|c| c.input.slot_index).collect(),
        output_slots: facts.outputs.iter().map(|c| c.output.slot_index).collect(),
        review,
        prove_ms,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use noid_tx::native_assets::transition::{NativeContext, NativeInputClaim, NativeOutputClaim};
    use noid_tx::native_assets::{AssetId, CollectionId, NftItem, TokenBalance};

    const SECRET: &str = "1f2e3d4c5b6a79881f2e3d4c5b6a79881f2e3d4c5b6a79881f2e3d4c5b6a7988";
    const RECIPIENT: &str = "o1s32s5m9ughjv2ktvxm8m7y0gmu0swys5t0ufkdnyhv02nudc23cqg7y34s";
    const HEIGHT: u64 = 280_001;
    const ASC: u64 = 100_000;
    const LS: u32 = 24;
    const ANCHOR: [u8; 32] = [7; 32];

    fn chain() -> [u8; 32] {
        hex32(NATIVE_CHAIN_ID_HEX, "chain").unwrap()
    }

    fn me() -> Address {
        MasterSecret::from_hex(SECRET).unwrap().derive_address(0)
    }

    fn parent() -> Header {
        Header {
            prev_block_hash: [1; 32],
            state_root: [2; 32],
            tx_root: [3; 32],
            timestamp: 1_793_800_000,
            height: HEIGHT - 1,
            miner_address: [4; 32],
            nonce: 5,
            difficulty_target: [0xff; 32],
            log_slots: LS,
            active_slot_count: ASC,
            alloc_counter: 6,
        }
    }

    fn noid_in(slot: u32, amount: u64, owner: Address) -> NativeInputClaim {
        NativeInputClaim { input: TxInput { slot_index: slot, amount, creation_id: 42 }, root: owner, opening: None }
    }

    fn native_in(slot: u32, opening: NativeOpening) -> NativeInputClaim {
        NativeInputClaim { input: TxInput { slot_index: slot, amount: 0, creation_id: (1 << 62) | 43 }, root: opening.root(), opening: Some(opening) }
    }

    fn noid_out(slot: u32, amount: u64, owner: Address) -> NativeOutputClaim {
        NativeOutputClaim { output: TxOutput { slot_index: slot, amount, owner }, opening: None }
    }

    fn native_out(slot: u32, opening: NativeOpening) -> NativeOutputClaim {
        NativeOutputClaim { output: TxOutput { slot_index: slot, amount: 0, owner: opening.root() }, opening: Some(opening) }
    }

    fn token(owner: Address, units: u64) -> NativeOpening {
        NativeOpening::TokenBalance(TokenBalance { asset: AssetId([9; 32]), owner, units, unlock_height: 0 })
    }

    /// A transfer as the planner would build it, valid under the official rules.
    fn intent(op: NativeOperation, inputs: Vec<NativeInputClaim>, outputs: Vec<NativeOutputClaim>, fee: u64) -> NativeIntent {
        let ctx = NativeContext { chain: chain(), height: HEIGHT, authority: me(), fee };
        NativeIntent::from_claims(&ctx, ANCHOR, op, inputs, outputs).expect("valid test intent")
    }

    fn plan_fee(n_in: u64, n_out: u64) -> u64 {
        fee_breakdown(n_in, n_out, ASC, LS).required_total
    }

    fn token_intent(to_recipient: u64, extra: Vec<NativeOutputClaim>) -> NativeIntent {
        let fee = plan_fee(2, 3 + extra.len() as u64);
        let to = parse_address(RECIPIENT).unwrap();
        let mut outputs = vec![native_out(101, token(to, to_recipient)), native_out(102, token(me(), 100 - to_recipient))];
        let extra_noid: u64 = extra.iter().map(|o| o.output.amount).sum();
        outputs.push(noid_out(103, 1_000_000 - fee - extra_noid, me()));
        outputs.extend(extra);
        intent(
            NativeOperation::TransferToken { asset: AssetId([9; 32]) },
            vec![noid_in(1, 1_000_000, me()), native_in(2, token(me(), 100))],
            outputs,
            fee,
        )
    }

    fn request(intent: &NativeIntent, transfer: Transfer) -> NativeSendRequest {
        NativeSendRequest {
            plan: NativePlan {
                schema_version: 1,
                owner: me().to_bech32(),
                candidate_height: HEIGHT,
                parent_header_hex: hex::encode(parent().to_bytes()),
                chain_id: NATIVE_CHAIN_ID_HEX.into(),
                epoch_anchor: hex::encode(ANCHOR),
                owner_authorization_version: 4,
                intent_kind: "operation".into(),
                unsigned_intent_hex: hex::encode(intent.to_bytes().unwrap()),
            },
            transfer,
            slot_hints: vec![101, 500, 501],
            relay_floor: 0,
        }
    }

    fn send_tokens(units: u64) -> Transfer {
        Transfer::Token { asset_id: hex::encode([9u8; 32]), units: units.to_string(), recipient: RECIPIENT.into() }
    }

    #[test]
    fn chain_id_is_the_genesis_block_id() {
        // Mainnet genesis header, from noid_chain::consensus::genesis_header (v2.1.0).
        let genesis = "00000000000000000000000000000000000000000000000000000000000000005c7f3712611c836a2c6ab0448d32c271f04e3213560e8a5321331cd6a5c9849200000000000000000000000000000000000000000000000000000000000000000076886a00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000a6e000000000000000000000000000000000000000000000000000000000000000000000000000000000000004000001800000000000000000000000000000000000000";
        let h = Header::from_hex(genesis).unwrap();
        assert_eq!(hex::encode(crate::headers::block_id(&h)), NATIVE_CHAIN_ID_HEX);
    }

    #[test]
    fn a_planned_token_transfer_gets_the_fee_and_a_valid_proof() {
        let plan = token_intent(30, vec![]);
        let req = request(&plan, send_tokens(30));
        let review = check_native_send(&me().to_bech32(), &req).unwrap();
        // One extra output: the network fee grows by exactly what it adds.
        let fee = plan_fee(2, 3) + (plan_fee(2, 4) - plan_fee(2, 3));
        assert_eq!(review.network_fee, fee);
        assert_eq!(review.wallet_fee, NATIVE_WALLET_FEE);
        assert_eq!(review.noid_debit, fee + NATIVE_WALLET_FEE);
        assert_eq!((review.units.as_deref(), review.recipient.as_str()), (Some("30"), RECIPIENT));
        assert_eq!(review.output_count, 4);

        let secret = MasterSecret::from_hex(SECRET).unwrap();
        let built = build_native_send(&secret, 0, &req).unwrap();
        assert_eq!(built.review, review);
        assert_eq!(built.noid_inputs, vec![NoidInput { slot_index: 1, creation_id: "42".into() }]);
        assert_eq!(built.record_input_slots, vec![2]);
        assert_eq!(built.output_slots.len(), 4);
        let sent = NativeIntent::from_bytes(&hex::decode(&built.intent_hex).unwrap()).unwrap();
        let facts = sent.checked(chain(), HEIGHT).unwrap();
        assert_eq!(facts.pages.fee, fee);
        // Slot 101 was taken by the plan, so the fee output got the next hint.
        let fee_out = facts.outputs.iter().find(|c| c.output.owner == parse_address(WALLET_FEE_ADDRESS).unwrap()).unwrap();
        assert_eq!((fee_out.output.slot_index, fee_out.output.amount), (500, NATIVE_WALLET_FEE));
        let change: u64 = facts.outputs.iter().filter(|c| c.opening.is_none() && c.output.owner == me()).map(|c| c.output.amount).sum();
        assert_eq!(change, 1_000_000 - fee - NATIVE_WALLET_FEE);
        let bundle = noid_gkr::WalletAuthorizationBundle::from_bytes(&sent.authorization_bytes).unwrap();
        verify_native_asset_authorization(&sent, chain(), HEIGHT, &bundle, OwnerAuthorizationVersion::V4).unwrap();
    }

    #[test]
    fn the_fee_output_goes_on_the_first_page_with_room() {
        // A whole send (no token change): the two outputs fill the first data
        // page, and the fee output goes on the next page (the token input's
        // own page: inputs with another owner always get a page of their own,
        // so a transfer of this shape never needs a new page).
        let fee = plan_fee(1, 2);
        let to = parse_address(RECIPIENT).unwrap();
        let plan = intent(
            NativeOperation::TransferToken { asset: AssetId([9; 32]) },
            vec![native_in(2, token(me(), 100)), noid_in(1, 1_000_000, me())],
            vec![native_out(101, token(to, 100)), noid_out(103, 1_000_000 - fee, me())],
            fee,
        );
        let before = plan.pages.len();
        let req = request(&plan, send_tokens(100));
        let review = check_native_send(&me().to_bech32(), &req).unwrap();
        assert_eq!(review.output_count, 3);
        let secret = MasterSecret::from_hex(SECRET).unwrap();
        let built = build_native_send(&secret, 0, &req).unwrap();
        let sent = NativeIntent::from_bytes(&hex::decode(&built.intent_hex).unwrap()).unwrap();
        sent.checked(chain(), HEIGHT).unwrap();
        assert_eq!(sent.pages.len(), before);
        assert_eq!(sent.pages[2].body.live_output_count(), 1);
    }

    #[test]
    fn transfers_that_differ_from_the_request_are_refused() {
        let owner = me().to_bech32();
        let refused = |plan: &NativeIntent, transfer: Transfer| check_native_send(&owner, &request(plan, transfer)).unwrap_err().message;
        // Fewer or more units than asked.
        assert!(refused(&token_intent(30, vec![]), send_tokens(31)).contains("amount differs"));
        // NOID to a third address.
        let thief = parse_address("o1wrznmh6td3mgg9mu0a3kkxxn2lnfu827uykrnpaa90mex8su9zcs5sjxrk").unwrap();
        assert!(refused(&token_intent(30, vec![noid_out(104, 50_000, thief)]), send_tokens(30)).contains("didn't ask for"));
        // Token change to a third address.
        let fee = plan_fee(2, 3);
        let to = parse_address(RECIPIENT).unwrap();
        let stolen = intent(
            NativeOperation::TransferToken { asset: AssetId([9; 32]) },
            vec![noid_in(1, 1_000_000, me()), native_in(2, token(me(), 100))],
            vec![native_out(101, token(to, 30)), native_out(102, token(thief, 70)), noid_out(103, 1_000_000 - fee, me())],
            fee,
        );
        assert!(refused(&stolen, send_tokens(30)).contains("third address"));
        // Tokens locked for the recipient.
        let locked = NativeOpening::TokenBalance(TokenBalance { asset: AssetId([9; 32]), owner: to, units: 30, unlock_height: 999_999 });
        let lock = intent(
            NativeOperation::TransferToken { asset: AssetId([9; 32]) },
            vec![noid_in(1, 1_000_000, me()), native_in(2, token(me(), 100))],
            vec![native_out(101, locked), native_out(102, token(me(), 70)), noid_out(103, 1_000_000 - fee, me())],
            fee,
        );
        assert!(refused(&lock, send_tokens(30)).contains("didn't ask for"));
        // A different token than the one chosen.
        let other = Transfer::Token { asset_id: hex::encode([8u8; 32]), units: "30".into(), recipient: RECIPIENT.into() };
        assert!(refused(&token_intent(30, vec![]), other).contains("different operation"));
        // A different recipient.
        let elsewhere = Transfer::Token {
            asset_id: hex::encode([9u8; 32]),
            units: "30".into(),
            recipient: "o1wrznmh6td3mgg9mu0a3kkxxn2lnfu827uykrnpaa90mex8su9zcs5sjxrk".into(),
        };
        assert!(check_native_send(&owner, &request(&token_intent(30, vec![]), elsewhere)).is_err());
        // A network fee no network can require.
        let greedy = {
            let big = max_network_fee(2, 4) + 1;
            intent(
                NativeOperation::TransferToken { asset: AssetId([9; 32]) },
                vec![noid_in(1, 1_000_000, me()), native_in(2, token(me(), 100))],
                vec![native_out(101, token(to, 30)), native_out(102, token(me(), 70)), noid_out(103, 1_000_000 - big, me())],
                big,
            )
        };
        assert!(refused(&greedy, send_tokens(30)).contains("network fee"));
        // Change split into many outputs (each adds fee room), or the
        // recipient's tokens split into dust records.
        assert!(refused(&token_intent(30, vec![noid_out(104, 50_000, me())]), send_tokens(30)).contains("more outputs"));
        let dust = intent(
            NativeOperation::TransferToken { asset: AssetId([9; 32]) },
            vec![noid_in(1, 1_000_000, me()), native_in(2, token(me(), 100))],
            vec![native_out(101, token(to, 15)), native_out(105, token(to, 15)), native_out(102, token(me(), 70)), noid_out(103, 1_000_000 - plan_fee(2, 4), me())],
            plan_fee(2, 4),
        );
        assert!(refused(&dust, send_tokens(30)).contains("more outputs"));
    }

    #[test]
    fn the_plan_frame_must_match() {
        let plan = token_intent(30, vec![]);
        let owner = me().to_bech32();
        let mut r = request(&plan, send_tokens(30));
        r.plan.chain_id = hex::encode([0u8; 32]);
        assert!(check_native_send(&owner, &r).is_err());
        let mut r = request(&plan, send_tokens(30));
        r.plan.candidate_height += 1;
        assert!(check_native_send(&owner, &r).is_err());
        let mut r = request(&plan, send_tokens(30));
        r.plan.owner = RECIPIENT.into();
        assert!(check_native_send(&owner, &r).is_err());
        let mut r = request(&plan, send_tokens(30));
        r.plan.epoch_anchor = hex::encode([8u8; 32]);
        assert!(check_native_send(&owner, &r).is_err());
        // Someone else's wallet can't use this plan.
        assert!(check_native_send(RECIPIENT, &request(&plan, send_tokens(30))).is_err());
        // Not enough NOID change for the fees.
        let fee = plan_fee(2, 3);
        let to = parse_address(RECIPIENT).unwrap();
        let tight = intent(
            NativeOperation::TransferToken { asset: AssetId([9; 32]) },
            vec![noid_in(1, fee + 1_000, me()), native_in(2, token(me(), 100))],
            vec![native_out(101, token(to, 30)), native_out(102, token(me(), 70)), noid_out(103, 1_000, me())],
            fee,
        );
        assert_eq!(check_native_send(&owner, &request(&tight, send_tokens(30))).unwrap_err().code, "no_change");
    }

    /// The JSON the app sends: the node's plan as it comes (snake_case, with
    /// fields this module ignores), the transfer, and pending slots.
    #[test]
    fn through_the_app_entry_point() {
        let plan = token_intent(30, vec![]);
        let r = request(&plan, send_tokens(30));
        let plan_json = serde_json::json!({
            "schema_version": 1, "plan_id": "ab", "intent_id": "cd", "owner": r.plan.owner,
            "candidate_height": HEIGHT, "parent_header_hex": r.plan.parent_header_hex, "chain_id": NATIVE_CHAIN_ID_HEX,
            "epoch_anchor": r.plan.epoch_anchor, "owner_authorization_version": 4, "intent_kind": "operation",
            "unsigned_intent_hex": r.plan.unsigned_intent_hex, "review": { "fee_micronoid": "1" },
        });
        let request = serde_json::json!({
            "plan": plan_json,
            "transfer": { "kind": "token", "assetId": hex::encode([9u8; 32]), "units": "30", "recipient": RECIPIENT },
            "slotHints": [500, 501], "relayFloor": 0,
        });
        let out: serde_json::Value = serde_json::from_str(&crate::call(
            "checkNativeSend",
            &serde_json::json!({ "owner": me().to_bech32(), "request": request, "pendingOutputSlots": [] }).to_string(),
        ))
        .unwrap();
        assert_eq!(out["ok"]["walletFee"], NATIVE_WALLET_FEE);
        // Slots held by a pending send are not reused for the fee output.
        let out: serde_json::Value = serde_json::from_str(&crate::call(
            "checkNativeSend",
            &serde_json::json!({ "owner": me().to_bech32(), "request": request, "pendingOutputSlots": [500, 501] }).to_string(),
        ))
        .unwrap();
        assert_eq!(out["error"]["code"], "no_slots");
    }

    #[test]
    fn an_nft_transfer_is_checked_the_same_way() {
        let to = parse_address(RECIPIENT).unwrap();
        let item = |owner: Address| NativeOpening::NftItem(NftItem { collection: CollectionId([5; 32]), owner, metadata: [6; 32], serial: 3, unlock_height: 0 });
        let fee = plan_fee(2, 2);
        let plan = intent(
            NativeOperation::TransferNft,
            vec![noid_in(1, 1_000_000, me()), native_in(2, item(me()))],
            vec![native_out(101, item(to)), noid_out(102, 1_000_000 - fee, me())],
            fee,
        );
        let nft = |serial: &str| Transfer::Nft { collection_id: hex::encode([5u8; 32]), serial: serial.into(), recipient: RECIPIENT.into() };
        let review = check_native_send(&me().to_bech32(), &request(&plan, nft("3"))).unwrap();
        assert_eq!((review.kind, review.serial.as_deref(), review.output_count), ("nft", Some("3"), 3));
        assert!(check_native_send(&me().to_bech32(), &request(&plan, nft("4"))).is_err());
    }
}

/// Experiment (not part of the app): does a real node plan for another
/// operation still pass the official checks with the wallet fee output added?
/// Run: PLAN_FILE=path/to/plan-out.json cargo test --release fee_output_on_a_real_plan -- --ignored --nocapture
#[cfg(test)]
mod fee_output_experiment {
    use super::*;

    #[test]
    #[ignore]
    fn fee_output_on_a_real_plan() {
        let path = std::env::var("PLAN_FILE").expect("PLAN_FILE");
        let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        let plan = &v["result"];
        let owner = parse_address(plan["owner"].as_str().unwrap()).unwrap();
        let chain = hex32(plan["chain_id"].as_str().unwrap(), "chain").unwrap();
        let height = plan["candidate_height"].as_u64().unwrap();
        let parent = Header::from_hex(plan["parent_header_hex"].as_str().unwrap()).unwrap();
        let mut intent = NativeIntent::from_bytes(&hex::decode(plan["unsigned_intent_hex"].as_str().unwrap()).unwrap()).unwrap();
        let facts = intent.checked(chain, height).unwrap();
        println!("operation: {:?}", facts.pages.operation);
        println!("inputs {} outputs {} fee {}", facts.inputs.len(), facts.outputs.len(), facts.pages.fee);
        for o in &facts.outputs {
            println!("  out slot {} amount {} plain {} mine {}", o.output.slot_index, o.output.amount, o.opening.is_none(), o.output.owner == owner);
        }
        // NOID change: a plain output back to the owner.
        let change_index = facts
            .outputs
            .iter()
            .enumerate()
            .filter(|(_, o)| o.opening.is_none() && o.output.owner == owner)
            .max_by_key(|(_, o)| o.output.amount)
            .map(|(i, _)| i)
            .expect("NOID change");
        let (n_in, n_out) = (facts.inputs.len() as u64, facts.outputs.len() as u64);
        let (asc, ls) = (parent.active_slot_count, parent.log_slots);
        let new_fee = facts.pages.fee + fee_breakdown(n_in, n_out + 1, asc, ls).required_total - fee_breakdown(n_in, n_out, asc, ls).required_total;
        let cost = new_fee - facts.pages.fee + NATIVE_WALLET_FEE;
        let used: BTreeSet<u32> = facts.inputs.iter().map(|c| c.input.slot_index).chain(facts.outputs.iter().map(|c| c.output.slot_index)).collect();
        let slot = (1u32..).find(|s| !used.contains(s)).unwrap();
        let mut seen = 0usize;
        'outer: for page in intent.pages.iter_mut().skip(1) {
            for i in 0..TX_OUTPUTS {
                if page.body.output_is_live(i) {
                    if seen == change_index {
                        page.body.outputs[i].amount -= cost;
                        break 'outer;
                    }
                    seen += 1;
                }
            }
        }
        intent.pages[0].body.fee = new_fee;
        append_plain_output(&mut intent, TxOutput { slot_index: slot, amount: NATIVE_WALLET_FEE, owner: parse_address(WALLET_FEE_ADDRESS).unwrap() }).unwrap();
        intent.output_openings.push(None);
        let after = intent.checked(chain, height).expect("still valid with the fee output");
        let back = NativeIntent::from_bytes(&intent.to_bytes().unwrap()).unwrap();
        back.checked(chain, height).expect("valid after encoding");
        println!("OK: operation {:?}, outputs {} -> {}, network fee {} -> {}", after.pages.operation, n_out, after.outputs.len(), facts.pages.fee, new_fee);
    }
}
