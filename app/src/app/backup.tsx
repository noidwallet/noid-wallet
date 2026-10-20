import { useEffect, useState } from 'react';
import { usePreventScreenCapture } from 'expo-screen-capture';

import { Body, Button, Field, KeyValue, Notice, Screen, Title } from '@/components/ui';
import { SecretView } from '@/components/SecretView';
import { goBack } from '@/lib/nav';
import { storage } from '@/lib/storage';
import { useWallet } from '@/state/wallet';

export default function Backup() {
  usePreventScreenCapture();
  const { meta, confirmUser, markBackedUp } = useWallet();
  const [secret, setSecret] = useState<string | null>(null);
  const [denied, setDenied] = useState(false);
  const [step, setStep] = useState<'show' | 'check'>('show');
  // One random early group plus the last one, so a partial copy is caught.
  const [askGroup] = useState(() => 1 + Math.floor(Math.random() * 7));
  const [check, setCheck] = useState('');
  const [check2, setCheck2] = useState('');

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

  if (secret && step === 'check') {
    const groups = secret.match(/.{8}/g) ?? [];
    const ok1 = check.trim().toLowerCase() === groups[askGroup - 1];
    const ok2 = check2.trim().toLowerCase() === groups[7];
    return (
      <Screen>
        <Title>Check your backup</Title>
        <Body muted>From your paper copy, type group {askGroup} and group 8.</Body>
        <Field
          label={`Group ${askGroup}`}
          mono
          value={check}
          onChangeText={(t) => setCheck(t.replace(/\s+/g, ''))}
          maxLength={8}
          placeholder="8 characters"
          keyboardType="visible-password"
          autoComplete="off"
          importantForAutofill="no"
          error={check.length === 8 && !ok1 ? 'That does not match. Check your paper copy.' : null}
        />
        <Field
          label="Group 8"
          mono
          value={check2}
          onChangeText={(t) => setCheck2(t.replace(/\s+/g, ''))}
          maxLength={8}
          placeholder="8 characters"
          keyboardType="visible-password"
          autoComplete="off"
          importantForAutofill="no"
          error={check2.length === 8 && !ok2 ? 'That does not match. Check your paper copy.' : null}
        />
        <Button
          title="Confirm backup"
          disabled={!ok1 || !ok2}
          onPress={async () => {
            await markBackedUp();
            goBack();
          }}
        />
        <Button title="Show the secret again" kind="ghost" onPress={() => setStep('show')} />
      </Screen>
    );
  }

  return (
    <Screen>
      <Title>Your wallet secret</Title>
      {meta.origin === 'photo' ? (
        <Notice tone="warn">
          This wallet came from a photo. An untouched copy of that photo works as a backup, but this written secret is the
          safer one: write it down too.
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
          <KeyValue label="Wallet ID" value={meta.keyId} />
          <Notice tone="warn">Keep it offline. Do not screenshot it or paste it into chats or cloud notes.</Notice>
          {meta.backedUp ? (
            <Button title="Done" onPress={() => goBack()} />
          ) : (
            <Button title="I wrote it down" onPress={() => setStep('check')} />
          )}
        </>
      ) : null}
      <Button title="Close" kind="ghost" onPress={() => goBack()} />
    </Screen>
  );
}
