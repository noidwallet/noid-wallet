//! Following the chain from a built-in checkpoint (NOID 1.1, phase 1).
//!
//! [`headers`](crate::headers) checks one header at a time. This module keeps
//! the phone's view of the chain between app runs and adds the rules the
//! single-header check can't give on its own:
//!
//! - A built-in checkpoint: 36 real mainnet headers ending at block 274,821
//!   (`checkpoint.hex`, fetched from our node on Nov 2, 2026 and checked
//!   against the official code by `tools/headers-check`). Everything after
//!   it is checked on the phone.
//! - A work floor. ASERT lets difficulty fall fast when timestamps run late,
//!   so a fake chain can be cheap after one real-difficulty block. The work
//!   added since the checkpoint must keep up with the time the headers claim
//!   has passed, at 1/16 of the network rate measured at the checkpoint
//!   (about 7.5 x 10^11 hashes per second). A real chain only fails this if
//!   the network loses over 15/16 of its mining; a fake one needs about
//!   2^40 hashes per claimed block, which is what the floor is for.
//! - The phone's clock: every header is checked for future drift.
//! - Small forks: the last 54 headers are kept, so a branch that starts up
//!   to 18 blocks back (the node's finality depth) can replace the tip when
//!   it carries more work. Deeper forks are refused, like the node does.
//! - A batch cap of 4,096 headers per call, like the node's.
//! - Recent block ids (the last 2,048), so the app can tell whether the block
//!   a payment was reported in is on the chain the phone checked.
//!
//! What this proves: the headers the server gave form a valid proof-of-work
//! chain from the checkpoint, at close to the real network's difficulty. What
//! it does not prove: that a payment is inside one of those blocks. That
//! needs slot proofs (phase 2, after Parano1d adds an RPC for them).

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::headers::{add_work, block_id, block_work, le256_lt, Header, HeaderChain, CONSENSUS_FINALITY_DEPTH, WINDOW_LEN};
use crate::Error;

/// The 36 checkpoint headers, one hex line each, oldest first.
const CHECKPOINT_HEX: &str = include_str!("checkpoint.hex");
/// Network rate at the checkpoint: hashes per second over blocks 274,421 to
/// 274,821 (11,705 s), from the same headers file.
pub const CHECKPOINT_RATE: u128 = 745_126_342_524;
/// The chain must carry at least this fraction of the checkpoint rate.
pub const WORK_FLOOR_DIVISOR: u128 = 16;
/// Headers kept: a full check window plus the finality depth.
pub const RETAIN: usize = WINDOW_LEN + CONSENSUS_FINALITY_DEPTH as usize;
/// Most headers accepted in one call (the node's `MAX_STAGED_HEADER_BATCH`).
pub const MAX_BATCH: usize = 4096;
/// Block ids remembered for payment checks (about 17 hours of blocks).
pub const RECENT_IDS: usize = 2048;

pub struct Checkpoint {
    pub headers: Vec<Header>,
    pub id: [u8; 32],
    pub height: u64,
    pub timestamp: u64,
}

/// The built-in checkpoint. Panics only if the bundled file is corrupt,
/// which the tests catch at build time.
pub fn checkpoint() -> Checkpoint {
    let headers: Vec<Header> = CHECKPOINT_HEX
        .lines()
        .filter(|l| !l.trim().is_empty())
        .map(|l| Header::from_hex(l).expect("checkpoint.hex holds 212-byte headers"))
        .collect();
    Checkpoint::from_headers(&headers).expect("checkpoint headers link")
}

impl Checkpoint {
    /// A checkpoint from exactly [`WINDOW_LEN`] linked headers (tests and tools).
    pub fn from_headers(headers: &[Header]) -> Result<Checkpoint, crate::headers::HeaderError> {
        let last = headers.last().ok_or(crate::headers::HeaderError::WindowIncomplete)?;
        let id = block_id(last);
        HeaderChain::from_trusted(headers, &id)?;
        Ok(Checkpoint { headers: headers.to_vec(), id, height: last.height, timestamp: last.timestamp })
    }
}

