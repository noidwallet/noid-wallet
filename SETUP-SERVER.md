# Put NOID online (Contabo + noidusa.com)

The server runs three things: a Parano1d node, the wallet API (`api.noidusa.com`)
and the link pages (`noidusa.com`). Commands are copy-paste. Replace
`SERVER_IP` with the IP from Contabo's email everywhere below.

Where each block runs is marked:
- **PC** = PowerShell on your Windows PC
- **Server** = after `ssh root@SERVER_IP`

Never paste the root password, your SSH private key or any wallet secret into
a chat, a website or a support ticket.

---

## 1. First login and SSH key (about 5 min)

**PC** (first time: type `yes` to trust the server, then the root password):
```powershell
ssh root@SERVER_IP
```
Type `exit` to come back to the PC, then copy your public key to the server:
```powershell
type $env:USERPROFILE\.ssh\id_ed25519.pub | ssh root@SERVER_IP "mkdir -p ~/.ssh && chmod 700 ~/.ssh && cat >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys"
```
Check it: `ssh root@SERVER_IP` should now ask for your **key passphrase**, not the
root password.

**Server** — turn off password logins (bots try them all day):
```sh
cat > /etc/ssh/sshd_config.d/00-noid.conf <<'EOF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
EOF
sshd -t && systemctl restart ssh
```
Keep this window open and test from a **new** PowerShell window that
`ssh root@SERVER_IP` still gets in. Only then close the old one.

## 2. Updates, firewall, users (about 5 min)

**Server**:
```sh
apt update && DEBIAN_FRONTEND=noninteractive apt -y full-upgrade
apt install -y curl ca-certificates gnupg ufw nftables sqlite3 build-essential python3 unattended-upgrades
dpkg-reconfigure -f noninteractive unattended-upgrades

# Firewall: SSH, HTTPS and the node's P2P port only
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443
ufw allow 9600/tcp
ufw --force enable
ufw status

# The node and the API run as different users, so the API can't read the node's files
useradd --system --create-home noid
useradd --system --no-create-home --shell /usr/sbin/nologin noidapi
mkdir -p /opt/parano1d /var/lib/parano1d /var/lib/noid-wallet /opt/noid-wallet-backend /var/www/noid-site /etc/noid
chown noid:noid /var/lib/parano1d
chown noidapi:noidapi /var/lib/noid-wallet
install -d -o noid -g noid -m 700 /home/noid/.parano1d
```
If the upgrade says a reboot is needed: `reboot`, wait a minute, `ssh root@SERVER_IP` again.

## 3. Copy the NOID code to the server (about 2 min)

**PC**:
```powershell
cd C:\dev\noid
tar --exclude=node_modules --exclude=data --exclude=dist -czf noid-deploy.tgz backend site
scp noid-deploy.tgz root@SERVER_IP:/root/
```

**Server**:
```sh
mkdir -p /root/noid && tar xzf /root/noid-deploy.tgz -C /root/noid
cp -r /root/noid/backend/. /opt/noid-wallet-backend/
cp -r /root/noid/site/. /var/www/noid-site/
```

## 4. RPC lock (before the node starts)

The node gives owner rights to any local program on its RPC port. This rule
lets only the node and the wallet API use it, and loads after ufw at every boot.

**Server**:
```sh
cp /opt/noid-wallet-backend/deploy/nftables-noid-rpc.nft /etc/noid/
cp /opt/noid-wallet-backend/deploy/noid-rpc-firewall.service /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now noid-rpc-firewall
nft list table inet noid_rpc      # must show the rule
ufw status                        # must still say: active
```

## 5. The Parano1d node (download 2 min, then it syncs)

**Server** — official release, checked against its SHA256SUMS:
```sh
cd /root
REL=$(curl -fsSL https://api.github.com/repos/proof-native/parano1d/releases/latest)
echo "$REL" | grep -o '"tag_name": *"[^"]*"'
URLS=$(echo "$REL" | grep -o '"browser_download_url": *"[^"]*"' | cut -d'"' -f4)
echo "$URLS"                                           # every file in the release
CORE=$(echo "$URLS" | grep -i 'linux-x86_64' | grep -i '\.tar\.gz$' | grep -vi gui | head -1)
SUMS=$(echo "$URLS" | grep -i 'SHA256SUMS' | grep -viE '\.(asc|sig|minisig)$' | head -1)
echo "CORE=$CORE"; echo "SUMS=$SUMS"                   # both must be filled in
curl -fLO "$CORE" && curl -fLO "$SUMS"
sha256sum -c --ignore-missing "$(basename "$SUMS")"     # the archive line must say: OK
```
Stop if it doesn't say OK. Then install and check the CPU:
```sh
rm -rf /tmp/p1 && mkdir /tmp/p1 && tar xzf "$(basename "$CORE")" -C /tmp/p1
install -m 755 "$(find /tmp/p1 -type f -name parano1d -perm -u+x | head -1)" /opt/parano1d/parano1d
install -m 755 "$(find /tmp/p1 -type f -name parano1d-cli -perm -u+x | head -1)" /opt/parano1d/parano1d-cli
/opt/parano1d/parano1d --check-hardware        # must end with NODE READY
```
Start it:
```sh
cp /opt/noid-wallet-backend/deploy/parano1d.service /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now parano1d
journalctl -u parano1d -f        # Ctrl+C to stop watching; the node keeps running
```
Check progress (only the node and API users may use the RPC port now):
```sh
sudo -u noidapi curl -s -X POST 127.0.0.1:9601 -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"paranoid_getChainInfo","params":[]}'
```
Wait until its height matches your desktop wallet's height.

