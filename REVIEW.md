# Security review brief: NOID wallet (main branch, 1.0.3 in progress)

NOID is an Android wallet for Parano1d. Keys stay on the phone; the phone
builds and proves every transaction itself (the official GKR authorization
proof) and a small server relays it to a Parano1d node. Releases are at
https://noidusa.com (APK signed with one upload key, fingerprint in
`site/.well-known/assetlinks.json`). This brief describes the main branch;
the latest release may not include the newest changes (see the version in
`app/app.json`).

Thank you for looking. The most useful review is of the Rust core (section 1)
and of the questions in "For the Parano1d developers" below. NOID is made by
Primal (https://x.com/Solid_Primal) and David Peluola
(https://x.com/0xdavee_), who wrote the code. Please report findings
privately (see SECURITY.md), not in public channels.

## Layout

```
core/      Rust wallet core, built for Android (arm64) and called from the app
app/       Expo / React Native app (TypeScript)
backend/   Fastify server: proxies the node's RPC, indexes history, price/FX
site/      Static pages for gift (/g) and payment (/pay) links
```

Official crates are pinned to the Parano1d v2.1.0 release, rev
`848209d5db75137483cb41a94b310ad11463473f` (`core/Cargo.toml`, `Cargo.lock`). Code adapted
from them is marked in `core/src` with the original file it comes from.

## Run the tests

```sh
cd core && cargo test --release      # addresses match the official crates, Photo Key,
                                     # built intents pass validate_paged_spend and
                                     # verify_paged_spend_authorization
cd app && npm ci && npm test && npx tsc --noEmit
cd backend && npm ci && npm test
```

## 1. Rust core (highest priority)

- `core/src/keys.rs`: master secret, spend secrets and addresses
  (port of the official derivation), gift-card secrets (`derive_gift_secret`:
  NOID's own, BLAKE3 `derive_key` over master secret + gift number, so a
  restored wallet can find its unclaimed gifts), Photo Key (image -> secret, pinned image crates so
  pixels decode exactly like noid_gui), address parsing.
- `core/src/tx.rs`:
  - `plan_send`: official coin selection and Auto fee, plus the **NOID
    wallet fee**: an extra output (0.25%, min 0.005, max 0.5 NOID) to a fixed
    address. Recipient + wallet fee + change is 3 outputs, so the third goes
    on a second page (`page_count = max(ceil(inputs/8), ceil(outputs/2))`).
  - `plan_sweep` (gift claims and take-backs: all coins to one output, dust
    skipped, at most 504 inputs), `plan_consolidation`.
  - `build_and_prove`: pages, bitmaps, `prove_paged_spend_authorization`,
    then `validate_paged_spend` on the result before it leaves the core.
- `core/src/fees.rs`: port of the consensus minimum fee.
- `core/src/api.rs`: JSON boundary to the app. Secrets arrive as hex in
  `Zeroizing` strings and never leave except where the user asks (backup,
  gift links).
- `core/src/android.rs`: JNI entry point.

## 2. Secrets on the phone

- `app/src/lib/storage.ts`: secret in Android Keystore-backed SecureStore,
  excluded from backups (`configureAndroidBackup`).
- Unlock and confirmation: `app/src/state/wallet.tsx` (`authenticate`: strong
  biometrics or device PIN; weak biometrics on Android 10 and older, where
  the strong class isn't offered), relock after 60 s in the background, with
  the screen hidden from screen readers while the lock cover is up.
- Screens that show secrets block screenshots: `backup.tsx`, `gift/[index].tsx`.
- Gift links carry the gift secret after `#` (`app/src/lib/links.ts`,
  `site/assets/gift.js`), which browsers never send to a server. Anyone with
  the link can claim the gift; that is the design.

## 3. Sending safely with an untrusted server

The server is not trusted with funds. It can lie about balances, history and
fees, or withhold transactions; it can't spend. Defences in
`app/src/lib/send.ts`:

- Every built transaction is saved before it is submitted. If the answer is
  lost, the same intent is re-sent, never a new one (no double payment).
- A refused payment's coins must be reused by the next payment for at least
  12 h, and longer while the chain height says the refused transaction could
  still be mined (saved on disk; server heights can only extend it), so a
  server that secretly relays a "refused" payment can't make two confirm
  (`checkRefusals`). The next plan is steered to start from a refused coin
  (`steerToRefused`). Only when the refused coins have vanished can the user
  override, after checking Activity. Known gap: the guard covers 12 h or the
  server's reported height, so if blocks slowed to over ~2.5 min on average a
  hidden refused payment could still confirm after it lapses.
- Server answers are checked before use (whole, non-negative amounts; a coin
  list that adds up to the balance) and the server's own error text is never
  shown; the app shows its own (`app/src/lib/api.ts`).
- Amounts typed in a currency use the server's price only while it is fresh
  and within 50% of an anchor price kept on the phone, which follows the
  market at most once a day; a far-off price must hold for 24 h first
  (`app/src/lib/priceGuard.ts`). A server could still walk the price down by
  half a day. The review screen always
  shows the NOID amount and warns when a payment is half the balance or more.
- Release builds talk to servers over https only.
- Fee sanity cap (`feeLooksWrong`); a fee that changes after review is never
  paid silently (`FeeChanged`).
- The wallet fee address and rates are constants in the signed app
  (`app/src/lib/walletFee.ts`), never taken from the server.
- Address-poisoning warnings: first-time and look-alike addresses
  (`app/src/lib/safety.ts`).

## 4. Backend

- `backend/src/rpc.ts`, `server.ts`: only read methods plus submit are
  exposed; the node's RPC port is reachable only by the node and API users
  (`backend/deploy/nftables-noid-rpc.nft`, `noid-rpc-firewall.service`).
- `indexer.ts`: history from retained block bodies.
- Rate limits per IP; behind Caddy (`backend/deploy/Caddyfile`).

## Parano1d v2.1 (activation at block 279,370)

From that block, wallet proofs must use the V4 authorization construction.
`core/src/tx.rs` (`authorization_version`) proves V3 while tip + 1 is below the
activation height and V4 from then on, matching the official wallet's
`owner_authorization_version(candidate_height)`. A V3 transaction still in the
mempool at activation is dropped by the node; NOID's pending logic treats the
refusal as definite and frees its coins. Native-finance transactions (tokens,
DEX, NFTs) show in history as contract activity; their commitment-owned slots
are not anyone's plain NOID.

## Tokens and NFTs (view only)

NOID shows the Parano1d v2.1 tokens and NFTs held by the wallet's address. It
cannot send or trade them yet.

- `backend/src/assets.ts` pages through the node's `getNativeHoldings` and
  `getNativeMarket` (read-only, added to the allow list in `rpc.ts`) and
  fetches public metadata and pictures from the media service
  (`MEDIA_ORIGIN`, default the official `https://tradedata.parano1d.org/`),
  so phones never contact a third party.
- `core/src/assets.rs` decodes every record with the official `noid_tx` types
  and applies the official wallet's checks (`noid_gui/src/assets/live.rs`,
  `catalog.rs`): root, kind and timelock match the opening, the record is
  owned by this address, and it is bound to its State slot. Names, tickers and
  pictures must hash to the commitment in State (`media.rs`: the same domain,
  canonical JSON and limits), and a picture must be the committed PNG size.
- Limit: like the NOID balance, the records come from the server, and the
  phone cannot yet prove they are in the chain's State. The checks catch
  garbled, foreign or mismatched data, and a media service that serves the
  wrong file, but a deliberately dishonest wallet server could still show
  tokens that are not there, leave some out, or present a made-up
  definition (and so a different name) for a token. Nothing is sent or
  signed from these screens. State proofs come with verified headers.
- Tickers are not unique; the token screen says so and shows the token ID.

## Known limits

- Privacy: the server sees which addresses a phone asks about and its IP.
- The server reports balances, coins and history. The app checks shapes,
  sums and its own records (a payment the server calls "confirmed" is only
  forgotten once its coins are gone from the coin list), but cannot yet prove
  what the chain holds. A request's "Paid" mark comes from that history.
- The network fee comes from server-reported load figures. Both the app and
  the core refuse a fee above the consensus minimum at full load plus 0.02
  NOID, and the core refuses any wallet-fee output that differs from the
  built-in address and rule.
- "NOID received" notifications are displayed by Android with text written by
  the official backend (only it holds the Firebase credentials).
- The app lock is enforced by the app; the secret is stored with
  expo-secure-store (Android Keystore encryption) without per-use
  authentication. Copies of the secret passed through the JSON bridge are not
  wiped from Java/JS memory.
- Photo Key refuses TIFF files with JPEG compression and checks every JPEG
  twice (fast and plain decoder) for portability.
- The NOID price can come from CoinPaprika directly from the phone when the
  server is blocked. Like the server's price it converts typed currency
  amounts only when fresh and passing the guard above; "≈" values hide after
  an hour.
- Android 7+ on 64-bit phones only.

## For the Parano1d developers

1. Is a paged spend with 1-8 inputs and 3 outputs (second page has no
   inputs, one output) valid and supported long term? It validates, proves
   and was mined on mainnet (block 239,558, txid
   `cd582d5ca8ce4b194a2e84e914912ca773339f37d1ba24dc5599f37d922df64f`).
2. Anything in the pinned rev that a wallet must not rely on (relay floor
   from `getMempoolStats`, `getSlotHintsSalted`, epoch anchors)?
3. Planned consensus or RPC changes that would break wallets built this way?
4. Gift secrets are full master secrets derived with BLAKE3 `derive_key`
   from the wallet's master secret and a gift number. Anything in the
   official key scheme that makes handing such a derived master secret to
   someone else unsafe?
5. The wallet assumes a built transaction can only be mined until the end of
   the epoch after the one its anchor came from (144-block epochs). It uses
   this to decide when a payment the server called "refused" can no longer
   confirm. Is that right, and could it change?
6. Is a standard planned for websites and apps to connect to a wallet and
   ask it to sign (like WalletConnect)? NOID would support it.