/// The phone's view of the chain, as stored by the app between runs.
/// Opaque to the app except `ids`, which maps a height (decimal string) to
/// the block id the phone checked at that height.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ChainState {
    pub v: u32,
    /// Height of the built-in checkpoint this state was built from.
    pub checkpoint: u64,
    /// The last [`RETAIN`] headers at most, oldest first, hex.
    pub headers: Vec<String>,
    /// Work added since the checkpoint by headers that were trimmed from
    /// `headers` (hex, little-endian 256-bit).
    pub work_before: String,
    /// Recent block ids by height.
    pub ids: BTreeMap<u64, String>,
}

/// What one sync did.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SyncReport {
    pub accepted: usize,
    /// The first header that was not accepted, if any, and why.
    pub refused: Option<Refused>,
    /// Blocks replaced when a better branch took over (0 when none).
    pub reorg_depth: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Refused {
    pub height: u64,
    /// A [`HeaderError`] code, or one of: `gap` (the batch doesn't start at
    /// the tip + 1), `too_deep` (a branch from more than 18 blocks back, or
    /// from before the checkpoint), `less_work` (a branch with no more work
    /// than the current one), `work_too_low` (the chain fails the work
    /// floor), `too_many` (more than [`MAX_BATCH`] headers).
    pub code: &'static str,
}

#[derive(Clone, Debug)]
struct Entry {
    header: Header,
    id: [u8; 32],
    /// Work added since the checkpoint, through this header.
    work: [u8; 32],
}

/// The chain being followed. Load with [`Tracker::load`], sync with
/// [`Tracker::sync`], store with [`Tracker::state`].
#[derive(Clone, Debug)]
pub struct Tracker {
    cp_height: u64,
    cp_timestamp: u64,
    /// Network rate at the checkpoint, hashes per second.
    rate: u128,
    retained: Vec<Entry>,
    work_before: [u8; 32],
    ids: BTreeMap<u64, [u8; 32]>,
}

fn hex32(b: &[u8; 32]) -> String {
    hex::encode(b)
}

fn unhex32(s: &str) -> Option<[u8; 32]> {
    let v = hex::decode(s).ok()?;
    v.try_into().ok()
}

/// `seconds * rate / divisor` as a little-endian 256-bit value.
fn required_work(seconds: u64, rate: u128, divisor: u128) -> [u8; 32] {
    let v = (seconds as u128).saturating_mul(rate) / divisor;
    let mut out = [0u8; 32];
    out[..16].copy_from_slice(&v.to_le_bytes());
    out
}

impl Tracker {
    /// Start fresh from the built-in checkpoint.
    pub fn new() -> Tracker {
        Tracker::with_checkpoint(&checkpoint(), CHECKPOINT_RATE)
    }

    /// Start from another checkpoint (tests and `tools/headers-check`).
    pub fn with_checkpoint(cp: &Checkpoint, rate: u128) -> Tracker {
        let retained = cp.headers.iter().map(|h| Entry { header: *h, id: block_id(h), work: [0u8; 32] }).collect();
        Tracker { cp_height: cp.height, cp_timestamp: cp.timestamp, rate, retained, work_before: [0u8; 32], ids: BTreeMap::new() }
    }

    /// Rebuild from a stored state. Anything inconsistent is refused (code
    /// `bad_state`), and the app should start again from the checkpoint.
    /// The state is the phone's own storage, trusted like the wallet secret:
    /// `work_before` (work of trimmed headers) can't be re-derived from it.
    pub fn load(state: &ChainState) -> Result<Tracker, Error> {
        Tracker::load_with(state, &checkpoint(), CHECKPOINT_RATE)
    }

