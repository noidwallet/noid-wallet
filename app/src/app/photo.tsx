import { useEffect, useState } from 'react';
import * as DocumentPicker from 'expo-document-picker';
import { File } from 'expo-file-system';
import { usePreventScreenCapture } from 'expo-screen-capture';

import { Body, Button, Card, KeyValue, Notice, Screen, Title } from '@/components/ui';
import { shortAddress } from '@/lib/amount';
import { core, type NewKey } from '@/lib/core';
import { goBack, goRoot } from '@/lib/nav';
import { nextRoute } from '@/lib/scan';
import { useWallet } from '@/state/wallet';

export default function Photo() {
  usePreventScreenCapture();
  const { createWallet } = useWallet();
  const [key, setKey] = useState<(NewKey & { width: number; height: number; name: string }) | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // null = checking, true = this phone derives the same keys as the desktop wallet.
  const [supported, setSupported] = useState<boolean | null>(null);

  useEffect(() => {
    core.photoKeySelfTest().then(
      (r) => setSupported(r.ok),
      () => setSupported(false),
    );
  }, []);

  async function pick() {
    setError(null);
    // The document picker hands over the original file. An image picker can
    // re-compress the photo, which would change its pixels and the wallet.
    const res = await DocumentPicker.getDocumentAsync({ type: 'image/*', copyToCacheDirectory: true });
    if (res.canceled || !res.assets?.[0]) return;
    const asset = res.assets[0];
    setBusy(true);
    try {
      const path = decodeURIComponent(asset.uri.replace(/^file:\/\//, ''));
      const derived = await core.photoKey(path);
      setKey({ ...derived, name: asset.name });
    } catch (e) {
      setKey(null);
      setError((e as Error).message);
    } finally {
      try {
        new File(asset.uri).delete();
      } catch {
        // The cache copy may already be gone; nothing to clean up.
      }
      setBusy(false);
    }
  }

  return (
    <Screen>
      <Title>Use a photo as your key</Title>
      <Body muted>
        Pick a private photo. Its pixels become your wallet secret, exactly like Photo Key in the desktop wallet. The
        photo is read on this phone and never uploaded.
      </Body>
      <Notice tone="warn">
        After this you will also write down the wallet’s 64-character secret. The photo is your wallet. Anyone with the same file can spend your NOID, and if you edit, crop, or lose it, the
        wallet is gone. Use a photo you have never shared, and keep an untouched copy offline.
      </Notice>
      {supported === false ? (
        <Notice tone="danger">
          This phone does not reproduce the desktop wallet’s Photo Key test exactly, so a photo would not give the same
          wallet everywhere. Create a wallet with a written secret instead.
        </Notice>
      ) : null}
      {supported === false ? null : key ? (
        <>
          <Card>
            <KeyValue label="Photo" value={key.name} mono={false} />
            <KeyValue label="Size" value={`${key.width} × ${key.height}`} />
            <KeyValue label="Wallet ID" value={key.keyId} />
            <KeyValue label="First address" value={shortAddress(key.address)} />
          </Card>
          <Button
            title="Use this wallet"
            busy={busy}
            onPress={async () => {
              setBusy(true);
              try {
                await createWallet(key.secretHex, 'photo');
                // The written backup is the safe one: ask for it right away.
                nextRoute.set('/backup');
                goRoot();
              } catch (e) {
                setError((e as Error).message);
                setBusy(false);
              }
            }}
          />
          <Button title="Pick a different photo" kind="ghost" onPress={pick} />
        </>
      ) : (
        <Button title={supported === null ? 'Checking this phone…' : 'Choose photo'} busy={busy} disabled={!supported} onPress={pick} />
      )}
      {error ? <Notice tone="danger">{error}</Notice> : null}
      <Button title="Back" kind="ghost" onPress={() => goBack()} />
    </Screen>
  );
}
