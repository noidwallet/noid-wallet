//! Runs the phone's header rules (core/src/headers.rs) and the official
//! `noid_chain` rules (Parano1d v2.1.0, rev 848209d) on the same inputs and
//! fails on the first difference.
//!
//!   cargo run --release                   random inputs + a freshly mined test chain
//!   cargo run --release -- headers.jsonl  also real mainnet headers (see README.md)

use std::time::Instant;

use noid_chain::consensus::{
    difficulty, forks::ACTIVE_SCHEDULE, header as official_header, pow as official_pow, slot_expansion, timestamps,
    ConsensusError,
};
use noid_chain::BlockHeader as Official;
use noid_mobile_core::headers::{self as mine, Header, HeaderChain, HeaderError};
use rand::{rngs::StdRng, Rng, SeedableRng};

const V2: u64 = mine::V2_ACTIVATION_HEIGHT;

fn official(h: &Header) -> Official {
    Official::from_bytes(&h.to_bytes()).expect("212 bytes")
}

fn same_error(o: &ConsensusError, m: &HeaderError) -> bool {
    matches!(
        (o, m),
        (ConsensusError::BadParentHash, HeaderError::BadParentHash)
            | (ConsensusError::BadHeight, HeaderError::BadHeight)
            | (ConsensusError::BadDifficultyTarget, HeaderError::BadDifficultyTarget)
            | (ConsensusError::BadTimestamp, HeaderError::BadTimestamp)
            | (ConsensusError::BadTimestamp, HeaderError::TooFarInFuture)
            | (ConsensusError::InvalidPoW, HeaderError::BadPow)
            | (ConsensusError::BadLogSlotsExpansion, HeaderError::BadLogSlotsExpansion)
    )
}

fn random_target(rng: &mut StdRng) -> [u8; 32] {
    match rng.gen_range(0..8) {
        0 => mine::GENESIS_TARGET,
        1 => mine::MIN_TARGET,
        2 => mine::MAX_TARGET,
        3 => [0u8; 32],
        4 => {
            // Realistic: a few bits below the genesis floor.
            let mut t = [0u8; 32];
            let top = rng.gen_range(10..30);
            rng.fill(&mut t[..top]);
            t[top] = rng.gen_range(1..=255);
            t
        }
        _ => {
            let mut t = [0u8; 32];
            rng.fill(&mut t[..]);
            let cut = rng.gen_range(0..32);
            for b in &mut t[cut..] {
                *b = 0;
            }
            t
        }
    }
}

fn random_u64(rng: &mut StdRng) -> u64 {
    match rng.gen_range(0..6) {
        0 => 0,
        1 => u64::MAX,
        2 => rng.gen_range(0..1000),
        _ => rng.gen(),
    }
}

