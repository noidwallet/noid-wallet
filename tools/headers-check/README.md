# headers-check

NOID 1.2 lets the phone check block headers itself. The rules live in
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

## Results (Nov 4, 2026)

All checks agree, including 5,106 real mainnet headers after the built-in
checkpoint: blocks 274,822 to 279,927, across the v2.1 activation at
279,370. Earlier run (Nov 2): blocks 210,537 to 210,620 (the v2 switch) and
274,457 to 274,821.

What the real headers show about mainnet difficulty:

- About 2^44 hashes per block (2.2 x 10^13), roughly 80 million times the
  genesis floor. Network rate at the checkpoint about 7.5 x 10^11 Poseidon2b
  hashes per second, average block about 30 s.
- ASERT really does ease fast after a gap. Block 279,458 came 994 s after
  its parent (Nov 4, 04:51 UTC, about an hour after v2.1 activated), so block
  279,459 was 41x easier, and the following dozens of blocks were cheap and
  fast while the target recovered. Both the official code and the phone
  accept this stretch. An earlier phone design (no more than 4x easing per
  block, and a 19-block work floor at 1/8 of the checkpoint rate) refused
  it; the first phone test caught that.
- So the phone accepts cheap blocks that pass consensus and instead counts a
  block as checked only once it is 8 deep with at least 120 s of
  checkpoint-rate work on top. On these headers "counted as checked"
  trails the tip by 8 blocks normally and by at most 38 during the recovery
  after block 279,458.
- A floor on total work since the shipped checkpoint (1/16 of the
  checkpoint rate) still stops a whole fake chain from the checkpoint.
