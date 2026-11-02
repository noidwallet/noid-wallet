# headers-check

NOID 1.1 lets the phone check block headers itself. The rules live in
`core/src/headers.rs`, a port of the official `noid_chain` crate (Parano1d
v2.1.0, rev 848209d). `noid_chain` can't be built for Android, so this tool
runs both side by side on the host and stops at the first difference.

What it checks:

1. Random and edge-case inputs (default 50,000 rounds, `ROUNDS=` to change):
   wire format, block id, PoW digest, ASERT target, anchor height, v2
   interval schedule, median time past, `log_slots` expansion, block work.
2. A freshly mined chain with real Poseidon2b proof of work (default 40
   headers, `BLOCKS=` to change), including a `log_slots` expansion, plus a
   short chain across the v2 activation (block 210,537). Each header is
   also changed in 7 ways (nonce, parent link, height, target, timestamp,
   `log_slots`, state root); both sides must refuse each one for the same
   reason, and a refused header must not move the phone's tip.
3. Optional: real mainnet headers from a file.

```
cargo run --release
cargo run --release -- headers.jsonl
```

## Getting real headers from the server

The node's RPC port only answers the `noid` and `noidapi` users, so run the
requests as `noidapi`. Headers are public data. This fetches the blocks
around the v2 activation and the latest 400:

```
sudo -u noidapi bash -c '
rpc() { curl -s -X POST http://127.0.0.1:9601 -H "content-type: application/json" \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"paranoid_$1\",\"params\":[$2]}"; }
tip=$(rpc blockCount "" | grep -o "\"result\":[0-9]*" | cut -d: -f2)
for h in $(seq 210501 210620) $(seq $((tip-400)) $tip); do rpc getHeaderByHeight $h; echo; done
' > /root/headers.jsonl
wc -l /root/headers.jsonl
```
