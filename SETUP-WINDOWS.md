# Build and run NOID on Windows

This gets the app running on your Android phone from your Windows PC. The
one-time setup takes about an hour (mostly downloads). After that, a rebuild
is one command.

You will install: Git, Node.js 22+, Visual Studio C++ Build Tools, Rust,
Android Studio (with SDK 36 and NDK), and a JDK 17.

**Keep the project in a short folder such as `C:\dev\noid`.** The Android
build creates very deep file paths, and Windows build tools fail on paths
over 260 characters (`Filename longer than 260 characters`). A folder under
`C:\Users\<you>\Projects\...` is already too deep.

---

## 1. One-time tools

Open **PowerShell as Administrator** for installs.

### Git
Install from https://git-scm.com/download/win, then turn on long paths
(the Parano1d source has deep folders):
```powershell
git config --global core.longpaths true
```

### Node.js 22 or newer
Check with `node -v`. If it is older than 22, install the LTS from https://nodejs.org.

### Visual Studio Build Tools (C++)
Rust on Windows needs Microsoft's linker for its build scripts.
Install **Build Tools for Visual Studio** from
https://visualstudio.microsoft.com/visual-cpp-build-tools/ and tick
**Desktop development with C++**.

### Rust + Android targets + cargo-ndk
Install Rust from https://rustup.rs (accept the defaults), open a **new**
terminal, then:
```powershell
rustup target add aarch64-linux-android x86_64-linux-android
cargo install cargo-ndk
```

### JDK 17
With Chocolatey (https://chocolatey.org/install):
```powershell
choco install -y microsoft-openjdk17
```

### Android Studio, SDK and NDK
1. Install Android Studio from https://developer.android.com/studio. Pick the
   **Standard** setup and accept all licenses.
2. Open **Settings > Languages & Frameworks > Android SDK**:
   - **SDK Platforms** tab: tick **Android SDK Platform 36**.
   - **SDK Tools** tab: tick **Show Package Details**, then under
     **NDK (Side by side)** tick **27.1.12297006**. Also tick **Android SDK
     Build-Tools 36.0.0** and **Android SDK Platform-Tools**. Click Apply.

### Environment variables
Windows search > **Edit environment variables for your account**.

**New variables.** Under *User variables*, click **New…** for each of these:

| Variable name | Variable value |
|---|---|
| `ANDROID_HOME` | `%LOCALAPPDATA%\Android\Sdk` |
| `ANDROID_NDK_HOME` | `%LOCALAPPDATA%\Android\Sdk\ndk\27.1.12297006` |

**Path: edit it, do not create it.** `Path` already exists, and it holds
other tools such as Rust's `cargo`. Making a new variable called `path`
replaces it and breaks them.
1. Under *User variables*, click the existing **Path** row, then **Edit…**.
2. In the list that opens, click **New** and paste
   `%LOCALAPPDATA%\Android\Sdk\platform-tools`.
3. Click **OK** on every window.

Close and reopen PowerShell, then check:
```powershell
adb --version
cargo ndk --version
java -version     # should say 17
```

---

## 2. Check the Rust wallet core on your PC

From the project folder:
```powershell
cd core
cargo test --release
```
The first build downloads the official Parano1d crates from GitHub and takes
a few minutes. You should see **`15 passed`**. These tests confirm:
- your addresses match the official v2.0.4 node,
- Photo Key gives the same key as the desktop wallet,
- a built transaction passes the official proof verifier,
- mined coins (64-bit IDs) are spent correctly.

---

## 3. Build the core for Android

```powershell
cd ..\app
npm install
npm run core:android
```
This compiles the core for phones (arm64) and the emulator (x86_64) and puts
`libnoid_mobile_core.so` into `app\modules\noid-core\android\src\main\jniLibs\`.
Run it again whenever anything in `core\` changes.

---

## 4. Connect your phone

1. On the phone: **Settings > About phone**, tap **Build number** 7 times.
2. **Settings > Developer options**, turn on **USB debugging**.
3. Plug the phone into the PC and accept the "Allow USB debugging" prompt.
4. Check:
   ```powershell
   adb devices
   ```
   Your phone should show as `device`.

---

## 5. Build and install the app

```powershell
npm run android -- --device
```
Pick your phone from the list. The first build takes 10–20 minutes. Later
builds are much faster. The app opens on your phone and stays connected to
your PC for live reloading of JavaScript changes.

This development build installs as a separate app, **NOID Dev**
(`com.dpeluola.noid.dev`), so it never touches the release app and the real
wallet in it. To make the signed APK you give to people, see
[SETUP-RELEASE.md](SETUP-RELEASE.md).

---

## 6. Point the app at a wallet server

The app needs the backend (`backend\`) and a synced Parano1d node.

**Testing at home (no server yet):**
1. Run the official node on your PC: download `parano1d-core-…-windows-x86_64.zip`
   from https://github.com/proof-native/parano1d/releases, verify it against
   `SHA256SUMS`, and start `parano1d.exe`. Wait until it syncs.
2. In another terminal:
   ```powershell
   cd backend
   npm install
   $env:HOST="0.0.0.0"; npm run dev
   ```
3. Find your PC's Wi-Fi IP (`ipconfig`, e.g. `192.168.1.20`). In the app open
   **Settings > Wallet server**, enter `http://192.168.1.20:8787`, and tap
   **Test and save server**. Phone and PC must be on the same Wi-Fi.

**Production:** deploy the backend to your VPS with HTTPS (see
`backend\README.md`), then set the default server in `app\app.json` under
`extra.defaultApiUrl`.

---

## 7. First real test

1. Restore your wallet on the phone with the secret from the desktop wallet
   (**Export** in the desktop app). The fingerprint must match.
2. Send **1 NOID** to a second address of yours.
3. Watch it confirm in **Activity**. The send screen shows how long the proof
   took on your phone.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| `linker 'link.exe' not found` | Install the C++ Build Tools (step 1) and reopen the terminal. |
| `Could not find any NDK` from cargo-ndk | Check `ANDROID_NDK_HOME` points to the NDK folder that exists. |
| `Filename longer than 260 characters` (ninja, during `buildCMakeDebug`) or filename too long in `cargo`/`git` | Move the project to a short path like `C:\dev\noid`, then in `app` run `npx expo prebuild --platform android --clean` and build again. Also run `git config --global core.longpaths true`. |
| App crashes on start with `couldn't find libnoid_mobile_core.so` | Run `npm run core:android` before `npx expo run:android`. |
| `adb devices` shows `unauthorized` | Unlock the phone and accept the USB debugging prompt. |
| App says it cannot reach the wallet server | Phone and PC on the same Wi-Fi, backend started with `HOST=0.0.0.0`, Windows Firewall allows port 8787. |
