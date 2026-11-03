//! Block header checks on the phone (NOID 1.1, phase 0).
//!
//! A port of the header rules in the official `noid_chain` crate, Parano1d
//! v2.1.0 (rev 848209d), Apache-2.0, Copyright (C) 2026 Paranoid Zero:
//!
//! - `block_header.rs`: header fields and the block id (`BLOCKHDR` sponge)
//! - `wire.rs`: the 212-byte header encoding
//! - `consensus/pow.rs`: the proof-of-work digest (`POWHDR__` sponge)
//! - `consensus/difficulty.rs`: ASERT target, 256-bit limb helpers, block work
//! - `consensus/forks.rs`: v2 interval schedule
//! - `consensus/header.rs`: check order and the ASERT anchor rule
//! - `consensus/timestamps.rs`: median time past and future drift
//! - `consensus/slot_expansion.rs`: the exact `log_slots` rule
//! - `noid_node/src/snapshot_header_staging.rs`: checking a run of headers
//!   from a trusted window of recent ones
//!
//! `noid_chain` itself can't be built for Android (it links libmdbx), so the
//! needed pure functions are copied here. `tools/headers-check` runs both
//! side by side on the same inputs to show they agree.
//!
//! Only the v2 rules are ported. The phone starts from a recent checkpoint,
//! so it never sees a header from before v2 (height 210,537); those are
//! refused rather than checked under rules that were not copied.
//!
//! What this proves and what it doesn't: a header that passes was mined at
//! the difficulty the chain required and links to the trusted checkpoint.
//! It does not prove that the chain is the one most of the network follows.
//! Difficulty can drop quickly under the v2 rule (the ASERT half-life is 180
//! seconds), so a server that controls everything a phone sees can mine a
//! fake chain. The app has to combine this with work-rate checks and a
//! second source before trusting a tip.
//!
//! The rules the app needs on top of these (a work floor since the built-in
//! checkpoint, the phone's clock on every header, small forks, a batch cap)
//! live in [`crate::chain`].

use std::collections::VecDeque;

use noid_core::{Block128, TowerField};
use noid_poseidon2b::native::compression::Poseidon2bSponge;
use noid_poseidon2b::native::domain::{capacity_iv, TAG_BLOCKHDR, TAG_POWHDR};

// ---------------------------------------------------------------------------
// Consensus constants (consensus/params.rs)
// ---------------------------------------------------------------------------

/// Legacy target block interval (seconds).
pub const BLOCK_TIME: u64 = 20;
/// v2 target block interval (seconds).
pub const V2_BLOCK_TIME: u64 = 30;
/// First mainnet height under the v2 rules.
pub const V2_ACTIVATION_HEIGHT: u64 = 210_537;
/// First mainnet height under the v1.1 rules (selects the BCH polynomial).
pub const V1_1_ACTIVATION_HEIGHT: u64 = 95_125;
/// Blocks per ASERT epoch.
pub const EPOCH_LENGTH: u64 = 6;
/// Maximum seconds a block timestamp may run ahead of the local clock.
pub const MAX_FUTURE_DRIFT: u64 = 120;
/// Ancestors used for median time past.
pub const MEDIAN_TIME_BLOCKS: usize = 11;
/// Depth after which a block can't be reorganized.
pub const CONSENSUS_FINALITY_DEPTH: u64 = 18;
/// Headers in the `log_slots` expansion window.
pub const EXPANSION_WINDOW: u64 = CONSENSUS_FINALITY_DEPTH;
/// Oldest header the expansion rule looks at, counted back from the child.
pub const EXPANSION_HEADER_LOOKBACK: u64 = CONSENSUS_FINALITY_DEPTH + EXPANSION_WINDOW - 1;
/// Recent headers a checker must hold to check the next one (36).
pub const WINDOW_LEN: usize = (EXPANSION_HEADER_LOOKBACK + 1) as usize;
pub const LOG_SLOTS_MAX: u32 = 32;
const EXPAND_NUM: u64 = 3; // 75 %
const EXPAND_DENOM: u64 = 4;

/// Easiest target ASERT may ever produce: 2^238.
pub const GENESIS_TARGET: [u8; 32] = {
    let mut t = [0u8; 32];
    t[29] = 0x40;
    t
};
/// Hardest possible target: 1.
pub const MIN_TARGET: [u8; 32] = {
    let mut t = [0u8; 32];
    t[0] = 1;
    t
};
pub const MAX_TARGET: [u8; 32] = [0xFF; 32];

/// Size of an encoded header.
pub const HEADER_BYTES: usize = 212;

