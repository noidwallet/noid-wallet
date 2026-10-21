# NOID

Android wallet for the [Parano1d](https://parano1d.org) (NOID) network. A light
wallet: no full node on the phone. Keys and zero-knowledge proofs stay on the
device. A small server you run relays finished transactions and keeps history.

```
core/      Rust wallet core: keys, Photo Key, fee planning, tx building, proof
           (reuses the official Parano1d crates; tested against v2.0.4)
app/       React Native + Expo (SDK 57) Android app; core loaded over JNI
backend/   TypeScript API next to your node: safe-method proxy + history indexer
```

**How a send works**

1. The app reads your coins (`/v1/address/:a/utxos`) and the current fee rules.
2. The core plans the send the same way the official wallet does (exact coin
   first, then largest first, Auto fee).
3. You review the amount, fee and coins used.
4. The core builds the PagedSpend and forges the authorization proof on the
   phone. Your secret never leaves the core.
5. The backend relays the finished intent with `submitTxIntent`.

**Security notes**
- The master secret is stored only in Android Keystore-backed SecureStore,
  excluded from cloud backup. Opening the app, sending, revealing the secret
  and removing the wallet all require the phone's own lock (fingerprint/face
  or PIN/pattern). A phone with no screen lock gets a permanent warning.
- No double payments: every built transaction is saved before it is sent. If
  the reply is lost, the wallet re-sends that same transaction (same coins,
  same txid) and blocks new sends until the network answers. It never builds
  a replacement for a send whose outcome is unknown.
- Secret screens block screenshots; secret fields opt out of keyboard
  learning and autofill; a wallet without a confirmed backup cannot be removed.
- The backend can only call an allow-list of read methods plus
  `submitTxIntent`, and never sees keys. The app requires https (plain http
  only for a test server on your own Wi-Fi).
- Mined coins carry 64-bit IDs beyond JavaScript's number range; they travel
  as strings end to end.
- Photo Key decodes the original file in Rust with the exact decoder versions
  the desktop wallet uses. On each phone, a self-test re-derives the desktop
  wallet's published test key, and every JPEG is decoded twice (fast CPU path
  and plain path) and refused if a single pixel differs. Photo wallets still
  ask for a written backup of the 64-character secret.

**Features**
- Gift cards: send NOID as a link or QR anyone can claim into their own NOID
  wallet. Each gift is a small wallet whose secret is derived from yours, so a
  restored wallet can find and take back unclaimed gifts. The secret travels
  after `#` in the link, which browsers never send to a server. Gift numbers
  are never reused, and a gift address is checked unused before it is funded.
- Payment requests: amount + note as a link, QR or a branded card image for
  WhatsApp, Telegram, Discord or X; NOID fills in the send. The request screen
  turns to "Paid ✓" when the money is in your own history (screenshots from
  the payer are never proof).
- Contacts, with warnings for first-time and look-alike addresses
  (address-poisoning protection).
- Values in 41 currencies (NOID price from SafeTrade via your server, or
  fetched by the phone when the server is blocked; rates from a public FX
  feed), and amounts can be typed in your currency.
- NOID wallet fee: 0.25% of each send or new gift card (at least 0.005, at
  most 0.5 NOID), paid as its own output in the same transaction and shown on
  the review screen. The fee address and rates live in
  `app/src/lib/walletFee.ts`, inside the signed app, so a wallet server can't
  change or redirect them. Receiving, claims, take-backs and merges are free.
- First-run safety slides (common scams, official links; the links come from
  `extra.officialLinks` in `app/app.json`).
- Opt-in "NOID received" notifications (see SETUP-NOTIFICATIONS.md).

`site/` holds the pages that gift (`/g`) and payment (`/pay`) links open on
your domain, with link-preview images for chat apps (redraw them with
`python3 tools/make-og-images.py`).

Build and run: see [SETUP-WINDOWS.md](SETUP-WINDOWS.md). Put it online on a
server and your domain: see [SETUP-SERVER.md](SETUP-SERVER.md).

## License
Apache-2.0. Includes code adapted from Parano1d (Apache-2.0); see NOTICE.
