# Turn on "NOID received" notifications

NOID works without this. Notifications need a free Firebase project, because
Android delivers push messages through Firebase Cloud Messaging (FCM).

## 1. Create the Firebase project (once)
1. Go to https://console.firebase.google.com and create a project (e.g. `noid-wallet`).
   Google Analytics is not needed.
2. Add an **Android app** with package name `com.dpeluola.noid` (the release app).
3. Add a second **Android app** with package name `com.dpeluola.noid.dev`
   (NOID Dev, the development build). Without it, development builds fail with
   "No matching client found for package name".
4. Download **google-services.json** (after adding both apps, so it lists both)
   and put it in `app\` (next to `app.json`).
   It is listed in `.gitignore`. It is not a secret, but keep it out of public repos.

## 2. Server key for sending (once)
1. Firebase console → Project settings → **Service accounts** → **Generate new private key**.
   (Tighter, recommended: in Google Cloud console → IAM → Service accounts,
   create an account with only the **Firebase Cloud Messaging API Admin**
   role and use its key instead. The default key above can manage the whole
   Firebase project, so a leak would expose more than notifications.)
2. Copy that JSON file to the server, readable only by root (systemd hands it
   to the wallet API privately through `LoadCredential`, so no other user,
   not even the node's, needs to read it):
   ```sh
   sudo mkdir -p /etc/noid
   sudo install -o root -g root -m 600 firebase-service-account.json /etc/noid/
   ```
   This file IS secret: it can send notifications as your app. Never commit it.
3. Switch notifications on with a drop-in, so copying the main service file
   again later never turns them off:
   ```sh
   sudo install -D -m 644 /opt/noid-wallet-backend/deploy/noid-wallet-api-push.conf /etc/systemd/system/noid-wallet-api.service.d/push.conf
   sudo systemctl daemon-reload && sudo systemctl restart noid-wallet-api
   ```
   `GET /v1/status` then shows `"features": { "push": true, ... }`.

## 3. Rebuild the app (google-services.json is read at build time)
Release APK (raise `android.versionCode` in `app/app.json` first, see
SETUP-RELEASE.md):
```powershell
cd C:\dev\noid\app
npx expo prebuild -p android --clean
cd android
.\gradlew assembleRelease
```
Development build (NOID Dev): `npm run android -- --device`.

In the app: **Settings → Notifications → Turn on notifications**.

## Privacy
Turning notifications on tells your wallet server which phone to notify for
your public address. It never receives your secret. Turning them off, or
removing the wallet from the phone, deletes that link on the server and
retires the phone's notification token. If the app is simply uninstalled, the
link stays until Google reports the token gone or 60 days pass without the
app renewing it. Google delivers each notification and sees its text (the
amount); a transaction id in it points to your address on the public chain.