// ---------------------------------------------------------------------------
// Header and wire format (block_header.rs, wire.rs)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Header {
    pub prev_block_hash: [u8; 32],
    pub state_root: [u8; 32],
    pub tx_root: [u8; 32],
    pub timestamp: u64,
    pub height: u64,
    pub miner_address: [u8; 32],
    pub nonce: u128,
    /// Little-endian 256-bit target. Valid iff PoW digest < target.
    pub difficulty_target: [u8; 32],
    pub log_slots: u32,
    pub active_slot_count: u64,
    pub alloc_counter: u64,
}

fn take<const N: usize>(src: &mut &[u8]) -> Option<[u8; N]> {
    if src.len() < N {
        return None;
    }
    let (head, rest) = src.split_at(N);
    *src = rest;
    head.try_into().ok()
}

impl Header {
    /// Decode exactly 212 bytes; anything shorter or longer is refused.
    pub fn from_bytes(bytes: &[u8]) -> Option<Header> {
        if bytes.len() != HEADER_BYTES {
            return None;
        }
        let mut s = bytes;
        let h = Header {
            prev_block_hash: take::<32>(&mut s)?,
            state_root: take::<32>(&mut s)?,
            tx_root: take::<32>(&mut s)?,
            timestamp: u64::from_le_bytes(take::<8>(&mut s)?),
            height: u64::from_le_bytes(take::<8>(&mut s)?),
            miner_address: take::<32>(&mut s)?,
            nonce: u128::from_le_bytes(take::<16>(&mut s)?),
            difficulty_target: take::<32>(&mut s)?,
            log_slots: u32::from_le_bytes(take::<4>(&mut s)?),
            active_slot_count: u64::from_le_bytes(take::<8>(&mut s)?),
            alloc_counter: u64::from_le_bytes(take::<8>(&mut s)?),
        };
        if !s.is_empty() {
            return None;
        }
        Some(h)
    }

    pub fn to_bytes(&self) -> [u8; HEADER_BYTES] {
        let mut out = [0u8; HEADER_BYTES];
        let mut i = 0;
        let mut put = |b: &[u8]| {
            out[i..i + b.len()].copy_from_slice(b);
            i += b.len();
        };
        put(&self.prev_block_hash);
        put(&self.state_root);
        put(&self.tx_root);
        put(&self.timestamp.to_le_bytes());
        put(&self.height.to_le_bytes());
        put(&self.miner_address);
        put(&self.nonce.to_le_bytes());
        put(&self.difficulty_target);
        put(&self.log_slots.to_le_bytes());
        put(&self.active_slot_count.to_le_bytes());
        put(&self.alloc_counter.to_le_bytes());
        out
    }

    /// Decode 424 hex characters. The length is checked before decoding, so
    /// a huge string from a server is refused without being copied.
    pub fn from_hex(hex_str: &str) -> Option<Header> {
        let hex_str = hex_str.trim();
        if hex_str.len() != HEADER_BYTES * 2 {
            return None;
        }
        Header::from_bytes(&hex::decode(hex_str).ok()?)
    }
}

fn halves(d: &[u8; 32]) -> (Block128, Block128) {
    (
        Block128::from(u128::from_le_bytes(d[..16].try_into().unwrap())),
        Block128::from(u128::from_le_bytes(d[16..].try_into().unwrap())),
    )
}

/// The block id (`prev_block_hash` of the next block), `H_BLOCK`.
pub fn block_id(h: &Header) -> [u8; 32] {
    let mut s = Poseidon2bSponge::with_iv(capacity_iv(TAG_BLOCKHDR));
    let digest = |s: &mut Poseidon2bSponge, d: &[u8; 32]| {
        let (hi, lo) = halves(d);
        s.absorb_pair(hi, lo);
    };
    digest(&mut s, &h.prev_block_hash);
    digest(&mut s, &h.state_root);
    digest(&mut s, &h.tx_root);
    s.absorb(Block128::from(h.timestamp as u128));
    s.absorb(Block128::from(h.height as u128));
    digest(&mut s, &h.miner_address);
    s.absorb(Block128::from(h.nonce));
    digest(&mut s, &h.difficulty_target);
    s.absorb(Block128::from(h.log_slots as u128));
    s.absorb(Block128::from(h.active_slot_count as u128));
    s.absorb(Block128::from(h.alloc_counter as u128));
    s.finalize()
}

// ---------------------------------------------------------------------------
// Proof of work (consensus/pow.rs)
// ---------------------------------------------------------------------------

