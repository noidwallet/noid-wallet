//! Proving coins on the phone (Parano1d `getSlotProof`, upstream 757f8d8).
//!
//! The node returns a Merkle multiproof that some slots hold exactly the
//! listed coins in the State committed by one block header. The phone checks
//! it against a header it checked itself (see chain.rs), so the wallet server
//! can no longer invent coins or change their amounts.
//!
//! What it does not prove: that the server listed all of an address's coins.
//! Parano1d's docs say so too ("Completeness of an owner's discovered output
//! list is a separate wallet property").
//!
//! Ported from `noid_chain` (which brings in the node's database, kept out of
//! the phone app), unchanged between v2.1.0 (848209d) and 757f8d8:
//!
//! - `exact_state_hash.rs`: `slot_leaf_hash`, `state_node_hash`
//! - `sparse_merkle.rs`: `expected_sibling_count`, `reconstruct_root` and
//!   their index checks
//! - `fri_state.rs`: `SlotValue::with_owner_fields`
//! - `noid_rpc/examples/verify_proof.rs`: how a client checks a response
//!
//! The hashing itself is the official `noid_poseidon2b` code; the tests below
//! include upstream's golden vectors.

use std::collections::{BTreeMap, BTreeSet};

use noid_core::Block128;
use noid_poseidon2b::native::compression::{compress_with_tag, Poseidon2bSponge};
use noid_poseidon2b::native::domain::{capacity_iv, TAG_EXSTNOD, TAG_EXSTSLT};
use noid_poseidon2b::primitives::Address;
use noid_tx::types::pack_amount_creation_id;
use serde::{Deserialize, Deserializer, Serialize};

use crate::headers::Header;

pub type StateHash = [u8; 32];

/// Most slots in one proof (upstream `SLOT_PROOF_MAX_INDICES`).
pub const MAX_INDICES: usize = 128;
/// Deepest State tree a header can commit to (upstream `validate_depth`).
pub const MAX_DEPTH: u32 = 32;

/// One slot's contents as committed in the State tree.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SlotValue {
    pub value: Block128,
    pub owner_hi: Block128,
    pub owner_lo: Block128,
}

impl SlotValue {
    pub const EMPTY: Self = Self { value: Block128(0), owner_hi: Block128(0), owner_lo: Block128(0) };

    /// `fri_state::SlotValue::with_owner_fields`: amount in the low 64 bits,
    /// creation id in the high 64 bits, owner as two little-endian fields.
    pub fn with_owner_fields(amount: u64, creation_id: u64, owner: [Block128; 2]) -> Self {
        Self { value: pack_amount_creation_id(amount, creation_id), owner_hi: owner[0], owner_lo: owner[1] }
    }
}

/// `exact_state_hash::slot_leaf_hash`.
pub fn slot_leaf_hash(slot: SlotValue) -> StateHash {
    let mut s = Poseidon2bSponge::with_iv(capacity_iv(TAG_EXSTSLT));
    s.absorb(slot.value);
    s.absorb_pair(slot.owner_hi, slot.owner_lo);
    s.finalize()
}

