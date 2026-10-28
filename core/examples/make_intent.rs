//! Dev tool: build a send intent with the mobile core.
//! cargo run --release --example make_intent -- <epoch_anchor_hex> <hint1> <hint2> [slot] [creation_id] [value] [tip_height]
fn main() {
    let a: Vec<String> = std::env::args().collect();
    let anchor = &a[1];
    let (h1, h2): (u32, u32) = (a[2].parse().unwrap(), a[3].parse().unwrap());
    let slot: u32 = a.get(4).map(|s| s.parse().unwrap()).unwrap_or(5);
    let creation: u64 = a.get(5).map(|s| s.parse().unwrap()).unwrap_or(9);
    let value: u64 = a.get(6).map(|s| s.parse().unwrap()).unwrap_or(2_000_000);
    let tip: u64 = a.get(7).map(|s| s.parse().unwrap()).unwrap_or(0);
    let args = serde_json::json!({
        "secretHex": "0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20",
        "keyIndex": 0,
        "utxos": [{ "slotIndex": slot, "value": value, "creationId": creation }],
        "selectedSlots": [slot],
        "to": "o1e7mkgm5cm9ngrexup6wpgkzzy9qzp25fwl223epu2llkpa7ftz9sx0fcsx",
        "amount": 1_000_000u64,
        "fee": 9_000u64,
        "epochAnchorHex": anchor,
        "slotHints": [h1, h2],
        "tipHeight": tip,
    });
    println!("{}", noid_mobile_core::call("buildTransaction", &args.to_string()));
}