/// The 16-field PoW schedule, nonce at index 10.
fn pow_fields(h: &Header) -> [Block128; 16] {
    let mut f = [Block128::ZERO; 16];
    let mut i = 0;
    let digest = |f: &mut [Block128; 16], i: &mut usize, d: &[u8; 32]| {
        let (hi, lo) = halves(d);
        f[*i] = hi;
        f[*i + 1] = lo;
        *i += 2;
    };
    digest(&mut f, &mut i, &h.prev_block_hash);
    digest(&mut f, &mut i, &h.state_root);
    digest(&mut f, &mut i, &h.tx_root);
    f[i] = Block128::from(h.timestamp as u128);
    f[i + 1] = Block128::from(h.height as u128);
    i += 2;
    digest(&mut f, &mut i, &h.miner_address);
    debug_assert_eq!(i, 10);
    f[i] = Block128::from(h.nonce);
    i += 1;
    digest(&mut f, &mut i, &h.difficulty_target);
    f[i] = Block128::from(h.log_slots as u128);
    f[i + 1] = Block128::from(h.active_slot_count as u128);
    f[i + 2] = Block128::from(h.alloc_counter as u128);
    debug_assert_eq!(i + 3, 16);
    f
}

/// `H_POSEIDON_POW(header)`.
pub fn pow_digest(h: &Header) -> [u8; 32] {
    let mut s = Poseidon2bSponge::with_iv(capacity_iv(TAG_POWHDR));
    for pair in pow_fields(h).chunks_exact(2) {
        s.absorb_pair(pair[0], pair[1]);
    }
    s.finalize_no_pad()
}

/// PoW digest strictly below the header's own target.
pub fn pow_ok(h: &Header) -> bool {
    le256_lt(&pow_digest(h), &h.difficulty_target)
}

// ---------------------------------------------------------------------------
// ASERT difficulty (consensus/difficulty.rs, consensus/forks.rs)
// ---------------------------------------------------------------------------

/// Exact BCH polynomial approximation of `65536 * 2^(frac / 65536)` (v1.1+).
fn bch_fractional_factor(frac: u16) -> u64 {
    let f = frac as u128;
    const A: u128 = 195_766_423_245_049;
    const B: u128 = 971_821_376;
    const C: u128 = 5_127;
    65536 + ((A * f + B * f * f + C * f * f * f + (1u128 << 47)) >> 48) as u64
}

/// Target seconds for (anchor, child], with the v2 interval from its height.
pub fn ideal_elapsed(anchor: u64, child: u64) -> u128 {
    let count = child.saturating_sub(anchor);
    if child >= V2_ACTIVATION_HEIGHT {
        let last_old = V2_ACTIVATION_HEIGHT - 1;
        let start = if anchor > last_old { anchor } else { last_old };
        let new_count = child.saturating_sub(start);
        (count - new_count) as u128 * BLOCK_TIME as u128 + new_count as u128 * V2_BLOCK_TIME as u128
    } else {
        count as u128 * BLOCK_TIME as u128
    }
}

/// Height of the ASERT anchor block for a chain whose tip is `tip_height`.
pub fn asert_anchor_height(tip_height: u64) -> u64 {
    let regular = (tip_height / EPOCH_LENGTH) * EPOCH_LENGTH;
    if tip_height >= V2_ACTIVATION_HEIGHT - 1 {
        regular.max(V2_ACTIVATION_HEIGHT - 1)
    } else {
        regular
    }
}

/// The only valid `difficulty_target` for a v2 block at `height`. Under v2
/// the parent's timestamp sets it, so siblings share one target. `None`
/// below v2 (those rules were not ported).
pub fn next_target(
    anchor_height: u64,
    anchor_timestamp: u64,
    anchor_target: &[u8; 32],
    height: u64,
    parent_timestamp: u64,
) -> Option<[u8; 32]> {
    if height < V2_ACTIVATION_HEIGHT {
        return None;
    }
    let parent_height = height - 1;
    let actual = parent_timestamp
        .saturating_sub(anchor_timestamp)
        .min(i64::MAX as u64) as i128;
    let ideal = ideal_elapsed(anchor_height, parent_height).min(i128::MAX as u128) as i128;
    let halflife = EPOCH_LENGTH as i128 * V2_BLOCK_TIME as i128;
    let exponent = actual.saturating_sub(ideal).saturating_mul(65536) / halflife;
    Some(target_from_exponent(
        anchor_target,
        exponent.clamp(i64::MIN as i128, i64::MAX as i128) as i64,
    ))
}

