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
```sh
# 1. user + folders
sudo useradd --system --create-home noid
sudo mkdir -p /opt/parano1d /var/lib/parano1d /var/lib/noid-wallet /opt/noid-wallet-backend
sudo chown noid:noid /var/lib/parano1d /var/lib/noid-wallet

# 2. node: download the official Core release + SHA256SUMS from
#    https://github.com/proof-native/parano1d/releases and verify
sha256sum -c --ignore-missing SHA256SUMS
sudo tar xzf parano1d-core-v*-linux-x86_64.tar.gz -C /opt/parano1d
/opt/parano1d/parano1d --check-hardware        # must end with NODE READY

# 3. API
sudo apt install -y nodejs npm caddy            # Node 22+ (use NodeSource if the distro's is older)
# copy this folder to /opt/noid-wallet-backend, then:
cd /opt/noid-wallet-backend && npm ci && npm run build

# 4. services + HTTPS
sudo cp deploy/*.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now parano1d noid-wallet-api
sudo cp deploy/Caddyfile /etc/caddy/Caddyfile   # edit the domain first
sudo systemctl reload caddy

# 5. firewall: only SSH, HTTPS and P2P
sudo ufw allow OpenSSH && sudo ufw allow 443/tcp && sudo ufw allow 9600/tcp && sudo ufw enable
```

Check: `curl https://api.yourdomain.com/v1/status` shows `"synced": true` once the node catches up.