/// `exact_state_hash::state_node_hash`.
pub fn state_node_hash(left: StateHash, right: StateHash) -> StateHash {
    compress_with_tag(TAG_EXSTNOD, &left, &right)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProofError {
    InvalidDepth,
    EmptyIndices,
    LeafCountMismatch,
    Unsorted,
    Duplicate,
    OutOfRange,
    SiblingCount { expected: usize, actual: usize },
}

fn validate_indices(indices: &[u32], depth: u32) -> Result<BTreeSet<u64>, ProofError> {
    if depth > MAX_DEPTH {
        return Err(ProofError::InvalidDepth);
    }
    if indices.is_empty() {
        return Err(ProofError::EmptyIndices);
    }
    let mut prev: Option<u32> = None;
    let mut out = BTreeSet::new();
    for &index in indices {
        if u64::from(index) >= 1u64 << depth {
            return Err(ProofError::OutOfRange);
        }
        if let Some(p) = prev {
            if index < p {
                return Err(ProofError::Unsorted);
            }
            if index == p {
                return Err(ProofError::Duplicate);
            }
        }
        prev = Some(index);
        out.insert(u64::from(index));
    }
    Ok(out)
}

/// `sparse_merkle::expected_sibling_count`.
pub fn expected_sibling_count(indices: &[u32], depth: u32) -> Result<usize, ProofError> {
    let mut known = validate_indices(indices, depth)?;
    let mut count = 0usize;
    for _ in 0..depth {
        let mut next = BTreeSet::new();
        let mut processed = BTreeSet::new();
        for &pos in &known {
            let base = pos & !1;
            if !processed.insert(base) {
                continue;
            }
            if known.contains(&base) ^ known.contains(&(base + 1)) {
                count += 1;
            }
            next.insert(base / 2);
        }
        known = next;
    }
    Ok(count)
}

/// `sparse_merkle::reconstruct_root`: siblings are consumed level by level,
/// in increasing parent position (the canonical frontier order).
pub fn reconstruct_root(indices: &[u32], leaves: &[StateHash], siblings: &[StateHash], depth: u32) -> Result<StateHash, ProofError> {
    if indices.len() != leaves.len() {
        return Err(ProofError::LeafCountMismatch);
    }
    let expected = expected_sibling_count(indices, depth)?;
    if siblings.len() != expected {
        return Err(ProofError::SiblingCount { expected, actual: siblings.len() });
    }
    let mut known: BTreeMap<u64, StateHash> = indices.iter().map(|&i| u64::from(i)).zip(leaves.iter().copied()).collect();
    let mut cursor = 0usize;
    for _ in 0..depth {
        let mut next = BTreeMap::new();
        let mut processed = BTreeSet::new();
        for &pos in known.keys() {
            let base = pos & !1;
            if !processed.insert(base) {
                continue;
            }
            let parent = match (known.get(&base).copied(), known.get(&(base + 1)).copied()) {
                (Some(l), Some(r)) => state_node_hash(l, r),
                (Some(l), None) => {
                    let r = siblings[cursor];
                    cursor += 1;
                    state_node_hash(l, r)
                }
                (None, Some(r)) => {
                    let l = siblings[cursor];
                    cursor += 1;
                    state_node_hash(l, r)
                }
                (None, None) => unreachable!("a processed parent has a known child"),
            };
            next.insert(base / 2, parent);
        }
        known = next;
    }
    match known.into_iter().next() {
        Some((0, root)) => Ok(root),
        _ => Err(ProofError::InvalidDepth),
    }
}

/// A 64-bit integer from the node's JSON, as a number or (to stay exact in
/// JavaScript) a decimal string.
fn u64_lossless<'de, D: Deserializer<'de>>(d: D) -> Result<u64, D::Error> {
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum N {
        Num(u64),
        Str(String),
    }
    match N::deserialize(d)? {
        N::Num(n) => Ok(n),
        N::Str(s) if !s.is_empty() && s.len() <= 20 && s.bytes().all(|b| b.is_ascii_digit()) => {
            s.parse().map_err(serde::de::Error::custom)
        }
        N::Str(_) => Err(serde::de::Error::custom("expected a whole number")),
    }
}

/// One slot in a `getSlotProof` response (upstream `SlotInfo`).
#[derive(Debug, Clone, Deserialize)]
pub struct ProofSlot {
    pub slot_index: u32,
    #[serde(deserialize_with = "u64_lossless")]
    pub value: u64,
    #[serde(deserialize_with = "u64_lossless")]
    pub creation_id: u64,
    pub owner: String,
    pub empty: bool,
}

/// A `getSlotProof` response (upstream `SlotProofInfo`).
#[derive(Debug, Clone, Deserialize)]
pub struct SlotProof {
    #[serde(deserialize_with = "u64_lossless")]
    pub height: u64,
    pub block_hash: String,
    pub state_root: String,
    pub log_slots: u32,
    pub slots: Vec<ProofSlot>,
    pub siblings: Vec<String>,
}

/// A slot the proof showed, as the phone can rely on it.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProvenSlot {
    pub slot_index: u32,
    pub value: u64,
    /// Decimal string: creation ids pass 2^53.
    pub creation_id: String,
    pub owner: String,
    pub empty: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VerifyError {
    /// The proof is for a different block than the phone has at that height.
    OtherBlock,
    /// The proof's State root or depth is not the header's.
    OtherState,
    /// The slots are not exactly the ones asked for.
    OtherSlots,
    /// A slot's fields can't be read, or an empty slot isn't all zero.
    BadSlot(String),
    /// A sibling isn't a 32-byte digest.
    BadSibling,
    /// The proof's shape is wrong (indices, sibling count, depth).
    Shape(ProofError),
    /// Everything parses but the hashes don't lead to the header's root.
    RootMismatch,
}

fn digest(s: &str) -> Option<StateHash> {
    if s.len() != 64 {
        return None;
    }
    hex::decode(s).ok()?.try_into().ok()
}

/// Checks `proof` against `header` (whose id is `header_id`), a header the
/// phone checked itself, for exactly the slots `wanted` (sorted, unique).
/// Mirrors upstream's `verify_proof` example step by step.
pub fn verify(proof: &SlotProof, header: &Header, header_id: &[u8; 32], wanted: &[u32]) -> Result<Vec<ProvenSlot>, VerifyError> {
    if proof.height != header.height || digest(&proof.block_hash).as_ref() != Some(header_id) {
        return Err(VerifyError::OtherBlock);
    }
    if proof.log_slots != header.log_slots || digest(&proof.state_root) != Some(header.state_root) {
        return Err(VerifyError::OtherState);
    }
    if wanted.is_empty() || wanted.len() > MAX_INDICES || proof.slots.len() != wanted.len() {
        return Err(VerifyError::OtherSlots);
    }
    if proof.slots.iter().map(|s| s.slot_index).ne(wanted.iter().copied()) {
        return Err(VerifyError::OtherSlots);
    }
    let mut leaves = Vec::with_capacity(proof.slots.len());
    for slot in &proof.slots {
        let owner = if slot.empty {
            if slot.value != 0 || slot.creation_id != 0 || !slot.owner.is_empty() {
                return Err(VerifyError::BadSlot("an empty slot has fields set".into()));
            }
            [Block128(0), Block128(0)]
        } else {
            Address::parse(&slot.owner)
                .map_err(|_| VerifyError::BadSlot(format!("slot {} owner is not an address", slot.slot_index)))?
                .as_fields()
        };
        let value = SlotValue::with_owner_fields(slot.value, slot.creation_id, owner);
        if (value == SlotValue::EMPTY) != slot.empty {
            return Err(VerifyError::BadSlot(format!("slot {} empty flag doesn't match its fields", slot.slot_index)));
        }
        leaves.push(slot_leaf_hash(value));
    }
    let siblings = proof.siblings.iter().map(|s| digest(s).ok_or(VerifyError::BadSibling)).collect::<Result<Vec<_>, _>>()?;
    let root = reconstruct_root(wanted, &leaves, &siblings, proof.log_slots).map_err(VerifyError::Shape)?;
    if root != header.state_root {
        return Err(VerifyError::RootMismatch);
    }
    Ok(proof
        .slots
        .iter()
        .map(|s| ProvenSlot {
            slot_index: s.slot_index,
            value: s.value,
            creation_id: s.creation_id.to_string(),
            owner: s.owner.clone(),
            empty: s.empty,
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn leaf(seed: u64) -> StateHash {
        slot_leaf_hash(SlotValue { value: Block128::from(seed), owner_hi: Block128::from(seed * 17), owner_lo: Block128::from(seed * 31) })
    }

    /// A full tree of `2^depth` leaves, built the plain way: root and every node.
    fn full_tree(leaves: &[StateHash]) -> Vec<Vec<StateHash>> {
        let mut levels = vec![leaves.to_vec()];
        while levels.last().unwrap().len() > 1 {
            let prev = levels.last().unwrap();
            levels.push(prev.chunks(2).map(|p| state_node_hash(p[0], p[1])).collect());
        }
        levels
    }

    /// Canonical siblings for `indices`: level-major, increasing parent position.
    fn siblings_for(levels: &[Vec<StateHash>], indices: &[u32]) -> Vec<StateHash> {
        let mut known: BTreeSet<u64> = indices.iter().map(|&i| u64::from(i)).collect();
        let mut out = Vec::new();
        for level in levels.iter().take(levels.len() - 1) {
            let mut next = BTreeSet::new();
            let mut done = BTreeSet::new();
            for &pos in &known {
                let base = pos & !1;
                if !done.insert(base) {
                    continue;
                }
                match (known.contains(&base), known.contains(&(base + 1))) {
                    (true, false) => out.push(level[(base + 1) as usize]),
                    (false, true) => out.push(level[base as usize]),
                    _ => {}
                }
                next.insert(base / 2);
            }
            known = next;
        }
        out
    }

    #[test]
    fn upstream_zero_root_golden_vectors() {
        // exact_state_hash.rs `zero_root_golden_vectors_are_stable` (depths 0, 1, 4).
        let mut z = slot_leaf_hash(SlotValue::EMPTY);
        let z0 = [129, 102, 210, 70, 24, 117, 164, 73, 150, 82, 163, 157, 56, 215, 196, 144, 152, 52, 131, 97, 217, 58, 221, 252, 173, 30, 138, 210, 158, 138, 112, 66];
        assert_eq!(z, z0);
        z = state_node_hash(z, z);
        let z1 = [6, 197, 99, 94, 29, 133, 197, 229, 174, 5, 238, 221, 187, 30, 247, 147, 65, 157, 47, 74, 14, 197, 144, 45, 189, 81, 132, 99, 44, 230, 81, 177];
        assert_eq!(z, z1);
        for _ in 1..4 {
            z = state_node_hash(z, z);
        }
        let z4 = [170, 248, 23, 183, 124, 240, 4, 165, 25, 234, 105, 246, 1, 26, 145, 66, 37, 100, 219, 76, 136, 251, 74, 103, 231, 72, 51, 39, 246, 32, 50, 67];
        assert_eq!(z, z4);
    }

    #[test]
    fn packing_matches_upstream() {
        let s = SlotValue::with_owner_fields(42, 7, [Block128::from(1u64), Block128::from(2u64)]);
        assert_eq!(s.value, Block128::from((7u128 << 64) | 42));
        // The full packed lane is hashed: a new creation id is a new leaf.
        assert_ne!(slot_leaf_hash(s), slot_leaf_hash(SlotValue::with_owner_fields(42, 8, [Block128::from(1u64), Block128::from(2u64)])));
    }

    #[test]
    fn multiproofs_rebuild_the_root_and_any_change_breaks_them() {
        let depth = 5u32;
        let leaves: Vec<StateHash> = (0..32).map(|i| leaf(i + 1)).collect();
        let levels = full_tree(&leaves);
        let root = levels.last().unwrap()[0];
        for indices in [vec![0u32], vec![31], vec![2, 3, 9], vec![0, 1, 2, 3], vec![5, 17, 18, 30]] {
            let picked: Vec<_> = indices.iter().map(|&i| leaves[i as usize]).collect();
            let sibs = siblings_for(&levels, &indices);
            assert_eq!(expected_sibling_count(&indices, depth).unwrap(), sibs.len());
            assert_eq!(reconstruct_root(&indices, &picked, &sibs, depth).unwrap(), root, "{indices:?}");
            // A changed leaf or sibling gives another root.
            let mut bad = picked.clone();
            bad[0][0] ^= 1;
            assert_ne!(reconstruct_root(&indices, &bad, &sibs, depth).unwrap(), root);
            if !sibs.is_empty() {
                let mut bad = sibs.clone();
                bad[0][31] ^= 1;
                assert_ne!(reconstruct_root(&indices, &picked, &bad, depth).unwrap(), root);
            }
        }
        // Shape errors, before any hashing.
        assert_eq!(reconstruct_root(&[3, 2], &[leaves[3], leaves[2]], &[], depth), Err(ProofError::Unsorted));
        assert_eq!(reconstruct_root(&[2, 2], &[leaves[2], leaves[2]], &[], depth), Err(ProofError::Duplicate));
        assert_eq!(reconstruct_root(&[32], &[leaves[0]], &[], depth), Err(ProofError::OutOfRange));
        assert_eq!(reconstruct_root(&[], &[], &[], depth), Err(ProofError::EmptyIndices));
        assert_eq!(reconstruct_root(&[1], &[leaves[1]], &[], 33), Err(ProofError::InvalidDepth));
        assert!(matches!(reconstruct_root(&[1], &[leaves[1]], &[], depth), Err(ProofError::SiblingCount { expected: 5, actual: 0 })));
    }

    /// (slot index, value, creation id, owner, empty)
    type Slot = (u32, u64, u64, String, bool);

    fn json_proof(header: &Header, id: &[u8; 32], slots: &[Slot], siblings: &[StateHash]) -> SlotProof {
        let v = serde_json::json!({
            "height": header.height,
            "block_hash": hex::encode(id),
            "state_root": hex::encode(header.state_root),
            "log_slots": header.log_slots,
            // creation ids as strings, as the wallet server forwards them
            "slots": slots.iter().map(|(i, v, c, o, e)| serde_json::json!({
                "slot_index": i, "value": v, "creation_id": c.to_string(), "owner": o, "empty": e
            })).collect::<Vec<_>>(),
            "siblings": siblings.iter().map(hex::encode).collect::<Vec<_>>(),
        });
        serde_json::from_value(v).unwrap()
    }

    #[test]
    fn verify_binds_slots_to_the_phones_own_header() {
        // A small State: slot 2 holds a coin, slot 3 is empty, others filler.
        let owner = "o1wrznmh6td3mgg9mu0a3kkxxn2lnfu827uykrnpaa90mex8su9zcs5sjxrk".to_string();
        let fields = Address::parse(&owner).unwrap().as_fields();
        let big_id = (1u64 << 62) | 5; // native-style creation id, past 2^53
        let coin = SlotValue::with_owner_fields(1_250_000, big_id, fields);
        let depth = 4u32;
        let mut leaves: Vec<StateHash> = (0..16).map(|i| leaf(100 + i)).collect();
        leaves[2] = slot_leaf_hash(coin);
        leaves[3] = slot_leaf_hash(SlotValue::EMPTY);
        let levels = full_tree(&leaves);
        let mut header = crate::chain::checkpoint().headers[0];
        header.state_root = levels.last().unwrap()[0];
        header.log_slots = depth;
        let id = [7u8; 32];
        let wanted = [2u32, 3];
        let sibs = siblings_for(&levels, &wanted);
        let slots = vec![(2, 1_250_000, big_id, owner.clone(), false), (3, 0, 0, String::new(), true)];
        let proof = json_proof(&header, &id, &slots, &sibs);
        let proven = verify(&proof, &header, &id, &wanted).unwrap();
        assert_eq!(proven[0].creation_id, big_id.to_string(), "exact past 2^53");
        assert_eq!(proven[0].value, 1_250_000);
        assert!(proven[1].empty);

        // Each lie is caught: amount, creation id, owner, empty flag, block, root, depth, slots asked.
        let other = "o1s32s5m9ughjv2ktvxm8m7y0gmu0swys5t0ufkdnyhv02nudc23cqg7y34s".to_string();
        let lies: Vec<(Vec<Slot>, VerifyError)> = vec![
            (vec![(2, 9_999_999, big_id, owner.clone(), false), slots[1].clone()], VerifyError::RootMismatch),
            (vec![(2, 1_250_000, big_id + 1, owner.clone(), false), slots[1].clone()], VerifyError::RootMismatch),
            (vec![(2, 1_250_000, big_id, other, false), slots[1].clone()], VerifyError::RootMismatch),
            (vec![slots[0].clone(), (3, 5, 0, String::new(), true)], VerifyError::BadSlot("an empty slot has fields set".into())),
        ];
        for (s, err) in lies {
            assert_eq!(verify(&json_proof(&header, &id, &s, &sibs), &header, &id, &wanted), Err(err));
        }
        assert_eq!(verify(&proof, &header, &[8u8; 32], &wanted), Err(VerifyError::OtherBlock));
        let mut h2 = header;
        h2.state_root[0] ^= 1;
        assert_eq!(verify(&proof, &h2, &id, &wanted), Err(VerifyError::OtherState));
        assert_eq!(verify(&proof, &header, &id, &[2]), Err(VerifyError::OtherSlots));
        assert_eq!(verify(&proof, &header, &id, &[2, 4]), Err(VerifyError::OtherSlots));
        let mut bad_sib = proof.clone();
        bad_sib.siblings[0] = "zz".repeat(32);
        assert_eq!(verify(&bad_sib, &header, &id, &wanted), Err(VerifyError::BadSibling));
        let mut short = proof.clone();
        short.siblings.pop();
        assert!(matches!(verify(&short, &header, &id, &wanted), Err(VerifyError::Shape(ProofError::SiblingCount { .. }))));
        // A live slot claimed empty (all-zero fields but empty=false) is refused.
        let mut zero_live = proof.clone();
        zero_live.slots[1].empty = false;
        assert!(matches!(verify(&zero_live, &header, &id, &wanted), Err(VerifyError::BadSlot(_))));
    }

    #[test]
    fn numbers_stay_exact_and_junk_is_refused() {
        let ok: ProofSlot = serde_json::from_str(r#"{"slot_index":1,"value":"18446744073709551615","creation_id":4611686018427387909,"owner":"","empty":true}"#).unwrap();
        assert_eq!((ok.value, ok.creation_id), (u64::MAX, 4611686018427387909));
        for bad in [r#""-1""#, r#""1.5""#, r#""""#, r#""18446744073709551616""#, r#""0x10""#] {
            let s = format!(r#"{{"slot_index":1,"value":{bad},"creation_id":0,"owner":"","empty":true}}"#);
            assert!(serde_json::from_str::<ProofSlot>(&s).is_err(), "{bad}");
        }
    }
}
