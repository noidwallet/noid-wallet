//! The phone's slot-proof check (core/src/slot_proof.rs) against the official
//! noid_chain code at the pinned release: same leaf hashes, same sibling
//! counts, same roots, and proofs built by the node's own multiproof builder
//! verify on the phone. Run with `cargo test --release`.

use noid_chain::exact_state_hash::slot_leaf_hash as up_leaf;
use noid_chain::fri_state::SlotValue as UpSlot;
use noid_chain::sparse_merkle::{self as up, SparseMerkleCache};
use noid_mobile_core::slot_proof::{self as phone, SlotValue};
use noid_poseidon2b::primitives::Address;
use rand::{rngs::StdRng, Rng, SeedableRng};

const OWNERS: [&str; 2] = [
    "o1wrznmh6td3mgg9mu0a3kkxxn2lnfu827uykrnpaa90mex8su9zcs5sjxrk",
    "o1s32s5m9ughjv2ktvxm8m7y0gmu0swys5t0ufkdnyhv02nudc23cqg7y34s",
];

#[test]
fn leaves_sibling_counts_and_roots_match_noid_chain() {
    let mut rng = StdRng::seed_from_u64(0x5107_9800f);
    for round in 0..200 {
        let depth: u32 = [3, 8, 16, 24][round % 4];
        // A sparse State: some live slots, the rest empty.
        let live: usize = rng.gen_range(1..40);
        let mut slots: Vec<(u32, u64, u64, usize)> = (0..live)
            .map(|_| (rng.gen_range(0..(1u64 << depth)) as u32, rng.gen(), rng.gen(), rng.gen_range(0..2)))
            .collect();
        slots.sort_by_key(|s| s.0);
        slots.dedup_by_key(|s| s.0);
        let mut leaves = Vec::new();
        for &(i, amount, cid, o) in &slots {
            let fields = Address::parse(OWNERS[o]).unwrap().as_fields();
            let ours = phone::slot_leaf_hash(SlotValue::with_owner_fields(amount, cid, fields));
            let theirs = up_leaf(UpSlot::with_owner_fields(amount, cid, fields));
            assert_eq!(ours, theirs, "leaf hash");
            leaves.push((i, theirs));
        }
        let cache = SparseMerkleCache::from_leaves(depth, &leaves).unwrap();
        // Ask for a mix of live slots and empty ones.
        let mut wanted: Vec<u32> = slots.iter().filter(|_| rng.gen_bool(0.5)).map(|s| s.0).collect();
        for _ in 0..rng.gen_range(0..6) {
            wanted.push(rng.gen_range(0..(1u64 << depth)) as u32);
        }
        if wanted.is_empty() {
            wanted.push(slots[0].0);
        }
        wanted.sort_unstable();
        wanted.dedup();
        wanted.truncate(phone::MAX_INDICES);
        let wanted_leaves: Vec<[u8; 32]> = wanted.iter().map(|&i| cache.node_hash(0, u64::from(i))).collect();
        let proof = up::build_multiproof(&cache, &wanted, depth).unwrap();
        assert_eq!(phone::expected_sibling_count(&wanted, depth).unwrap(), up::expected_sibling_count(&wanted, depth).unwrap());
        let ours = phone::reconstruct_root(&wanted, &wanted_leaves, &proof.siblings, depth).unwrap();
        let theirs = up::reconstruct_root(&wanted, &wanted_leaves, &proof.siblings, depth).unwrap();
        assert_eq!(ours, theirs, "round {round}");
        assert_eq!(ours, cache.root(), "round {round}");
    }
}

#[test]
fn a_node_built_proof_verifies_on_the_phone_and_a_changed_one_does_not() {
    let depth = 24u32; // mainnet's log_slots
    let fields = Address::parse(OWNERS[0]).unwrap().as_fields();
    let coins = [(70_001u32, 1_250_000u64, (1u64 << 62) | 9), (70_004, 33, 812_345)];
    let leaves: Vec<(u32, [u8; 32])> = coins.iter().map(|&(i, a, c)| (i, up_leaf(UpSlot::with_owner_fields(a, c, fields)))).collect();
    let cache = SparseMerkleCache::from_leaves(depth, &leaves).unwrap();
    let wanted = [70_001u32, 70_003, 70_004]; // 70_003 is empty
    let proof = up::build_multiproof(&cache, &wanted, depth).unwrap();

    let mut header = noid_mobile_core::chain::checkpoint().headers[0];
    header.state_root = cache.root();
    header.log_slots = depth;
    let id = [9u8; 32];
    let slot = |i: u32, v: u64, c: u64, empty: bool| {
        serde_json::json!({"slot_index": i, "value": v, "creation_id": c.to_string(), "owner": if empty { "" } else { OWNERS[0] }, "empty": empty})
    };
    let json = serde_json::json!({
        "height": header.height, "block_hash": hex::encode(id), "state_root": hex::encode(cache.root()), "log_slots": depth,
        "slots": [slot(70_001, 1_250_000, (1u64 << 62) | 9, false), slot(70_003, 0, 0, true), slot(70_004, 33, 812_345, false)],
        "siblings": proof.siblings.iter().map(hex::encode).collect::<Vec<_>>(),
    });
    let p: phone::SlotProof = serde_json::from_value(json.clone()).unwrap();
    let proven = phone::verify(&p, &header, &id, &wanted).unwrap();
    assert_eq!(proven.iter().map(|s| s.value).collect::<Vec<_>>(), vec![1_250_000, 0, 33]);

    // The server claims 1,250,001 instead: refused.
    let mut lie = json;
    lie["slots"][0]["value"] = serde_json::json!(1_250_001);
    let p: phone::SlotProof = serde_json::from_value(lie).unwrap();
    assert_eq!(phone::verify(&p, &header, &id, &wanted), Err(phone::VerifyError::RootMismatch));
}
