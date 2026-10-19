import { useEffect, useState } from 'react';
import { router } from 'expo-router';
import { Text } from 'react-native';

import { Body, Button, Card, Field, KeyValue, Notice, Screen, Title } from '@/components/ui';
import { core } from '@/lib/core';
import { useWallet } from '@/state/wallet';
import { colors, space } from '@/theme';

const ORIGIN = { generated: 'Created on this phone', imported: 'Restored from secret', photo: 'Photo Key' } as const;

export default function Settings() {
  const w = useWallet();
  const [version, setVersion] = useState('');
  const [confirmRemove, setConfirmRemove] = useState('');

  useEffect(() => {
    core.version().then((v) => setVersion(`core ${v.core} · parano1d ${v.parano1dRev.slice(0, 7)}`), () => {});
  }, []);

  if (!w.meta) return null;


  return (
    <Screen>
      <Title>Settings</Title>

      <Card>
        <KeyValue label="Wallet" value={ORIGIN[w.meta.origin]} mono={false} />
        <KeyValue label="Fingerprint" value={w.meta.keyId} />
        <KeyValue label="Backup" value={w.meta.backedUp ? 'Confirmed' : 'Not confirmed'} mono={false} />
      </Card>
      <Button title="Show my secret" kind="secondary" onPress={() => router.push('/backup')} />

      <Button title={`Wallet server · ${w.settings.apiUrl.replace(/^https?:\/\//, '')}`} kind="secondary" onPress={() => router.push('/server')} />
      <Body muted style={{ fontSize: 14 }}>
        The server only sees your public address and finished transactions. Your secret never leaves this phone.
      </Body>

      <Card style={{ borderColor: colors.danger }}>
        <Text style={{ color: colors.danger, fontWeight: '700', fontSize: 16 }}>Remove wallet from this phone</Text>
        {w.meta.backedUp ? (
          <Body muted style={{ fontSize: 14 }}>
            Your NOID stays on the network, but you can only get back in with your secret. Type REMOVE to confirm.
          </Body>
        ) : (
          <Notice tone="danger">
            You have not confirmed a backup of this wallet’s secret. Removing it now would lose your NOID for good. Back it
            up first with Show my secret.
          </Notice>
        )}
        <Field value={confirmRemove} onChangeText={setConfirmRemove} placeholder="REMOVE" autoCapitalize="characters" />
        <Button
          title="Remove wallet"
          kind="danger"
          disabled={confirmRemove !== 'REMOVE' || !w.meta.backedUp}
          onPress={async () => {
            if (!(await w.confirmUser('Remove this wallet'))) return;
            await w.removeWallet();
            router.replace('/welcome');
          }}
        />
      </Card>

      <Text style={{ color: colors.faint, fontSize: 12, marginTop: space.md }}>{version}</Text>
      <Button title="Back" kind="ghost" onPress={() => router.back()} />
    </Screen>
  );
}
