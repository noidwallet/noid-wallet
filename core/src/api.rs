//! JSON API used by the app: `call(method, args_json) -> result_json`.
//! Success: `{"ok": <result>}`. Failure: `{"error": {"code", "message"}}`.
//! Amounts are integer μNOID (1 NOID = 1,000,000 μNOID).

use std::collections::HashSet;
use std::path::PathBuf;

use serde::de::DeserializeOwned;
use serde::Deserialize;
use serde_json::{json, Value};
use zeroize::Zeroizing;

use crate::keys::{parse_address, photo_key_from_path, photo_key_self_test, MasterSecret, MAX_WALLET_ADDRESSES};
use crate::tx::{self, FeeContext, Utxo};
use crate::Error;

pub fn call(method: &str, args_json: &str) -> String {
    let result = std::panic::catch_unwind(|| dispatch(method, args_json));
    let value = match result {
        Ok(Ok(ok)) => json!({ "ok": ok }),
        Ok(Err(e)) => json!({ "error": { "code": e.code, "message": e.message } }),
        Err(_) => json!({ "error": { "code": "panic", "message": "The wallet core hit an unexpected error." } }),
    };
    value.to_string()
}

fn args<T: DeserializeOwned>(json: &str) -> Result<T, Error> {
    serde_json::from_str(if json.trim().is_empty() { "{}" } else { json })
        .map_err(|e| Error::msg(format!("Bad request: {e}")))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SecretArgs {
    secret_hex: Zeroizing<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeriveArgs {
    secret_hex: Zeroizing<String>,
    #[serde(default)]
    start: u32,
    #[serde(default = "one")]
    count: u32,
}
fn one() -> u32 {
    1
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FeeArgs {
    active_slot_count: u64,
    log_slots: u32,
    #[serde(default)]
    relay_floor: u64,
}
impl From<&FeeArgs> for FeeContext {
    fn from(a: &FeeArgs) -> Self {
        FeeContext { active_slot_count: a.active_slot_count, log_slots: a.log_slots, relay_floor: a.relay_floor }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PlanSendArgs {
    utxos: Vec<Utxo>,
    #[serde(default)]
    pending_input_slots: Vec<u32>,
    amount: u64,
    fee: Option<u64>,
    /// NOID wallet fee in μNOID (0 or missing: none).
    #[serde(default)]
    wallet_fee: u64,
    #[serde(flatten)]
    fees: FeeArgs,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PlanConsolidationArgs {
    utxos: Vec<Utxo>,
    #[serde(default)]
    pending_input_slots: Vec<u32>,
    max_inputs: Option<usize>,
    #[serde(flatten)]
    fees: FeeArgs,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BuildArgs {
    secret_hex: Zeroizing<String>,
    key_index: u32,
    utxos: Vec<Utxo>,
    selected_slots: Vec<u32>,
    to: Option<String>,
    amount: u64,
    /// NOID wallet fee output: amount (μNOID) and the fee address.
    #[serde(default)]
    wallet_fee: u64,
    wallet_fee_to: Option<String>,
    fee: u64,
    epoch_anchor_hex: String,
    slot_hints: Vec<u32>,
    #[serde(default)]
    pending_output_slots: Vec<u32>,
}

fn dispatch(method: &str, json: &str) -> Result<Value, Error> {
    match method {
        "version" => Ok(json!({
            "core": env!("CARGO_PKG_VERSION"),
            "parano1dRev": "5302b3f303f1b26e0a6a3de6f6d15aad7b3161ea",
            "photoKey": "v1",
        })),

        "generateSecret" => {
            let secret = MasterSecret::generate();
            Ok(json!({ "secretHex": secret.to_hex().as_str(), "keyId": secret.key_id(), "address": secret.derive_address(0).to_bech32() }))
        }

        "inspectSecret" => {
            let a: SecretArgs = args(json)?;
            let secret = MasterSecret::from_hex(&a.secret_hex)?;
            Ok(json!({ "keyId": secret.key_id(), "address": secret.derive_address(0).to_bech32() }))
        }

        "photoKeySelfTest" => Ok(json!({ "ok": photo_key_self_test()? })),

        "photoKey" => {
            #[derive(Deserialize)]
            struct A {
                path: String,
            }
            let a: A = args(json)?;
            let path = PathBuf::from(a.path.trim_start_matches("file://"));
            let key = photo_key_from_path(&path)?;
            Ok(json!({
                "secretHex": key.secret.to_hex().as_str(),
                "keyId": key.secret.key_id(),
                "address": key.secret.derive_address(0).to_bech32(),
                "width": key.width,
                "height": key.height,
            }))
        }

        "deriveAddresses" => {
            let a: DeriveArgs = args(json)?;
            let secret = MasterSecret::from_hex(&a.secret_hex)?;
            let end = a.start.saturating_add(a.count.min(100)).min(MAX_WALLET_ADDRESSES);
            let list: Vec<Value> = (a.start..end)
                .map(|i| json!({ "index": i, "address": secret.derive_address(i).to_bech32() }))
                .collect();
            Ok(Value::Array(list))
        }

        "validateAddress" => {
            #[derive(Deserialize)]
            struct A {
                address: String,
            }
            let a: A = args(json)?;
            Ok(match parse_address(&a.address) {
                Ok(addr) => json!({ "valid": true, "address": addr.to_bech32() }),
                Err(e) => json!({ "valid": false, "error": e.message }),
            })
        }

        "feeBreakdown" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct A {
                inputs: u64,
                outputs: u64,
                #[serde(flatten)]
                fees: FeeArgs,
            }
            let a: A = args(json)?;
            let b = crate::fees::fee_breakdown(a.inputs, a.outputs, a.fees.active_slot_count, a.fees.log_slots);
            Ok(json!({ "breakdown": b, "minimum": b.required_total.max(a.fees.relay_floor) }))
        }

        "planSend" => {
            let a: PlanSendArgs = args(json)?;
            let pending: HashSet<u32> = a.pending_input_slots.into_iter().collect();
            let plan = tx::plan_send(&a.utxos, &pending, a.amount, a.fee, (&a.fees).into(), a.wallet_fee)?;
            Ok(serde_json::to_value(plan).unwrap())
        }

        // Gift card `index` of this wallet: its secret (goes into the link) and address.
        "giftKey" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct A {
                secret_hex: Zeroizing<String>,
                index: u32,
            }
            let a: A = args(json)?;
            let gift = MasterSecret::from_hex(&a.secret_hex)?.derive_gift_secret(a.index);
            Ok(json!({ "giftSecretHex": *gift.to_hex(), "address": gift.derive_address(0).to_bech32(), "index": a.index }))
        }

        // Addresses of gift cards start..start+count, for finding gifts after a restore.
        "giftAddresses" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct A {
                secret_hex: Zeroizing<String>,
                start: u32,
                count: u32,
            }
            let a: A = args(json)?;
            if a.count == 0 || a.count > 200 {
                return Err(Error::msg("Ask for between 1 and 200 gift addresses."));
            }
            let master = MasterSecret::from_hex(&a.secret_hex)?;
            let list: Vec<Value> = (a.start..a.start.saturating_add(a.count))
                .map(|i| json!({ "index": i, "address": master.derive_gift_secret(i).derive_address(0).to_bech32() }))
                .collect();
            Ok(Value::Array(list))
        }

        "planSweep" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct A {
                utxos: Vec<Utxo>,
                #[serde(default)]
                pending_input_slots: Vec<u32>,
                #[serde(flatten)]
                fees: FeeArgs,
            }
            let a: A = args(json)?;
            let pending: HashSet<u32> = a.pending_input_slots.into_iter().collect();
            let plan = tx::plan_sweep(&a.utxos, &pending, (&a.fees).into())?;
            Ok(serde_json::to_value(plan).unwrap())
        }

        "planConsolidation" => {
            let a: PlanConsolidationArgs = args(json)?;
            let pending: HashSet<u32> = a.pending_input_slots.into_iter().collect();
            let plan = tx::plan_consolidation(
                &a.utxos,
                &pending,
                a.max_inputs.unwrap_or(tx::MAX_CONSOLIDATION_INPUTS),
                (&a.fees).into(),
            )?;
            Ok(serde_json::to_value(plan).unwrap())
        }

        // Payment when `to` is set; consolidation (pay to self, no change) when not.
        "buildTransaction" => {
            let a: BuildArgs = args(json)?;
            let exact = a.to.is_none();
            let secret = MasterSecret::from_hex(&a.secret_hex)?;
            let to = match &a.to {
                Some(addr) => parse_address(addr)?,
                None => secret.derive_address(a.key_index),
            };
            let mut anchor = [0u8; 32];
            hex::decode_to_slice(a.epoch_anchor_hex.trim(), &mut anchor)
                .map_err(|_| Error::msg("The network returned an invalid epoch anchor."))?;
            let pending_out: HashSet<u32> = a.pending_output_slots.into_iter().collect();
            let hints: Vec<u32> = a.slot_hints.into_iter().filter(|s| !pending_out.contains(s)).collect();
            let wallet_fee = match (a.wallet_fee, &a.wallet_fee_to) {
                (0, _) => None,
                (v, Some(addr)) => Some((parse_address(addr)?, v)),
                (_, None) => return Err(Error::msg("A wallet fee needs its fee address.")),
            };
            let inputs = tx::take_selected(&a.utxos, &a.selected_slots)?;
            let built = tx::build_and_prove(tx::BuildRequest {
                secret: &secret,
                key_index: a.key_index,
                inputs,
                to,
                amount: a.amount,
                wallet_fee,
                fee: a.fee,
                epoch_anchor: anchor,
                output_slot_hints: hints,
                exact,
            })?;
            Ok(serde_json::to_value(built).unwrap())
        }

        _ => Err(Error::msg(format!("Unknown method: {method}"))),
    }
}

#[cfg(test)]
mod tests {

    #[test]
    fn gift_keys_through_json() {
        let secret = "01".repeat(32);
        let g = ok("giftKey", json!({ "secretHex": secret, "index": 3 }));
        let list = ok("giftAddresses", json!({ "secretHex": secret, "start": 0, "count": 5 }));
        assert_eq!(list.as_array().unwrap().len(), 5);
        assert_eq!(list[3]["address"], g["address"]);
        // The gift secret is itself a wallet whose first address is the gift address.
        let inspected = ok("inspectSecret", json!({ "secretHex": g["giftSecretHex"] }));
        assert_eq!(inspected["address"], g["address"]);
        assert_ne!(g["giftSecretHex"], json!(secret));
    }
    use super::*;

    fn ok(method: &str, a: Value) -> Value {
        let out: Value = serde_json::from_str(&call(method, &a.to_string())).unwrap();
        assert!(out.get("error").is_none(), "{method} failed: {out}");
        out["ok"].clone()
    }

    #[test]
    fn end_to_end_send_through_json() {
        let secret = "0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20";
        let me = ok("inspectSecret", json!({ "secretHex": secret }));
        assert_eq!(me["address"], "o1wrznmh6td3mgg9mu0a3kkxxn2lnfu827uykrnpaa90mex8su9zcs5sjxrk");

        let utxos = json!([{ "slotIndex": 5, "value": 2_000_000, "creationId": 9 }]);
        let fee_ctx = json!({ "activeSlotCount": 0, "logSlots": 24, "relayFloor": 5000 });
        let mut plan_args = json!({ "utxos": utxos, "amount": 1_000_000, "fee": null });
        plan_args.as_object_mut().unwrap().extend(fee_ctx.as_object().unwrap().clone());
        let plan = ok("planSend", plan_args);
        assert_eq!(plan["fee"], 9000);

        let built = ok(
            "buildTransaction",
            json!({
                "secretHex": secret, "keyIndex": 0, "utxos": utxos,
                "selectedSlots": plan["selectedSlots"], "to": "o1e7mkgm5cm9ngrexup6wpgkzzy9qzp25fwl223epu2llkpa7ftz9sx0fcsx",
                "amount": 1_000_000, "fee": plan["fee"],
                "epochAnchorHex": "860e70453390bf815718e933aa4927167a13d098b0151391eefd722ee1add610",
                "slotHints": [9710654, 9710655],
            }),
        );
        assert_eq!(built["fee"], 9000);
        assert_eq!(built["outputCount"], 2);
        assert!(built["intentHex"].as_str().unwrap().starts_with("a3"));
    }

    #[test]
    fn app_wallet_fee_address_is_valid() {
        // Must match app/src/lib/walletFee.ts WALLET_FEE_ADDRESS.
        let v = ok("validateAddress", json!({ "address": "o155fsn6m5au9ardteuw0qc77agzzp6a99c8j5k60qumdwus5ajwesf9magf" }));
        assert_eq!(v["valid"], true, "{v}");
        assert_eq!(v["address"], "o155fsn6m5au9ardteuw0qc77agzzp6a99c8j5k60qumdwus5ajwesf9magf");
    }

    #[test]
    fn errors_are_structured() {
        let out: Value = serde_json::from_str(&call("inspectSecret", r#"{"secretHex":"nope"}"#)).unwrap();
        assert!(out["error"]["message"].as_str().unwrap().contains("64 hexadecimal"));
        let out: Value = serde_json::from_str(&call("nope", "")).unwrap();
        assert!(out["error"].is_object());
    }
}
