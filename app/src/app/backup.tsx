import { useEffect, useState } from 'react';
import { router } from 'expo-router';
import { usePreventScreenCapture } from 'expo-screen-capture';

import { Body, Button, KeyValue, Notice, Screen, Title } from '@/components/ui';
import { SecretView } from '@/components/SecretView';
import { storage } from '@/lib/storage';
import { useWallet } from '@/state/wallet';

export default function Backup() {
  usePreventScreenCapture();
  const { meta, confirmUser, markBackedUp } = useWallet();
  const [secret, setSecret] = useState<string | null>(null);
  const [denied, setDenied] = useState(false);

  useEffect(() => {
    (async () => {
      if (!(await confirmUser('Show your wallet secret'))) {
        setDenied(true);
        return;
      }
      setSecret(await storage.readSecret());
    })();
    return () => setSecret(null);
  }, [confirmUser]);

  if (!meta) return null;

  return (
    <Screen>
      <Title>Your wallet secret</Title>
      {meta.origin === 'photo' ? (
        <Notice tone="warn">
          This wallet came from a photo. Keeping an untouched copy of that photo works as a backup, but this secret is
          a safer one: write it down too.
        </Notice>
      ) : null}
      {denied ? <Body muted>Unlock was cancelled.</Body> : null}
      {secret ? (
        <>
          <Body muted>Write these 64 characters on paper. They restore this wallet on any phone or on the desktop wallet.</Body>
          <SecretView secretHex={secret} />
          <KeyValue label="Key fingerprint" value={meta.keyId} />
          <Button
            title="I have it written down"
            onPress={async () => {
              await markBackedUp();
              router.back();
            }}
          />
        </>
      ) : null}
      <Button title="Close" kind="ghost" onPress={() => router.back()} />
    </Screen>
  );
}