/// Only called for v2 heights, which are all past v1.1, so the BCH factor
/// always applies. The genesis floor is always on (it is off only inside
/// `noid_chain`'s own unit tests).
fn target_from_exponent(anchor_target: &[u8; 32], exponent: i64) -> [u8; 32] {
    let shifts: i64 = exponent >> 16;
    let frac: u16 = (exponent - shifts * 65536) as u16;
    let factor = bch_fractional_factor(frac);
    let mut wide = mul_limbs_u64(bytes_to_limbs(anchor_target), factor);
    let net: i64 = shifts - 16;
    if net >= 46 {
        return GENESIS_TARGET;
    }
    if net <= -320 {
        return MIN_TARGET;
    }
    wide = shift_wide(wide, net);
    if net > 0 && wide == [0u64; 5] {
        return GENESIS_TARGET;
    }
    let result = limbs_to_bytes([wide[0], wide[1], wide[2], wide[3]]);
    let clamped = clamp(result, wide[4]);
    if le256_lt(&GENESIS_TARGET, &clamped) {
        return GENESIS_TARGET;
    }
    clamped
}

fn bytes_to_limbs(b: &[u8; 32]) -> [u64; 4] {
    [
        u64::from_le_bytes(b[0..8].try_into().unwrap()),
        u64::from_le_bytes(b[8..16].try_into().unwrap()),
        u64::from_le_bytes(b[16..24].try_into().unwrap()),
        u64::from_le_bytes(b[24..32].try_into().unwrap()),
    ]
}

fn limbs_to_bytes(l: [u64; 4]) -> [u8; 32] {
    let mut b = [0u8; 32];
    b[0..8].copy_from_slice(&l[0].to_le_bytes());
    b[8..16].copy_from_slice(&l[1].to_le_bytes());
    b[16..24].copy_from_slice(&l[2].to_le_bytes());
    b[24..32].copy_from_slice(&l[3].to_le_bytes());
    b
}

fn mul_limbs_u64(a: [u64; 4], factor: u64) -> [u64; 5] {
    let mut out = [0u64; 5];
    let mut carry: u128 = 0;
    for i in 0..4 {
        let prod = a[i] as u128 * factor as u128 + carry;
        out[i] = prod as u64;
        carry = prod >> 64;
    }
    out[4] = carry as u64;
    out
}

fn shl320(w: [u64; 5], n: u32) -> [u64; 5] {
    if n == 0 {
        return w;
    }
    let word_sh = (n / 64).min(5) as usize;
    let bit_sh = n % 64;
    let mut out = [0u64; 5];
    out[word_sh..5].copy_from_slice(&w[..(5 - word_sh)]);
    if bit_sh > 0 {
        let mut c = 0u64;
        for limb in out.iter_mut() {
            let nc = *limb >> (64 - bit_sh);
            *limb = (*limb << bit_sh) | c;
            c = nc;
        }
    }
    out
}

fn shr320(w: [u64; 5], n: u32) -> [u64; 5] {
    if n == 0 {
        return w;
    }
    let word_sh = (n / 64).min(5) as usize;
    let bit_sh = n % 64;
    let mut out = [0u64; 5];
    out[..(5 - word_sh)].copy_from_slice(&w[word_sh..5]);
    if bit_sh > 0 {
        let mut c = 0u64;
        for limb in out.iter_mut().rev() {
            let nc = *limb << (64 - bit_sh);
            *limb = (*limb >> bit_sh) | c;
            c = nc;
        }
    }
    out
}

fn shift_wide(w: [u64; 5], net: i64) -> [u64; 5] {
    if net >= 0 {
        shl320(w, net.min(319) as u32)
    } else {
        shr320(w, (-net).min(319) as u32)
    }
}

fn clamp(result: [u8; 32], overflow_word: u64) -> [u8; 32] {
    if overflow_word != 0 || le256_lt(&MAX_TARGET, &result) {
        return MAX_TARGET;
    }
    if result == [0u8; 32] || le256_lt(&result, &MIN_TARGET) {
        return MIN_TARGET;
    }
    result
}

/// `a < b` as little-endian 256-bit integers.
pub fn le256_lt(a: &[u8; 32], b: &[u8; 32]) -> bool {
    for i in (0..32).rev() {
        if a[i] != b[i] {
            return a[i] < b[i];
        }
    }
    false
}

/// Expected hashes to find a block at `target`: floor((2^256 - 1) / target) + 1.
pub fn block_work(target: &[u8; 32]) -> [u8; 32] {
    if target.iter().all(|b| *b == 0) {
        return [0u8; 32];
    }
    add_one_saturating(&div_u256(&[0xFF; 32], target))
}

/// Saturating 256-bit add of two work values.
pub fn add_work(a: &[u8; 32], b: &[u8; 32]) -> [u8; 32] {
    let mut out = [0u8; 32];
    let mut carry = 0u16;
    for i in 0..32 {
        let sum = a[i] as u16 + b[i] as u16 + carry;
        out[i] = sum as u8;
        carry = sum >> 8;
    }
    if carry != 0 {
        [0xFF; 32]
    } else {
        out
    }
}