## 6. The wallet API

**Server** — Node.js 22, then build:
```sh
curl -fsSL https://deb.nodesource.com/setup_22.x -o /tmp/nodesource_setup.sh && bash /tmp/nodesource_setup.sh
apt install -y nodejs && node -v          # v22.x
cd /opt/noid-wallet-backend && npm ci && npm run build
npm run price-check                       # shows each price source and the exchange rates
```
Price sites often refuse data-centre servers (`HTTP 403`). That's fine: the
exchange rates must work (`fx` lines), and phones then fetch the NOID price
themselves.

**Keep your Activity history (recommended).** The node only keeps the last 42
blocks (about 17 minutes), so the new server's history starts when its API
starts. To carry over the history your PC has indexed, do this once the server
node is synced, and finish within ~15 minutes:

1. **PC**: stop the local backend (Ctrl+C in its window), then:
   ```powershell
   cd C:\dev\noid\backend\data
   Get-ChildItem wallet-index.sqlite* | ForEach-Object { scp $_.FullName root@SERVER_IP:/var/lib/noid-wallet/ }
   ```
2. **Server**:
   ```sh
   chown noidapi:noidapi /var/lib/noid-wallet/*
   ```
3. Start the API right away (next block).

Skipping this is fine too: history then starts from today on the new server.

**Server** — start the API:
```sh
cp /opt/noid-wallet-backend/deploy/noid-wallet-api.service /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now noid-wallet-api
sleep 3 && curl -s 127.0.0.1:8787/v1/status && echo
journalctl -u noid-wallet-api -n 30 --no-pager
```

## 7. DNS at GoDaddy

GoDaddy → My Products → `noidusa.com` → **DNS** → Manage:

| Type | Name | Value | TTL |
|---|---|---|---|
| A | `@` | `SERVER_IP` | 600 seconds |
| A | `api` | `SERVER_IP` | 600 seconds |
| CNAME | `www` | `@` (usually already there) | 1 hour |

Delete GoDaddy's default **Parked** A record for `@`, and turn off any
**Forwarding** for the domain. Don't add AAAA (IPv6) records for now.

Check from the **PC** (can take a few minutes to an hour):
```powershell
Resolve-DnsName api.noidusa.com -Type A
Resolve-DnsName noidusa.com -Type A
```
Both must show `SERVER_IP`.

## 8. HTTPS and the website (Caddy)

**Server** — Caddy's official package, then our config:
```sh
apt install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
apt update && apt install -y caddy
cp /opt/noid-wallet-backend/deploy/Caddyfile /etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile && systemctl reload caddy
journalctl -u caddy -n 30 --no-pager      # look for "certificate obtained successfully"
```
Do this after DNS points at the server, or Caddy can't get certificates (it
retries by itself, so it also fixes itself once DNS is right).

## 9. Check everything

**PC**:
```powershell
curl.exe -s https://api.noidusa.com/v1/status
curl.exe -s https://api.noidusa.com/v1/fx
```
(`/v1/price` may answer `price_unavailable` when price sites block the
server; the app then gets the NOID price on the phone.)
Open `https://noidusa.com` in a browser. In the app: **Settings → Wallet server**
→ `https://api.noidusa.com` → Test and save. Then send yourself a small payment.

## 10. Nightly backup of the history database

**Server**:
```sh
mkdir -p /var/backups/noid
cat > /etc/cron.daily/noid-index-backup <<'EOF'
#!/bin/sh
sqlite3 /var/lib/noid-wallet/wallet-index.sqlite ".backup '/var/backups/noid/wallet-index-$(date +%F).sqlite'"
find /var/backups/noid -name 'wallet-index-*.sqlite' -mtime +7 -delete
EOF
chmod 755 /etc/cron.daily/noid-index-backup
```
Now and then, copy the newest one to your PC (**PC**):
`scp root@SERVER_IP:/var/backups/noid/wallet-index-*.sqlite C:\dev\noid\backups\`

## Updating later

New NOID code: repeat step 3, then on the **Server**:
```sh
cd /opt/noid-wallet-backend && npm ci && npm run build && systemctl restart noid-wallet-api
```
New Parano1d release: repeat step 5's download, check and `install` lines, then
`systemctl restart parano1d`.