/// Pure functions, compared on random and edge inputs.
fn fuzz(rounds: usize) {
    let mut rng = StdRng::seed_from_u64(0x4e4f4944);
    for round in 0..rounds {
        // Wire format, block id, PoW digest.
        let mut bytes = [0u8; mine::HEADER_BYTES];
        rng.fill(&mut bytes[..]);
        let m = Header::from_bytes(&bytes).unwrap();
        let o = Official::from_bytes(&bytes).unwrap();
        assert_eq!(m.to_bytes(), o.to_bytes(), "wire round {round}");
        assert_eq!(mine::block_id(&m), noid_chain::block_id(&o), "block id round {round}");
        assert_eq!(mine::pow_digest(&m), official_pow::poseidon_pow_digest(&o), "pow digest round {round}");
        assert_eq!(mine::pow_ok(&m), official_pow::validate_pow(&o).is_ok(), "pow check round {round}");
        let cut = rng.gen_range(0..mine::HEADER_BYTES * 2);
        let mut odd = bytes.to_vec();
        odd.resize(cut, 7);
        assert_eq!(Header::from_bytes(&odd).is_some(), Official::from_bytes(&odd).is_ok(), "length {cut}");

        // ASERT target.
        let anchor_height = match rng.gen_range(0..4) {
            0 => rng.gen_range(V2 - 8..V2 + 8),
            1 => u64::MAX - rng.gen_range(1..20),
            _ => rng.gen_range(V2..400_000),
        };
        let height = anchor_height.saturating_add(rng.gen_range(1..14)).max(V2);
        let anchor_ts = random_u64(&mut rng);
        let parent_ts = match rng.gen_range(0..5) {
            0 => random_u64(&mut rng),
            // Lateness spread over about +-60 half-lives, so the shift takes
            // every value from the floor clamp down to tiny targets.
            1 | 2 => {
                let ideal = mine::ideal_elapsed(anchor_height, height - 1).min(u64::MAX as u128) as u64;
                let late: i64 = rng.gen_range(-60 * 180..60 * 180);
                let base = anchor_ts.saturating_add(ideal);
                if late >= 0 {
                    base.saturating_add(late as u64)
                } else {
                    base.saturating_sub(late.unsigned_abs())
                }
            }
            _ => anchor_ts.saturating_add(rng.gen_range(0..4000)),
        };
        let own_ts = random_u64(&mut rng);
        let target = random_target(&mut rng);
        let o_t = difficulty::next_target_with_schedule(
            anchor_height,
            anchor_ts,
            &target,
            height,
            parent_ts,
            own_ts,
            ACTIVE_SCHEDULE,
        );
        let m_t = mine::next_target(anchor_height, anchor_ts, &target, height, parent_ts).unwrap();
        assert_eq!(m_t, o_t, "next_target round {round}: a={anchor_height} h={height} ats={anchor_ts} pts={parent_ts}");
        assert_eq!(
            mine::ideal_elapsed(anchor_height, height),
            ACTIVE_SCHEDULE.ideal_elapsed(anchor_height, height),
            "ideal_elapsed round {round}"
        );

        // Anchor height.
        let h = match rng.gen_range(0..3) {
            0 => rng.gen_range(V2 - 20..V2 + 20),
            1 => random_u64(&mut rng),
            _ => rng.gen_range(0..1_000_000),
        };
        assert_eq!(mine::asert_anchor_height(h), official_header::asert_anchor_height(h), "anchor h={h}");

        // Median time past.
        let n = rng.gen_range(0..16);
        let ts: Vec<u64> = (0..n).map(|_| random_u64(&mut rng)).collect();
        assert_eq!(mine::median_time_past(&ts), timestamps::median_time_past(&ts), "mtp {ts:?}");

        // log_slots expansion.
        let parent_height = if rng.gen_bool(0.3) { rng.gen_range(0..60) } else { random_u64(&mut rng) };
        let log_slots = rng.gen_range(0..70);
        let len = rng.gen_range(16..21);
        let threshold = (1u64.checked_shl(log_slots).unwrap_or(u64::MAX) / 4).saturating_mul(3);
        let counts: Vec<u64> = (0..len)
            .map(|_| match rng.gen_range(0..4) {
                0 => threshold,
                1 => threshold.saturating_sub(1),
                2 => random_u64(&mut rng),
                _ => threshold.saturating_add(rng.gen_range(0..3)),
            })
            .collect();
        assert_eq!(
            mine::expected_child_log_slots(parent_height, log_slots, &counts),
            slot_expansion::expected_child_log_slots(parent_height, log_slots, &counts),
            "log_slots p={parent_height} l={log_slots} {counts:?}"
        );

        // Block work.
        let t = random_target(&mut rng);
        assert_eq!(mine::block_work(&t), difficulty::block_work(&t), "work {t:?}");
        let w = random_target(&mut rng);
        assert_eq!(mine::add_work(&t, &w), difficulty::add_work(&t, &w), "add_work");
    }
    println!("random inputs: {rounds} rounds, all equal");
}

/// The inputs the node would pass for the child of `all.last()`, taken
/// straight from heights (independent of HeaderChain's own window).
struct Inputs {
    prev_ts: Vec<u64>,
    counts: Vec<u64>,
    anchor_height: u64,
    anchor_ts: u64,
    anchor_target: [u8; 32],
}