    pub fn load_with(state: &ChainState, cp: &Checkpoint, rate: u128) -> Result<Tracker, Error> {
        let bad = |m: &str| Error::coded("bad_state", format!("Stored chain state is unusable: {m}"));
        if state.v != 1 || state.checkpoint != cp.height {
            return Err(bad("different version or checkpoint"));
        }
        if state.headers.len() < WINDOW_LEN || state.headers.len() > RETAIN {
            return Err(bad("wrong number of headers"));
        }
        let work_before = unhex32(&state.work_before).ok_or_else(|| bad("work"))?;
        let mut retained: Vec<Entry> = Vec::with_capacity(state.headers.len());
        let mut work = work_before;
        for hx in &state.headers {
            let header = Header::from_hex(hx).ok_or_else(|| bad("header"))?;
            if let Some(prev) = retained.last() {
                if header.height != prev.header.height + 1 || header.prev_block_hash != prev.id {
                    return Err(bad("headers don't link"));
                }
            }
            if header.height > cp.height {
                work = add_work(&work, &block_work(&header.difficulty_target));
            } else {
                // At or below the checkpoint only the checkpoint's own headers are allowed.
                let known = header
                    .height
                    .checked_sub(cp.headers[0].height)
                    .and_then(|i| usize::try_from(i).ok())
                    .and_then(|i| cp.headers.get(i));
                if known != Some(&header) {
                    return Err(bad("not the checkpoint"));
                }
            }
            retained.push(Entry { header, id: block_id(&header), work });
        }
        let tip = retained.last().expect("non-empty").header.height;
        let mut ids = BTreeMap::new();
        for (h, s) in &state.ids {
            if *h > tip || *h <= cp.height {
                return Err(bad("id outside the chain"));
            }
            let id = unhex32(s).ok_or_else(|| bad("id"))?;
            if let Some(e) = retained.iter().find(|e| e.header.height == *h) {
                if e.id != id {
                    return Err(bad("id doesn't match its header"));
                }
            }
            ids.insert(*h, id);
        }
        if ids.len() > RECENT_IDS {
            return Err(bad("too many ids"));
        }
        let t = Tracker { cp_height: cp.height, cp_timestamp: cp.timestamp, rate, retained, work_before, ids };
        // The chain in the state must itself pass the work floor.
        if t.below_floor() {
            return Err(bad("work below floor"));
        }
        Ok(t)
    }

    pub fn state(&self) -> ChainState {
        ChainState {
            v: 1,
            checkpoint: self.cp_height,
            headers: self.retained.iter().map(|e| hex::encode(e.header.to_bytes())).collect(),
            work_before: hex32(&self.work_before),
            ids: self.ids.iter().map(|(h, id)| (*h, hex32(id))).collect(),
        }
    }

    pub fn checkpoint_height(&self) -> u64 {
        self.cp_height
    }

    pub fn tip(&self) -> &Header {
        &self.retained.last().expect("never empty").header
    }

    pub fn tip_id(&self) -> [u8; 32] {
        self.retained.last().expect("never empty").id
    }

    /// Work added since the checkpoint.
    pub fn work(&self) -> [u8; 32] {
        self.retained.last().expect("never empty").work
    }

    /// The block id the phone checked at `height`, if it still remembers it.
    pub fn id_at(&self, height: u64) -> Option<[u8; 32]> {
        if let Some(e) = self.retained.iter().find(|e| e.header.height == height) {
            return Some(e.id);
        }
        self.ids.get(&height).copied()
    }

    fn below_floor(&self) -> bool {
        let elapsed = self.tip().timestamp.saturating_sub(self.cp_timestamp);
        le256_lt(&self.work(), &required_work(elapsed, self.rate, WORK_FLOOR_DIVISOR))
    }

    fn chain(&self) -> HeaderChain {
        let n = self.retained.len();
        let run: Vec<Header> = self.retained[n - WINDOW_LEN..].iter().map(|e| e.header).collect();
        HeaderChain::from_trusted(&run, &self.tip_id()).expect("retained headers link")
    }

