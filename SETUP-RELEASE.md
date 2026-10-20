# Release APK (signed, for anyone to install)

The release app is signed with **your own upload key**. Android only installs
an update when it is signed with the same key, so this key is what makes NOID
updates trustworthy:

- **Lose it** and you can never update the app again. Everyone would have to
  uninstall and restore their wallet.
- **Leak it** (file plus password) and someone could sign a fake "update".

Development builds are separate: they install as **NOID Dev**
(`com.dpeluola.noid.dev`) with the debug key, next to the real app.

Everything below runs in **PowerShell on your PC**. Never paste the key's
password or the `.jks` file into a chat, a website or a ticket. The
fingerprint in step 4 is public and fine to share.

---

## 1. Create the upload key (once)

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\.noid" | Out-Null
keytool -genkeypair -v -storetype PKCS12 -keystore "$env:USERPROFILE\.noid\noid-release.jks" -alias noid -keyalg RSA -keysize 4096 -validity 10000 -dname "CN=NOID wallet, O=dpeluola, C=NG"
```
It asks for a password twice. Use a long one and save it in your password
manager first. The `-dname` details are public: anyone can read them from
the APK.

## 2. Back up the key (once)

Copy `%USERPROFILE%\.noid\noid-release.jks` to **two** places off this PC, for
example a USB drive kept at home and an attachment in your password manager.
Keep the password with it.

## 3. Tell the build where the key is (once)

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\.gradle" | Out-Null
notepad "$env:USERPROFILE\.gradle\gradle.properties"
```
Add these four lines, using **forward slashes** in the path and your real
Windows user name, then save:
```
NOID_UPLOAD_STORE_FILE=C:/Users/YOUR_NAME/.noid/noid-release.jks
NOID_UPLOAD_KEY_ALIAS=noid
NOID_UPLOAD_STORE_PASSWORD=your-key-password
NOID_UPLOAD_KEY_PASSWORD=your-key-password
```
This file sits in your user folder, outside the project, so it never ends up
in git or a backup of the code.

## 4. The key's fingerprint (for app links)

```powershell
keytool -list -v -keystore "$env:USERPROFILE\.noid\noid-release.jks" -alias noid | Select-String "SHA256:"
```
This goes into `site/.well-known/assetlinks.json`, so `noidusa.com/pay` and
`/g` links open straight in NOID.

## 5. Build the APK

```powershell
cd C:\dev\noid\app
npx expo prebuild -p android --clean
cd android
.\gradlew assembleRelease
```
The first release build takes a while. The APK is at
`app\android\app\build\outputs\apk\release\app-release.apk`.

Check that it carries your key. The SHA-256 line must match step 4:
```powershell
& "$env:ANDROID_HOME\build-tools\36.0.0\apksigner.bat" verify --print-certs app\build\outputs\apk\release\app-release.apk
Get-FileHash app\build\outputs\apk\release\app-release.apk
```
The second line is the APK's own SHA-256, published on the site so people can
check their download.

## 6. Install on your phone

**First time only.** The NOID on your phone now is a development build,
signed with the debug key, so Android refuses to put the release over it.
Before removing it:
1. Make sure your wallet secret (Photo Key or words) is backed up and you can
   find it.
2. Take back any gift cards nobody has claimed yet: the list of gifts stays
   on the phone and goes with the app.
3. Note any contacts you want to keep.

Then uninstall NOID, install the release and restore your wallet:
```powershell
adb install app\build\outputs\apk\release\app-release.apk
```

## Every later release

1. In `app/app.json`, raise `android.versionCode` by 1 (and `version`, e.g.
   `1.0.1`). Android won't install an update with the same or a lower code.
2. If anything in `core/` changed: `npm run core:android`.
3. Repeat step 5, then publish the APK and its hash.

Updates install over the existing app and keep the wallet.

## Problems

| Problem | Fix |
|---|---|
| `SigningConfig "release" is missing required property "storeFile"` | Step 3 is missing or has a typo. Check the path uses `/`. |
| `Keystore was tampered with, or password was incorrect` | The password in `gradle.properties` doesn't match the key. |
| `prebuild --clean` can't delete `android` | Run `.\gradlew --stop` inside `app\android`, close Android Studio, try again. |
| `INSTALL_FAILED_UPDATE_INCOMPATIBLE` | A NOID signed with another key is installed. See step 6. |