fn inputs_for_child(all: &[Header]) -> Inputs {
    let parent = all.last().unwrap();
    let by_height = |h: u64| all.iter().find(|x| x.height == h).copied().expect("ancestor present");
    let n = all.len().min(mine::MEDIAN_TIME_BLOCKS);
    let prev_ts = all[all.len() - n..].iter().map(|h| h.timestamp).collect();
    let counts = match slot_expansion::finalized_expansion_window(parent.height) {
        None => Vec::new(),
        Some((s, e)) => (s..=e).map(|h| by_height(h).active_slot_count).collect(),
    };
    let anchor_height = official_header::asert_anchor_height(parent.height);
    let anchor = by_height(anchor_height);
    Inputs { prev_ts, counts, anchor_height, anchor_ts: anchor.timestamp, anchor_target: anchor.difficulty_target }
}

fn official_check(child: &Header, all: &[Header]) -> Result<(), ConsensusError> {
    let i = inputs_for_child(all);
    official_header::validate_header_timeless(
        &official(child),
        &official(all.last().unwrap()),
        &i.prev_ts,
        &i.counts,
        i.anchor_height,
        i.anchor_ts,
        &i.anchor_target,
    )
}

/// Wrong versions of a valid child: each must be refused by both, for the same reason.
fn mutations(child: &Header, all: &[Header], chain: &HeaderChain) -> usize {
    let parent = all.last().unwrap();
    let mut variants: Vec<(&str, Header)> = Vec::new();
    let mut v = *child;
    v.nonce ^= 1;
    variants.push(("nonce", v));
    let mut v = *child;
    v.prev_block_hash[5] ^= 0x80;
    variants.push(("parent link", v));
    let mut v = *child;
    v.height += 1;
    variants.push(("height", v));
    let mut v = *child;
    v.difficulty_target[3] ^= 1;
    variants.push(("target", v));
    let mut v = *child;
    v.timestamp = mine::median_time_past(&inputs_for_child(all).prev_ts);
    variants.push(("timestamp at median", v));
    let mut v = *child;
    v.log_slots += 1;
    variants.push(("log_slots", v));
    let mut v = *child;
    v.state_root[0] ^= 1;
    variants.push(("state root", v));
    let _ = parent;
    for (what, bad) in &variants {
        let o = official_check(bad, all);
        let mut c = chain.clone();
        let m = c.extend(bad, None);
        match (&o, &m) {
            (Err(oe), Err(me)) if same_error(oe, me) => {}
            _ => panic!("mutation '{what}' at h={}: official {o:?}, phone {m:?}", child.height),
        }
        assert_eq!(c.tip_id(), chain.tip_id(), "a refused header must not move the tip");
    }
    variants.len()
}

