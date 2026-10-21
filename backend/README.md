# NOID wallet backend

Small API that sits next to your own Parano1d node. The phone never talks to
the node directly, and the node's wallet/spend methods are never reachable.

| Endpoint | What it does |
|---|---|
| `GET /v1/status` | Height, sync state, fee context (`activeSlotCount`, `logSlots`, `relayFloor`) |
| `GET /v1/address/:address/utxos` | Live coins of an address (from `getSlotsByOwner`) |
| `POST /v1/prepare` | Epoch anchor + free output slots + fee context, in one call |
| `POST /v1/submit` | Relays a finished, already-proven intent (`submitTxIntent`) |
| `GET /v1/tx/:txid` | `pending` / `confirmed` (+ confirmations) / `unknown` |
| `GET /v1/address/:address/history` | Indexed history (the node itself keeps only 42 blocks) |

Security boundary: `src/rpc.ts` holds a fixed allow-list of node methods.
The node treats any local caller as the wallet owner (it will run
`walletSend`), so never add `wallet*`, `stop`, mining or contract methods,
and never forward a method name chosen by a client.

## Run locally
```sh
npm install
NOID_RPC_URL=http://127.0.0.1:9601 npm run dev
npm test
```

## Deploy (Ubuntu 24.04, e.g. Contabo Cloud VPS 20)
Install it on a server by following [SETUP-SERVER.md](../SETUP-SERVER.md):
it sets up the RPC lock and firewall before the node and API start, the
users and permissions, HTTPS with Caddy, and backups.

Check: `curl https://api.yourdomain.com/v1/status` shows `"synced": true` once the node catches up.
