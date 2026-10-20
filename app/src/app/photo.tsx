import { useEffect, useState } from 'react';
import * as DocumentPicker from 'expo-document-picker';
import { File } from 'expo-file-system';
import { usePreventScreenCapture } from 'expo-screen-capture';
import { Text, View } from 'react-native';

import { Icon, type IconName } from '@/components/Icon';
import { Banner, Body, Button, Card, KeyValue, Pill, Screen, Title } from '@/components/ui';
import { shortAddress } from '@/lib/amount';
import { core, type NewKey } from '@/lib/core';
import { goRoot } from '@/lib/nav';
import { nextRoute } from '@/lib/scan';
import { useWallet } from '@/state/wallet';
import { colors, space, type } from '@/theme';

export default function Photo() {
  usePreventScreenCapture('photo');
  const { createWallet } = useWallet();
  const [key, setKey] = useState<(NewKey & { width: number; height: number; name: string }) | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);
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

  const POINTS: { icon: IconName; text: string }[] = [
    { icon: 'image', text: 'Use a private photo you have never shared. Anyone with the same file can spend your NOID.' },
    { icon: 'warning', text: 'Editing, cropping or losing the photo loses the wallet. Keep an untouched copy offline.' },
    { icon: 'key', text: 'You will also write down the 64-character secret, the safest backup.' },
  ];

  async function useWallet_() {
    if (!key) return;
    setCreating(true);
    try {
      await createWallet(key.secretHex, 'photo');
      // The written backup is the safe one: ask for it right away.
      nextRoute.set('/backup');
      goRoot();
    } catch (e) {
      setError((e as Error).message);
      setCreating(false);
    }
  }

  return (
    <Screen
      header={{ title: 'Photo Key' }}
      footer={
        supported === false ? undefined : key ? (
          <>
            <Button title="Use this wallet" busy={creating} disabled={busy} onPress={useWallet_} />
            <Button title="Pick a different photo" kind="tertiary" busy={busy} disabled={creating} onPress={pick} />
          </>
        ) : (
          <Button title={supported === null ? 'Checking this phone…' : 'Choose photo'} icon="image" busy={busy} disabled={!supported} onPress={pick} />
        )
      }
    >
      <Pill text="Advanced" tone="warn" />
      <Title>Use a photo as your key</Title>
      <Body muted>
        A photo’s pixels become your wallet secret, exactly like Photo Key in the desktop wallet. The photo is read on this phone and
        never uploaded.
      </Body>
      <View style={{ gap: space.md }}>
        {POINTS.map((pt) => (
          <View key={pt.text} style={{ flexDirection: 'row', gap: space.md }}>
            <Icon name={pt.icon} size={20} color={colors.warn} />
            <Text style={[type.bodySm, { flex: 1, color: colors.text }]}>{pt.text}</Text>
          </View>
        ))}
      </View>
      {supported === false ? (
        <Banner tone="danger">
          This phone doesn’t reproduce the desktop wallet’s Photo Key test exactly, so a photo wouldn’t give the same wallet
          everywhere. Create a wallet with a written secret instead.
        </Banner>
      ) : null}
      {supported !== false && key ? (
        <Card>
          <KeyValue label="Photo" value={key.name} mono={false} />
          <KeyValue label="Size" value={`${key.width} × ${key.height}`} />
          <KeyValue label="Wallet ID" value={key.keyId} />
          <KeyValue label="First address" value={shortAddress(key.address)} />
        </Card>
      ) : null}
      {error ? <Banner tone="danger">{error}</Banner> : null}
    </Screen>
  );
}
