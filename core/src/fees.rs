//! Consensus minimum fee. Port of noid_chain/src/consensus/fees.rs so the
//! phone can plan fees without the full node crate. Constants come from
//! noid_chain/src/consensus/params.rs (v2.0.4).

use serde::Serialize;

pub const MIN_FEE_BASE: u64 = 5_000;
pub const FEE_PER_INPUT: u64 = 100;
pub const FEE_PER_OUTPUT: u64 = 700;
pub const STATE_GROWTH_FEE_BASE: u64 = 2_500;
const PRESSURE_LOW_BPS: u64 = 5_000;
const PRESSURE_HIGH_BPS: u64 = 7_500;
const PRESSURE_EXTREME_BPS: u64 = 9_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FeeBreakdown {
    pub base: u64,
    pub input: u64,
    pub output: u64,
    pub state_growth: u64,
    pub required_total: u64,
    pub burned: u64,
}

pub fn occupancy_bps(active_slot_count: u64, log_slots: u32) -> u64 {
    let capacity = 1u128.checked_shl(log_slots).unwrap_or(u128::MAX).max(1);
    ((active_slot_count as u128).saturating_mul(10_000) / capacity) as u64
}

pub fn pressure_multiplier(active_slot_count: u64, log_slots: u32) -> u64 {
    match occupancy_bps(active_slot_count, log_slots) {
        bps if bps >= PRESSURE_EXTREME_BPS => 8,
        bps if bps >= PRESSURE_HIGH_BPS => 4,
        bps if bps >= PRESSURE_LOW_BPS => 2,
        _ => 1,
    }
}

pub fn fee_breakdown(n_inputs: u64, n_outputs: u64, active_slot_count: u64, log_slots: u32) -> FeeBreakdown {
    let net_new_slots = n_outputs.saturating_sub(n_inputs);
    let input = FEE_PER_INPUT.saturating_mul(n_inputs);
    let output = FEE_PER_OUTPUT.saturating_mul(n_outputs);
    let state_growth = STATE_GROWTH_FEE_BASE
        .saturating_mul(pressure_multiplier(active_slot_count, log_slots))
        .saturating_mul(net_new_slots);
    let required_total = MIN_FEE_BASE.saturating_add(input).saturating_add(output).saturating_add(state_growth);
    FeeBreakdown { base: MIN_FEE_BASE, input, output, state_growth, required_total, burned: state_growth }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_documented_examples() {
        // 1 input -> recipient + change at <50% occupancy: 5000 + 100 + 1400 + 2500.
        assert_eq!(fee_breakdown(1, 2, 0, 24).required_total, 9_000);
        // Consolidation never pays state growth.
        let c = fee_breakdown(10, 1, 0, 24);
        assert_eq!((c.state_growth, c.required_total), (0, 5_000 + 1_000 + 700));
        // Pressure tiers.
        let cap = 1u64 << 10;
        assert_eq!(pressure_multiplier(cap / 2, 10), 2);
        assert_eq!(pressure_multiplier(cap * 3 / 4, 10), 4);
        assert_eq!(pressure_multiplier(cap * 9 / 10 + 1, 10), 8);
        assert_eq!(fee_breakdown(1, 2, cap * 3 / 4, 10).state_growth, 10_000);
    }
}
