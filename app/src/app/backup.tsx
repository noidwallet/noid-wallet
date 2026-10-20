import { useEffect, useState } from 'react';
import { usePreventScreenCapture } from 'expo-screen-capture';

import { Body, Button, KeyValue, Notice, Screen, Title } from '@/components/ui';
import { SecretView } from '@/components/SecretView';
import { goBack } from '@/lib/nav';
import { storage } from '@/lib/storage';
import { useWallet } from '@/state/wallet';

export default function Backup() {
  usePreventScreenCapture();
  const { meta, confirmUser, markBackedUp } = useWallet();
  const [secret, setSecret] = useState<string | null>(null);
  const [denied, setDenied] = useState(false);

  async function reveal() {
    if (!(await confirmUser('Show your wallet secret'))) {
      setDenied(true);
      return;
    }
    setSecret(await storage.readSecret());
  }

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
      {denied ? (
        <>
          <Body muted>Unlock was cancelled. Your secret stays hidden until you confirm it is you.</Body>
          <Button
            title="Try again"
            onPress={() => {
              setDenied(false);
              return reveal();
            }}
          />
        </>
      ) : null}
      {secret ? (
        <>
          <Body muted>Write these 64 characters on paper. They restore this wallet on any phone or on the desktop wallet.</Body>
          <SecretView secretHex={secret} />
          <KeyValue label="Key fingerprint" value={meta.keyId} />
          <Button
            title="I have it written down"
            onPress={async () => {
              await markBackedUp();
              goBack();
            }}
          />
        </>
      ) : null}
      <Button title="Close" kind="ghost" onPress={() => goBack()} />
    </Screen>
  );
}
