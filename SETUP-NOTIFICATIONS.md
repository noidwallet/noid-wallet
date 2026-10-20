# Turn on "NOID received" notifications

NOID works without this. Notifications need a free Firebase project, because
Android delivers push messages through Firebase Cloud Messaging (FCM).

## 1. Create the Firebase project (once)
1. Go to https://console.firebase.google.com and create a project (e.g. `noid-wallet`).
   Google Analytics is not needed.
2. Add an **Android app** with package name `com.dpeluola.noid`.
3. Download **google-services.json** and put it in `app\` (next to `app.json`).
   It is listed in `.gitignore`. It is not a secret, but keep it out of public repos.

## 2. Server key for sending (once)
1. Firebase console → Project settings → **Service accounts** → **Generate new private key**.
2. Copy that JSON file to the server, readable only by the `noid` user:
   ```sh
   sudo mkdir -p /etc/noid
   sudo install -o noid -g noid -m 600 firebase-service-account.json /etc/noid/
   ```
   This file IS secret: it can send notifications as your app. Never commit it.
3. In `/etc/systemd/system/noid-wallet-api.service`, uncomment the
   `FCM_SERVICE_ACCOUNT` line, then:
   ```sh
   sudo systemctl daemon-reload && sudo systemctl restart noid-wallet-api
   ```
   `GET /v1/status` then shows `"features": { "push": true, ... }`.

## 3. Rebuild the app (google-services.json is read at build time)
```powershell
cd C:\dev\noid\app
npx expo prebuild --platform android --clean
npx expo run:android --device
```

In the app: **Settings → Notifications → Turn on notifications**.

## Privacy
Turning notifications on tells your wallet server which phone to notify for
your public address. It never receives your secret. Turning them off, or
removing the wallet from the phone, deletes that link on the server.