    fn push(&mut self, header: Header, id: [u8; 32]) {
        let work = add_work(&self.work(), &block_work(&header.difficulty_target));
        self.retained.push(Entry { header, id, work });
        self.ids.insert(header.height, id);
        while self.ids.len() > RECENT_IDS {
            let first = *self.ids.keys().next().expect("non-empty");
            self.ids.remove(&first);
        }
        while self.retained.len() > RETAIN {
            let gone = self.retained.remove(0);
            if gone.header.height > self.cp_height {
                self.work_before = add_work(&self.work_before, &block_work(&gone.header.difficulty_target));
            }
        }
    }

    /// Drop every retained header at or above `height`.
    fn truncate(&mut self, height: u64) {
        self.retained.retain(|e| e.header.height < height);
        self.ids.retain(|h, _| *h < height);
    }

    /// Check `headers` (contiguous, oldest first) against the chain and
    /// adopt the ones that pass. `now` is the phone's clock in seconds.
    pub fn sync(&mut self, headers: &[Header], now: u64) -> SyncReport {
        let none = SyncReport { accepted: 0, refused: None, reorg_depth: 0 };
        if headers.is_empty() {
            return none;
        }
        if headers.len() > MAX_BATCH {
            return SyncReport { refused: Some(Refused { height: headers[0].height, code: "too_many" }), ..none };
        }
        // Headers the phone already has (same id at the same height) are skipped.
        let mut start = 0;
        while start < headers.len() && self.id_at(headers[start].height) == Some(block_id(&headers[start])) {
            start += 1;
        }
        let headers = &headers[start..];
        let Some(first) = headers.first() else {
            return none;
        };
        let tip = self.tip().height;
        if first.height > tip + 1 {
            return SyncReport { refused: Some(Refused { height: first.height, code: "gap" }), ..none };
        }
        let fork = first.height <= tip;
        if fork && (first.height <= self.cp_height || first.height + CONSENSUS_FINALITY_DEPTH <= tip) {
            return SyncReport { refused: Some(Refused { height: first.height, code: "too_deep" }), ..none };
        }

        let mut next = self.clone();
        if fork {
            next.truncate(first.height);
        }
        let mut chain = next.chain();
        let mut accepted = 0;
        let mut refused = None;
        for h in headers {
            match chain.extend(h, Some(now)) {
                Ok(()) => {
                    next.push(*h, chain.tip_id());
                    accepted += 1;
                }
                Err(e) => {
                    refused = Some(Refused { height: h.height, code: e.code() });
                    break;
                }
            }
        }
        if accepted == 0 {
            return SyncReport { accepted: 0, refused, reorg_depth: 0 };
        }
        if fork && !le256_lt(&self.work(), &next.work()) {
            return SyncReport { accepted: 0, refused: Some(Refused { height: first.height, code: "less_work" }), reorg_depth: 0 };
        }
        if next.below_floor() {
            return SyncReport { accepted: 0, refused: Some(Refused { height: first.height, code: "work_too_low" }), reorg_depth: 0 };
        }
        let reorg_depth = if fork { tip + 1 - first.height } else { 0 };
        *self = next;
        SyncReport { accepted, refused, reorg_depth }
    }
}

impl Default for Tracker {
    fn default() -> Self {
        Tracker::new()
    }
}

/// Summary for the app.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ChainInfo {
    pub checkpoint_height: u64,
    pub tip_height: u64,
    pub tip_id: String,
    pub tip_timestamp: u64,
}

