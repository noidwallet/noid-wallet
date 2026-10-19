# NOID Wallet

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

Build and run: see [SETUP-WINDOWS.md](SETUP-WINDOWS.md).

## License
Apache-2.0. Includes code adapted from Parano1d (Apache-2.0); see NOTICE.