/// Mine a short chain at v2 heights with real Poseidon2b PoW and check every
/// header with both implementations. `counts(i)` is the active slot count of
/// the i-th header (0 = first trusted one), which drives log_slots.
fn mined_chain(label: &str, start: u64, extensions: usize, counts: fn(u64) -> u64, first_log_slots: u32) {
    let mut all: Vec<Header> = Vec::new();
    let mut prev = [0u8; 32];
    for i in 0..mine::WINDOW_LEN as u64 {
        let h = Header {
            prev_block_hash: prev,
            state_root: [i as u8; 32],
            tx_root: [0xAA; 32],
            timestamp: 1_792_000_000 + i * 45,
            height: start + i,
            miner_address: [0x55; 32],
            nonce: i as u128,
            difficulty_target: mine::GENESIS_TARGET,
            log_slots: 20,
            active_slot_count: counts(i),
            alloc_counter: 1_000 + i,
        };
        prev = mine::block_id(&h);
        all.push(h);
    }
    let mut chain = HeaderChain::from_trusted(&all, &prev).unwrap();
    let mut rng = StdRng::seed_from_u64(7 ^ start);
    let mut refused = 0;
    let t0 = Instant::now();
    let mut check_time = std::time::Duration::ZERO;
    for k in 0..extensions {
        let parent = *all.last().unwrap();
        let i = inputs_for_child(&all);
        // Sometimes fast, sometimes slow, so the target moves both ways.
        let gap = if k % 3 == 0 { rng.gen_range(1..10) } else { rng.gen_range(25..120) };
        let mut child = Header {
            prev_block_hash: mine::block_id(&parent),
            state_root: [rng.gen(); 32],
            tx_root: [rng.gen(); 32],
            timestamp: parent.timestamp + gap,
            height: parent.height + 1,
            miner_address: [0x66; 32],
            nonce: 0,
            difficulty_target: mine::next_target(i.anchor_height, i.anchor_ts, &i.anchor_target, parent.height + 1, parent.timestamp)
                .unwrap(),
            log_slots: mine::expected_child_log_slots(parent.height, parent.log_slots, &i.counts),
            active_slot_count: counts(mine::WINDOW_LEN as u64 + k as u64),
            alloc_counter: parent.alloc_counter + 1,
        };
        let mine_nonce = |h: &Header, rng: &mut StdRng| {
            official_pow::search_pow(&official(h), rng.gen::<u64>() as u128, 1 << 26).expect("nonce found")
        };
        child.nonce = mine_nonce(&child, &mut rng);
        official_check(&child, &all).unwrap_or_else(|e| panic!("official refused mined h={}: {e:?}", child.height));
        refused += mutations(&child, &all, &chain);

        // Wrong log_slots with valid PoW, so the check really reaches rule 6.
        if k % 4 == 0 {
            let mut bad = child;
            bad.log_slots = child.log_slots ^ 1;
            bad.nonce = mine_nonce(&bad, &mut rng);
            let o = official_check(&bad, &all);
            let m = chain.clone().extend(&bad, None);
            assert!(
                matches!(o, Err(ConsensusError::BadLogSlotsExpansion)) && m == Err(HeaderError::BadLogSlotsExpansion),
                "re-mined log_slots h={}: official {o:?}, phone {m:?}",
                child.height
            );
            refused += 1;
        }

        // The phone's clock: 120 s of drift is allowed, 121 s is not.
        let p = inputs_for_child(&all);
        for (now, ok) in [(child.timestamp - 120, true), (child.timestamp - 121, false)] {
            let o = official_header::validate_header(
                &official(&child),
                &official(&parent),
                &p.prev_ts,
                &p.counts,
                now,
                p.anchor_height,
                p.anchor_ts,
                &p.anchor_target,
            );
            let m = chain.clone().extend(&child, Some(now));
            assert_eq!(o.is_ok(), ok, "official drift now={now}");
            assert_eq!(m.is_ok(), ok, "phone drift now={now}: {m:?}");
            if !ok {
                assert_eq!(m, Err(HeaderError::TooFarInFuture));
                refused += 1;
            }
        }

        let c0 = Instant::now();
        chain.extend(&child, Some(child.timestamp)).unwrap_or_else(|e| panic!("phone refused mined h={}: {e:?}", child.height));
        check_time += c0.elapsed();
        if k == 0 {
            assert_eq!(child.log_slots, first_log_slots, "first child log_slots");
            assert!(child.height >= V2);
        }
        all.push(child);
        assert_eq!(chain.tip_id(), mine::block_id(&child));
    }
    let tip = all.last().unwrap();
    println!(
        "mined chain ({label}): {extensions} headers accepted by both (h={}..{}, log_slots 20 -> {}), {refused} wrong variants refused by both for the same reason ({:.1?} total, {:.0?} per header check)",
        start + mine::WINDOW_LEN as u64,
        tip.height,
        tip.log_slots,
        t0.elapsed(),
        check_time / extensions as u32
    );
}