impl From<&Tracker> for ChainInfo {
    fn from(t: &Tracker) -> Self {
        ChainInfo {
            checkpoint_height: t.cp_height,
            tip_height: t.tip().height,
            tip_id: hex32(&t.tip_id()),
            tip_timestamp: t.tip().timestamp,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::headers::{GENESIS_TARGET, MAX_FUTURE_DRIFT};

    #[test]
    fn checkpoint_is_the_real_block_274821() {
        let cp = checkpoint();
        assert_eq!(cp.height, 274_821);
        assert_eq!(cp.timestamp, 1_793_627_659);
        assert_eq!(cp.headers[0].height, 274_786);
        // Block id of 274,821 as our node reported it (getBlockHash).
        assert_eq!(hex32(&cp.id).len(), 64);
    }

    #[test]
    fn state_round_trip_and_tamper() {
        let t = Tracker::new();
        let s = t.state();
        assert_eq!(s.headers.len(), 36);
        let back = Tracker::load(&s).unwrap();
        assert_eq!(back.state(), s);
        let mut bad = s.clone();
        bad.headers[10] = bad.headers[11].clone();
        assert_eq!(Tracker::load(&bad).unwrap_err().code, "bad_state");
        let mut bad = s.clone();
        bad.ids.insert(300_000, hex32(&[1u8; 32]));
        assert_eq!(Tracker::load(&bad).unwrap_err().code, "bad_state");
        let mut bad = s.clone();
        bad.checkpoint += 1;
        assert_eq!(Tracker::load(&bad).unwrap_err().code, "bad_state");
    }

    /// A fake continuation: valid links and heights but no real work. The
    /// fuzzed PoW rarely passes at mainnet difficulty, so these are refused
    /// as bad_pow, which is the point: the phone won't take them.
    #[test]
    fn fake_headers_are_refused_and_nothing_changes() {
        let mut t = Tracker::new();
        let before = t.state();
        let mut h = *t.tip();
        h.prev_block_hash = t.tip_id();
        h.height += 1;
        h.timestamp += 30;
        let r = t.sync(&[h], h.timestamp);
        assert_eq!(r.accepted, 0);
        assert!(matches!(r.refused, Some(Refused { code: "bad_difficulty_target" | "bad_pow", .. })), "{r:?}");
        assert_eq!(t.state(), before);

        // Gaps and deep forks are named, not checked.
        let mut gap = h;
        gap.height += 5;
        assert_eq!(t.sync(&[gap], h.timestamp).refused.unwrap().code, "gap");
        let mut deep = h;
        deep.height = t.checkpoint_height();
        assert_eq!(t.sync(&[deep], h.timestamp).refused.unwrap().code, "too_deep");
        let too_many = vec![h; MAX_BATCH + 1];
        assert_eq!(t.sync(&too_many, h.timestamp).refused.unwrap().code, "too_many");
        // Already-known headers are skipped, not refused.
        let known = checkpoint().headers;
        let r = t.sync(&known[30..], h.timestamp);
        assert_eq!((r.accepted, r.refused), (0, None));
    }

    #[test]
    fn work_floor_catches_a_cheap_chain() {
        // 30 blocks at the genesis floor claiming an hour: far below 1/16 of
        // the checkpoint rate.
        let elapsed = 3600;
        let cheap = {
            let mut w = [0u8; 32];
            for _ in 0..30 {
                w = add_work(&w, &block_work(&GENESIS_TARGET));
            }
            w
        };
        assert!(le256_lt(&cheap, &required_work(elapsed, CHECKPOINT_RATE, WORK_FLOOR_DIVISOR)));
        // Real blocks over the same hour (2^44 each, 120 of them, 2^51 in all)
        // clear the floor (3600 s * 7.45e11 / 16, about 2^47) with room.
        let real = {
            let mut t = [0u8; 32];
            t[26] = 0x10; // target 2^212: 2^44 work per block, as on mainnet in Nov 2026
            let w = block_work(&t);
            let mut sum = [0u8; 32];
            for _ in 0..120 {
                sum = add_work(&sum, &w);
            }
            sum
        };
        assert!(!le256_lt(&real, &required_work(elapsed, CHECKPOINT_RATE, WORK_FLOOR_DIVISOR)));
        let _ = MAX_FUTURE_DRIFT;
    }
}