fn add_one_saturating(a: &[u8; 32]) -> [u8; 32] {
    let mut out = *a;
    for byte in &mut out {
        let (next, carry) = byte.overflowing_add(1);
        *byte = next;
        if !carry {
            return out;
        }
    }
    [0xFF; 32]
}

/// Bit-by-bit long division; `d` is non-zero.
fn div_u256(n: &[u8; 32], d: &[u8; 32]) -> [u8; 32] {
    let mut q = [0u8; 32];
    let mut r = [0u8; 32];
    for bit in (0..256).rev() {
        let mut carry = 0u8;
        for byte in r.iter_mut() {
            let next = *byte >> 7;
            *byte = (*byte << 1) | carry;
            carry = next;
        }
        if (n[bit / 8] >> (bit % 8)) & 1 == 1 {
            r[0] |= 1;
        }
        if !le256_lt(&r, d) {
            let mut borrow = 0i16;
            for i in 0..32 {
                let diff = r[i] as i16 - d[i] as i16 - borrow;
                if diff < 0 {
                    r[i] = (diff + 256) as u8;
                    borrow = 1;
                } else {
                    r[i] = diff as u8;
                    borrow = 0;
                }
            }
            q[bit / 8] |= 1 << (bit % 8);
        }
    }
    q
}

// ---------------------------------------------------------------------------
// Timestamps (consensus/timestamps.rs)
// ---------------------------------------------------------------------------

/// Upper median of the last (up to) 11 timestamps, oldest first. 0 if none.
pub fn median_time_past(prev: &[u64]) -> u64 {
    if prev.is_empty() {
        return 0;
    }
    let count = prev.len().min(MEDIAN_TIME_BLOCKS);
    let mut recent = prev[prev.len() - count..].to_vec();
    recent.sort_unstable();
    recent[count / 2]
}

// ---------------------------------------------------------------------------
// log_slots expansion (consensus/slot_expansion.rs)
// ---------------------------------------------------------------------------

/// Inclusive hard-finalized range of heights deciding the child of `parent_height`.
pub fn finalized_expansion_window(parent_height: u64) -> Option<(u64, u64)> {
    let end = parent_height.checked_sub(CONSENSUS_FINALITY_DEPTH)?;
    let start = end.checked_sub(EXPANSION_WINDOW.checked_sub(1)?)?;
    Some((start, end))
}

/// The only `log_slots` valid for the child of a parent header.
pub fn expected_child_log_slots(parent_height: u64, parent_log_slots: u32, finalized_active_counts: &[u64]) -> u32 {
    if finalized_expansion_window(parent_height).is_none() {
        return parent_log_slots;
    }
    let expected_len = EXPANSION_WINDOW as usize;
    if finalized_active_counts.len() != expected_len {
        return parent_log_slots;
    }
    let prev_capacity = 1u64.checked_shl(parent_log_slots).unwrap_or(u64::MAX);
    let threshold_scaled = prev_capacity.saturating_mul(EXPAND_NUM);
    let at_or_above = finalized_active_counts
        .iter()
        .filter(|active| active.saturating_mul(EXPAND_DENOM) >= threshold_scaled)
        .count();
    if at_or_above > expected_len / 2 {
        parent_log_slots.saturating_add(1).min(LOG_SLOTS_MAX)
    } else {
        parent_log_slots
    }
}

// ---------------------------------------------------------------------------
// Checking one header and a run of headers (consensus/header.rs,
// snapshot_header_staging.rs)
// ---------------------------------------------------------------------------

/// Why a header was refused. After the v2 height check, the order is that of
/// `validate_header_inner` (the node's header extension path checks future
/// drift later, after PoW; only the error reported can differ, never the
/// accept/refuse answer).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HeaderError {
    /// From before v2; not checked here.
    TooOld,
    BadParentHash,
    BadHeight,
    BadDifficultyTarget,
    /// Not after the median of the last 11 blocks: the chain itself is wrong.
    BadTimestamp,
    /// More than 120 s ahead of this phone's clock. Either the server lies
    /// or the phone's clock is behind, so the app should say which to check.
    TooFarInFuture,
    BadPow,
    BadLogSlotsExpansion,
    /// The window doesn't hold the ancestors this header needs.
    WindowIncomplete,
    /// The trusted run doesn't end at the expected checkpoint.
    WrongCheckpoint,
}