/// Real headers: one per line, either bare hex or a JSON-RPC reply whose
/// "result" is the hex (paranoid_getHeaderByHeight).
fn real_headers(path: &str) {
    let text = std::fs::read_to_string(path).expect("read headers file");
    let mut headers: Vec<Header> = Vec::new();
    for (n, line) in text.lines().enumerate() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let hex_str = if line.starts_with('{') {
            let v: serde_json::Value = serde_json::from_str(line).unwrap_or_else(|e| panic!("line {}: {e}", n + 1));
            match v.get("result").and_then(|r| r.as_str()) {
                Some(s) => s.to_string(),
                None => panic!("line {}: no result: {line}", n + 1),
            }
        } else {
            line.to_string()
        };
        let h = Header::from_hex(&hex_str).unwrap_or_else(|| panic!("line {}: not a 212-byte header", n + 1));
        assert!(Official::from_bytes(&hex::decode(&hex_str).unwrap()).is_ok());
        headers.push(h);
    }
    headers.sort_by_key(|h| h.height);
    headers.dedup_by_key(|h| h.height);
    // Split into contiguous runs (the file may hold more than one range).
    let mut runs: Vec<Vec<Header>> = Vec::new();
    for h in headers {
        match runs.last_mut() {
            Some(r) if r.last().unwrap().height + 1 == h.height => r.push(h),
            _ => runs.push(vec![h]),
        }
    }
    for run in runs {
        // The first checked header must be a v2 block; the trusted window
        // before it may reach back into v1.1.
        let skip = (V2 - mine::WINDOW_LEN as u64).saturating_sub(run[0].height) as usize;
        let run = &run[skip.min(run.len())..];
        if run.len() <= mine::WINDOW_LEN {
            println!("real headers: a run is too short to check, skipped");
            continue;
        }
        let (first, last) = (run[0].height, run.last().unwrap().height);
        let (trusted, rest) = run.split_at(mine::WINDOW_LEN);
        let mut chain = HeaderChain::from_trusted(trusted, &mine::block_id(trusted.last().unwrap())).expect("trusted run links");
        let mut all = trusted.to_vec();
        let mut refused = 0;
        let t0 = Instant::now();
        for h in rest {
            official_check(h, &all).unwrap_or_else(|e| panic!("official refused real h={}: {e:?}", h.height));
            chain.extend(h, None).unwrap_or_else(|e| panic!("phone refused real h={}: {e:?}", h.height));
            refused += mutations(h, &all, &chain_before(&all));
            all.push(*h);
        }
        let work = chain.added_work();
        let tgt = rest.last().unwrap().difficulty_target;
        println!(
            "real headers {first}..{last} (first {} trusted): {} checked, all accepted by both, {refused} wrong variants refused by both ({:.1?}); latest target has {} leading zero bits (genesis floor: 17), work added {}",
            mine::WINDOW_LEN,
            rest.len(),
            t0.elapsed(),
            difficulty::target_leading_zero_bits(&tgt),
            hex::encode(work.iter().rev().copied().collect::<Vec<u8>>()).trim_start_matches('0')
        );
    }
}

fn chain_before(all: &[Header]) -> HeaderChain {
    let w = &all[all.len() - mine::WINDOW_LEN..];
    HeaderChain::from_trusted(w, &mine::block_id(w.last().unwrap())).unwrap()
}

/// A miner for the tracker scenarios: valid children of `all`, with real PoW.
struct Miner {
    rng: StdRng,
}

impl Miner {
    fn child(&mut self, all: &[Header], gap: u64, salt: u8) -> Header {
        let parent = *all.last().unwrap();
        let i = inputs_for_child(all);
        let mut child = Header {
            prev_block_hash: mine::block_id(&parent),
            state_root: [salt; 32],
            tx_root: [self.rng.gen(); 32],
            timestamp: parent.timestamp + gap,
            height: parent.height + 1,
            miner_address: [0x77; 32],
            nonce: 0,
            difficulty_target: mine::next_target(i.anchor_height, i.anchor_ts, &i.anchor_target, parent.height + 1, parent.timestamp)
                .unwrap(),
            log_slots: mine::expected_child_log_slots(parent.height, parent.log_slots, &i.counts),
            active_slot_count: 100_000,
            alloc_counter: parent.alloc_counter + 1,
        };
        child.nonce = official_pow::search_pow(&official(&child), self.rng.gen::<u64>() as u128, 1 << 26).expect("nonce found");
        official_check(&child, all).unwrap_or_else(|e| panic!("official refused mined h={}: {e:?}", child.height));
        child
    }

