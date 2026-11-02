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
        let parent_ts = match rng.gen_range(0..4) {
            0 => random_u64(&mut rng),
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

/// Mine a short chain at v2 heights with real Poseidon2b PoW, including a
/// log_slots expansion, and check every header with both implementations.
fn mined_chain(start: u64, extensions: usize) {
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
            // Above 75% of 2^20, so the first child must expand to 21.
            active_slot_count: 800_000,
            alloc_counter: 1_000 + i,
        };
        prev = mine::block_id(&h);
        all.push(h);
    }
    let mut chain = HeaderChain::from_trusted(&all).unwrap();
    let mut rng = StdRng::seed_from_u64(7);
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
            active_slot_count: 800_000 + k as u64,
            alloc_counter: parent.alloc_counter + 1,
        };
        child.nonce = official_pow::search_pow(&official(&child), rng.gen::<u64>() as u128, 1 << 26).expect("nonce found");
        official_check(&child, &all).unwrap_or_else(|e| panic!("official refused mined h={}: {e:?}", child.height));
        refused += mutations(&child, &all, &chain);
        let c0 = Instant::now();
        chain.extend(&child, None).unwrap_or_else(|e| panic!("phone refused mined h={}: {e:?}", child.height));
        check_time += c0.elapsed();
        if k == 0 {
            assert_eq!(child.log_slots, 21, "first child expands");
            assert!(child.height >= V2);
        }
        all.push(child);
        assert_eq!(chain.tip_id(), mine::block_id(&child));
    }
    let tip = all.last().unwrap();
    println!(
        "mined chain: {extensions} headers accepted by both (h={}..{}, log_slots 20 -> {}), {refused} wrong variants refused by both for the same reason ({:.1?} total, {:.0?} per header check)",
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
        let mut chain = HeaderChain::from_trusted(trusted).expect("trusted run links");
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
    HeaderChain::from_trusted(&all[all.len() - mine::WINDOW_LEN..]).unwrap()
}

fn main() {
    let rounds = std::env::var("ROUNDS").ok().and_then(|r| r.parse().ok()).unwrap_or(50_000);
    let blocks = std::env::var("BLOCKS").ok().and_then(|r| r.parse().ok()).unwrap_or(40);
    fuzz(rounds);
    mined_chain(262_000, blocks);
    // Across the v2 activation: the window is v1.1, the first child is block
    // 210,537 with the anchor at 210,536 and mixed 20 s / 30 s intervals.
    mined_chain(V2 - mine::WINDOW_LEN as u64, 14);
    for path in std::env::args().skip(1) {
        real_headers(&path);
    }
    println!("OK: phone header rules match noid_chain 848209d");
}