impl HeaderError {
    pub fn code(self) -> &'static str {
        match self {
            HeaderError::TooOld => "too_old",
            HeaderError::BadParentHash => "bad_parent_hash",
            HeaderError::BadHeight => "bad_height",
            HeaderError::BadDifficultyTarget => "bad_difficulty_target",
            HeaderError::BadTimestamp => "bad_timestamp",
            HeaderError::TooFarInFuture => "too_far_in_future",
            HeaderError::BadPow => "bad_pow",
            HeaderError::BadLogSlotsExpansion => "bad_log_slots",
            HeaderError::WindowIncomplete => "window_incomplete",
            HeaderError::WrongCheckpoint => "wrong_checkpoint",
        }
    }
}

/// Check `header` as the child of `parent`, with every rule of
/// `validate_header_inner` (PoW included). `prev_timestamps` are up to 11
/// ancestors oldest first; `finalized_active_counts` is the complete
/// expansion window or empty; `local_time` adds the future-drift rule.
///
/// Like the official `validate_header_timeless_prehashed_parent`, this
/// trusts its other inputs: `parent_id` must be `block_id(parent)`, the
/// anchor must be the real ancestor at `asert_anchor_height(parent.height)`,
/// and an empty or short `finalized_active_counts` silently allows no
/// expansion. Prefer [`HeaderChain::extend`], which derives all of them.
#[allow(clippy::too_many_arguments)]
pub fn check_header(
    header: &Header,
    parent: &Header,
    parent_id: &[u8; 32],
    prev_timestamps: &[u64],
    finalized_active_counts: &[u64],
    local_time: Option<u64>,
    anchor_height: u64,
    anchor_timestamp: u64,
    anchor_target: &[u8; 32],
) -> Result<(), HeaderError> {
    if header.height < V2_ACTIVATION_HEIGHT {
        return Err(HeaderError::TooOld);
    }
    // 1. Parent link.
    if &header.prev_block_hash != parent_id {
        return Err(HeaderError::BadParentHash);
    }
    // 2. Height.
    if Some(header.height) != parent.height.checked_add(1) {
        return Err(HeaderError::BadHeight);
    }
    // 3. ASERT target.
    let expected = next_target(anchor_height, anchor_timestamp, anchor_target, header.height, parent.timestamp)
        .ok_or(HeaderError::TooOld)?;
    if header.difficulty_target != expected {
        return Err(HeaderError::BadDifficultyTarget);
    }
    // 4. Timestamps. (parent.height == 0 can't happen past v2.)
    if header.timestamp <= median_time_past(prev_timestamps) {
        return Err(HeaderError::BadTimestamp);
    }
    if let Some(now) = local_time {
        if header.timestamp > now.saturating_add(MAX_FUTURE_DRIFT) {
            return Err(HeaderError::TooFarInFuture);
        }
    }
    // 5. Proof of work.
    if !pow_ok(header) {
        return Err(HeaderError::BadPow);
    }
    // 6. log_slots.
    if header.log_slots != expected_child_log_slots(parent.height, parent.log_slots, finalized_active_counts) {
        return Err(HeaderError::BadLogSlotsExpansion);
    }
    Ok(())
}

/// A trusted run of recent headers that new headers are checked against,
/// one at a time, the way the node checks a header extension.
#[derive(Debug, Clone)]
pub struct HeaderChain {
    window: VecDeque<Header>,
    tip_id: [u8; 32],
    /// Work added on top of the checkpoint (not the whole chain's work).
    work: [u8; 32],
}

impl HeaderChain {
    /// Start from `trusted`: exactly [`WINDOW_LEN`] contiguous headers ending
    /// at the checkpoint whose block id is `checkpoint_id`. Only the links
    /// between them and the final id are checked; the caller vouches for the
    /// rest (they ship inside the app, next to `checkpoint_id`).
    pub fn from_trusted(trusted: &[Header], checkpoint_id: &[u8; 32]) -> Result<HeaderChain, HeaderError> {
        if trusted.len() != WINDOW_LEN {
            return Err(HeaderError::WindowIncomplete);
        }
        let run = trusted;
        // The window itself may reach back before v2 (it is only data); the
        // next header, which is checked, must be a v2 block.
        if run[WINDOW_LEN - 1].height < V2_ACTIVATION_HEIGHT - 1 {
            return Err(HeaderError::TooOld);
        }
        let mut id = block_id(&run[0]);
        for pair in run.windows(2) {
            if Some(pair[1].height) != pair[0].height.checked_add(1) {
                return Err(HeaderError::BadHeight);
            }
            if pair[1].prev_block_hash != id {
                return Err(HeaderError::BadParentHash);
            }
            id = block_id(&pair[1]);
        }
        if &id != checkpoint_id {
            return Err(HeaderError::WrongCheckpoint);
        }
        Ok(HeaderChain { window: run.iter().copied().collect(), tip_id: id, work: [0u8; 32] })
    }

    pub fn tip(&self) -> &Header {
        self.window.back().expect("window is never empty")
    }