    fn run(&mut self, all: &mut Vec<Header>, n: usize, gap: u64, salt: u8) -> Vec<Header> {
        let mut out = Vec::new();
        for _ in 0..n {
            let c = self.child(all, gap, salt);
            all.push(c);
            out.push(c);
        }
        out
    }
}

/// The chain tracker (core/src/chain.rs): continuation, forks, the work
/// floor and the stored state, on a mined chain from a test checkpoint.
fn tracker_scenarios() {
    use noid_mobile_core::chain::{Checkpoint, Tracker};
    let t0 = Instant::now();
    let start = 270_000u64;
    let mut all: Vec<Header> = Vec::new();
    let mut prev = [0u8; 32];
    for i in 0..mine::WINDOW_LEN as u64 {
        let h = Header {
            prev_block_hash: prev,
            state_root: [1; 32],
            tx_root: [2; 32],
            timestamp: 1_792_000_000 + i * 30,
            height: start + i,
            miner_address: [0x55; 32],
            nonce: i as u128,
            difficulty_target: mine::GENESIS_TARGET,
            log_slots: 20,
            active_slot_count: 100_000,
            alloc_counter: 1_000 + i,
        };
        prev = mine::block_id(&h);
        all.push(h);
    }
    // The checkpoint "network rate": one genesis-floor block (2^18) per 30 s.
    let rate: u128 = (1u128 << 18) / 30;
    let cp = Checkpoint::from_headers(&all).unwrap();
    let mut tracker = Tracker::with_checkpoint(&cp, rate);
    let mut miner = Miner { rng: StdRng::seed_from_u64(99) };
    let now = || 1_800_000_000u64;

    // 1. Continuation in two batches, with an overlap the tracker must skip.
    let a = miner.run(&mut all, 25, 30, 10);
    let r = tracker.sync(&a[..10], now());
    assert_eq!((r.accepted, r.refused.clone(), r.reorg_depth), (10, None, 0));
    let r = tracker.sync(&a[7..], now());
    assert_eq!((r.accepted, r.refused.clone(), r.reorg_depth), (15, None, 0));
    assert_eq!(tracker.tip().height, start + 35 + 25);
    assert_eq!(tracker.id_at(start + 40), Some(mine::block_id(&all[40])));

    // 2. The stored state round-trips, keeps ids, and refuses tampering.
    let state = tracker.state();
    assert_eq!(state.headers.len(), noid_mobile_core::chain::RETAIN);
    let mut tampered = state.clone();
    tampered.ids.insert(tracker.tip().height, "ab".repeat(32));
    assert!(Tracker::load_with(&tampered, &cp, rate).is_err());
    assert_eq!(Tracker::load_with(&state, &cp, rate).unwrap().tip_id(), tracker.tip_id());

    // 3. A fork 5 blocks back with more work (6 blocks, same difficulty) replaces the tip.
    let tip_before = tracker.tip().height;
    let fork_base: Vec<Header> = all[..all.len() - 5].to_vec();
    let mut branch_all = fork_base.clone();
    let branch = miner.run(&mut branch_all, 6, 30, 20);
    let r = tracker.sync(&branch, now());
    assert_eq!(r.refused, None, "{r:?}");
    assert_eq!((r.accepted, r.reorg_depth), (6, 5));
    assert_eq!(tracker.tip().height, tip_before + 1);
    assert_eq!(tracker.tip_id(), mine::block_id(branch.last().unwrap()));
    assert_eq!(tracker.id_at(tip_before - 4), Some(mine::block_id(&branch[0])));
    all = branch_all;

    // 4. A fork with less work is refused and changes nothing.
    let state_before = tracker.state();
    let mut short_all = all[..all.len() - 3].to_vec();
    let short = miner.run(&mut short_all, 2, 30, 30);
    let r = tracker.sync(&short, now());
    assert_eq!(r.refused.map(|x| x.code), Some("less_work"));
    assert_eq!(tracker.state(), state_before);

    // 5. A fork deeper than the finality depth is refused.
    let mut deep_all = all[..all.len() - 19].to_vec();
    let deep = miner.run(&mut deep_all, 25, 30, 40);
    let r = tracker.sync(&deep, now());
    assert_eq!(r.refused.map(|x| x.code), Some("too_deep"));
    assert_eq!(tracker.state(), state_before);

    // 6. The work floor: three blocks claiming ten hours each add 3 x 2^18
    //    work for 108,000 s; the floor (1/16 of 2^18 per 30 s) wants about
    //    225 x 2^18 by then, and the 60 blocks so far don't cover it.
    //    (Three blocks claiming one hour each would pass: the floor is an
    //    average since the checkpoint, so a short slow spell is tolerated.)
    let mut slow_all = all.clone();
    let slow = miner.run(&mut slow_all, 3, 36_000, 50);
    let r = tracker.sync(&slow, now());
    assert_eq!(r.refused.as_ref().map(|x| x.code), Some("work_too_low"), "{r:?}");
    assert_eq!(tracker.state(), state_before);

    // 7. The phone clock: a header 121 s ahead of "now" is refused, 120 s is fine.
    let next = miner.child(&all, 30, 60);
    let r = tracker.sync(&[next], next.timestamp - 121);
    assert_eq!(r.refused.map(|x| x.code), Some("too_far_in_future"));
    let r = tracker.sync(&[next], next.timestamp - 120);
    assert_eq!((r.accepted, r.refused), (1, None));
    all.push(next);

    // 8. A bad header in the middle: the valid prefix is kept, the rest refused.
    let more = miner.run(&mut all, 4, 30, 70);
    let mut batch = more.clone();
    batch[2].nonce ^= 1;
    let r = tracker.sync(&batch, now());
    assert_eq!(r.accepted, 2);
    assert_eq!(r.refused.map(|x| (x.height, x.code)), Some((more[2].height, "bad_pow")));

    // 9. Everything survives a store and reload, through the JSON the app keeps.
    let json = serde_json::to_string(&tracker.state()).unwrap();
    let back: noid_mobile_core::chain::ChainState = serde_json::from_str(&json).unwrap();
    let reloaded = Tracker::load_with(&back, &cp, rate).unwrap();
    assert_eq!(reloaded.tip_id(), tracker.tip_id());
    assert_eq!(reloaded.work(), tracker.work());
    let r = reloaded.clone().sync(&more[2..], now());
    assert_eq!((r.accepted, r.refused), (2, None));

    println!("tracker: continuation, overlap, 5-block reorg, less-work and deep forks, work floor, clock, partial batch, stored state: all as expected ({:.1?})", t0.elapsed());
}

fn main() {
    let rounds = std::env::var("ROUNDS").ok().and_then(|r| r.parse().ok()).unwrap_or(50_000);
    let blocks = std::env::var("BLOCKS").ok().and_then(|r| r.parse().ok()).unwrap_or(40);
    fuzz(rounds);
    // All counts above 75% of 2^20: the first child must expand to 21.
    mined_chain("expansion", 262_000, blocks, |_| 800_000, 21);
    // Only the first 10 trusted headers are above the threshold. The first
    // child's window is exactly headers 0..=17 (10 of 18 above: expand); a
    // window off by one height would hold 9 (no expansion).
    mined_chain("window offset", 263_000, 6, |i| if i < 10 { 800_000 } else { 100_000 }, 21);
    // 9 of 18 above is not a strict majority: no expansion.
    mined_chain("tie", 264_000, 4, |i| if i < 9 { 800_000 } else { 100_000 }, 20);
    // Across the v2 activation: the window is v1.1, the first child is block
    // 210,537 with the anchor at 210,536 and mixed 20 s / 30 s intervals.
    mined_chain("v2 switch", V2 - mine::WINDOW_LEN as u64, 14, |_| 800_000, 21);
    tracker_scenarios();
    for path in std::env::args().skip(1) {
        real_headers(&path);
    }
    println!("OK: phone header rules match noid_chain 848209d");
}