    pub fn tip_id(&self) -> [u8; 32] {
        self.tip_id
    }

    pub fn added_work(&self) -> [u8; 32] {
        self.work
    }

    /// Check `header` as the next block and, if it passes, make it the tip.
    /// On error nothing changes.
    pub fn extend(&mut self, header: &Header, local_time: Option<u64>) -> Result<(), HeaderError> {
        let parent = *self.tip();
        let ts_start = self.window.len().saturating_sub(MEDIAN_TIME_BLOCKS);
        let prev_timestamps: Vec<u64> = self.window.iter().skip(ts_start).map(|h| h.timestamp).collect();

        let counts: Vec<u64> = match finalized_expansion_window(parent.height) {
            None => Vec::new(),
            Some((start, end)) => {
                let first = self.window.front().expect("window is never empty").height;
                let offset = start
                    .checked_sub(first)
                    .and_then(|o| usize::try_from(o).ok())
                    .ok_or(HeaderError::WindowIncomplete)?;
                let mut out = Vec::with_capacity(EXPANSION_WINDOW as usize);
                for (i, height) in (start..=end).enumerate() {
                    let a = self.window.get(offset + i).ok_or(HeaderError::WindowIncomplete)?;
                    if a.height != height {
                        return Err(HeaderError::WindowIncomplete);
                    }
                    out.push(a.active_slot_count);
                }
                out
            }
        };

        let anchor_height = asert_anchor_height(parent.height);
        let anchor = self
            .window
            .iter()
            .find(|a| a.height == anchor_height)
            .ok_or(HeaderError::WindowIncomplete)?;

        check_header(
            header,
            &parent,
            &self.tip_id,
            &prev_timestamps,
            &counts,
            local_time,
            anchor_height,
            anchor.timestamp,
            &anchor.difficulty_target,
        )?;

        self.tip_id = block_id(header);
        self.work = add_work(&self.work, &block_work(&header.difficulty_target));
        self.window.push_back(*header);
        while self.window.len() > WINDOW_LEN {
            self.window.pop_front();
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> Header {
        Header {
            prev_block_hash: [0x11; 32],
            state_root: [0x22; 32],
            tx_root: [0x33; 32],
            timestamp: 1_792_000_000,
            height: 250_000,
            miner_address: [0x44; 32],
            nonce: 0xDEAD_BEEF_CAFE_BABE,
            difficulty_target: GENESIS_TARGET,
            log_slots: 20,
            active_slot_count: 12345,
            alloc_counter: 678,
        }
    }

    #[test]
    fn wire_round_trip_and_exact_length() {
        let h = sample();
        let b = h.to_bytes();
        assert_eq!(Header::from_bytes(&b), Some(h));
        assert_eq!(Header::from_bytes(&b[..211]), None);
        let mut long = b.to_vec();
        long.push(0);
        assert_eq!(Header::from_bytes(&long), None);
    }

    #[test]
    fn on_time_chain_keeps_its_target() {
        // Parent exactly on schedule from the anchor: exponent 0, factor
        // 65536, target unchanged.
        let anchor = 252_000u64;
        let parent_ts = 1_000 + 30 * 3;
        let t = next_target(anchor, 1_000, &some_target(), anchor + 4, parent_ts).unwrap();
        assert_eq!(t, some_target());
    }

    fn some_target() -> [u8; 32] {
        let mut t = [0u8; 32];
        t[27] = 0x12;
        t[20] = 0x34;
        t
    }

    #[test]
    fn slow_blocks_ease_and_fast_blocks_harden_within_floor() {
        let anchor = 252_000u64;
        let base = some_target();
        // One half-life late: target doubles (up to polynomial rounding).
        let late = next_target(anchor, 0, &base, anchor + 2, 30 + 180).unwrap();
        assert!(le256_lt(&base, &late));
        // Very early: target shrinks.
        let early = next_target(anchor, 1_000, &base, anchor + 2, 1_000).unwrap();
        assert!(le256_lt(&early, &base));
        // Hours late: capped at the genesis floor.
        assert_eq!(next_target(anchor, 0, &base, anchor + 2, 10_000_000).unwrap(), GENESIS_TARGET);
        // Pre-v2 heights are not checked here.
        assert_eq!(next_target(0, 0, &base, V2_ACTIVATION_HEIGHT - 1, 0), None);
    }

    #[test]
    fn anchor_rule_around_v2() {
        assert_eq!(asert_anchor_height(V2_ACTIVATION_HEIGHT - 2), ((V2_ACTIVATION_HEIGHT - 2) / 6) * 6);
        assert_eq!(asert_anchor_height(V2_ACTIVATION_HEIGHT - 1), V2_ACTIVATION_HEIGHT - 1);
        assert_eq!(asert_anchor_height(V2_ACTIVATION_HEIGHT + 2), V2_ACTIVATION_HEIGHT - 1);
        assert_eq!(asert_anchor_height(262_705), 262_704);
        assert_eq!(ideal_elapsed(V2_ACTIVATION_HEIGHT - 3, V2_ACTIVATION_HEIGHT), 20 + 20 + 30);
    }

    #[test]
    fn work_of_genesis_target_is_2_pow_18() {
        let w = block_work(&GENESIS_TARGET);
        let mut expect = [0u8; 32];
        expect[2] = 0x04; // 2^18
        assert_eq!(w, expect);
    }

    fn window(start: u64) -> Vec<Header> {
        let mut prev = [0u8; 32];
        (0..WINDOW_LEN as u64)
            .map(|i| {
                let mut h = sample();
                h.height = start + i;
                h.timestamp += i * 30;
                h.prev_block_hash = prev;
                prev = block_id(&h);
                h
            })
            .collect()
    }

    #[test]
    fn trusted_window_must_link_and_end_at_the_checkpoint() {
        let w = window(262_000);
        let id = block_id(w.last().unwrap());
        assert!(HeaderChain::from_trusted(&w, &id).is_ok());
        assert_eq!(HeaderChain::from_trusted(&w, &[9u8; 32]).unwrap_err(), HeaderError::WrongCheckpoint);
        assert_eq!(HeaderChain::from_trusted(&w[1..], &id).unwrap_err(), HeaderError::WindowIncomplete);
        let mut longer = window(261_999);
        longer.push(sample());
        assert_eq!(HeaderChain::from_trusted(&longer, &id).unwrap_err(), HeaderError::WindowIncomplete);
        let mut broken = w.clone();
        broken[20].prev_block_hash[0] ^= 1;
        assert_eq!(HeaderChain::from_trusted(&broken, &id).unwrap_err(), HeaderError::BadParentHash);
        let mut gap = w.clone();
        gap[20].height += 1;
        assert_eq!(HeaderChain::from_trusted(&gap, &id).unwrap_err(), HeaderError::BadHeight);
        // Ending before v2 - 1: the next header could not be checked here.
        let old = window(V2_ACTIVATION_HEIGHT - 1 - WINDOW_LEN as u64);
        assert_eq!(HeaderChain::from_trusted(&old, &block_id(old.last().unwrap())).unwrap_err(), HeaderError::TooOld);
        let edge = window(V2_ACTIVATION_HEIGHT - WINDOW_LEN as u64);
        assert!(HeaderChain::from_trusted(&edge, &block_id(edge.last().unwrap())).is_ok());
    }

    #[test]
    fn refused_header_changes_nothing() {
        let w = window(262_000);
        let mut chain = HeaderChain::from_trusted(&w, &block_id(w.last().unwrap())).unwrap();
        let before = (chain.tip_id(), chain.added_work(), *chain.tip());
        let mut child = sample();
        child.height = 262_000 + WINDOW_LEN as u64;
        child.prev_block_hash = chain.tip_id();
        assert!(chain.extend(&child, None).is_err());
        assert_eq!((chain.tip_id(), chain.added_work(), *chain.tip()), before);
        let mut old = child;
        old.height = 100;
        assert_eq!(chain.extend(&old, None), Err(HeaderError::TooOld));
    }

    #[test]
    fn hex_is_length_checked_first() {
        let h = sample();
        let hex_str = hex::encode(h.to_bytes());
        assert_eq!(Header::from_hex(&hex_str), Some(h));
        assert_eq!(Header::from_hex(&format!("  {hex_str}\n")), Some(h));
        assert_eq!(Header::from_hex(&hex_str[..423]), None);
        assert_eq!(Header::from_hex(&format!("{hex_str}0")), None);
        assert_eq!(Header::from_hex(&format!("{hex_str}00")), None);
        assert_eq!(Header::from_hex(&"zz".repeat(212)), None);
        assert_eq!(Header::from_hex(&"0".repeat(10_000_000)), None);
    }

    #[test]
    fn median_and_expansion() {
        assert_eq!(median_time_past(&[]), 0);
        assert_eq!(median_time_past(&[5, 1, 3]), 3);
        assert_eq!(median_time_past(&[1, 2, 3, 4]), 3);
        assert_eq!(expected_child_log_slots(35, 8, &[0; 18]), 8);
        assert_eq!(expected_child_log_slots(34, 8, &[u64::MAX; 18]), 8);
        assert_eq!(expected_child_log_slots(35, 8, &[192; 18]), 9);
        assert_eq!(expected_child_log_slots(35, 8, &[192; 17]), 8);
    }
}
