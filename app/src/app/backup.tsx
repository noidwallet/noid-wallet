import { useCallback, useEffect, useRef, useState } from 'react';
import { usePreventScreenCapture } from 'expo-screen-capture';
import { ActivityIndicator, View, type TextInput } from 'react-native';

import { SecretView } from '@/components/SecretView';
import { Banner, Body, Button, Field, KeyValue, Screen, SuccessMark, Title } from '@/components/ui';
import { onRelock } from '@/lib/lockEvents';
import { goBack, useHardwareBack } from '@/lib/nav';
import { storage } from '@/lib/storage';
import { useWallet } from '@/state/wallet';
import { colors, space } from '@/theme';

export default function Backup() {
  usePreventScreenCapture();
  const { meta, confirmUser, markBackedUp } = useWallet();
  const [secret, setSecret] = useState<string | null>(null);
  const [denied, setDenied] = useState(false);
  const [step, setStep] = useState<'show' | 'check' | 'done'>('show');
  // One random early group plus the last one, so a partial copy is caught.
  const [askGroup] = useState(() => 1 + Math.floor(Math.random() * 7));
  const [check, setCheck] = useState('');
  const [check2, setCheck2] = useState('');
  const second = useRef<TextInput>(null);

  // Re-locked from the background: hide the secret until the user confirms again.
  useEffect(
    () =>
      onRelock(() => {
        setSecret(null);
        setDenied(true);
        setStep((s) => (s === 'done' ? s : 'show'));
      }),
    [],
  );

  // Android back on the check step returns to the secret, like the header arrow.
  useHardwareBack(
    useCallback(() => {
      if (step !== 'check') return false;
      setStep('show');
      return true;
    }, [step]),
  );

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

  if (step === 'done') {
    return (
      <Screen footer={<Button title="Done" onPress={() => goBack()} />}>
        <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', gap: space.lg }}>
          <SuccessMark />
          <Title style={{ textAlign: 'center' }}>Backup confirmed</Title>
          <Body muted style={{ textAlign: 'center' }}>Keep your paper copy somewhere safe and private. It’s the only way back in if you lose this phone.</Body>
        </View>
      </Screen>
    );
  }

  if (secret && step === 'check') {
    const groups = secret.match(/.{8}/g) ?? [];
    const ok1 = check.trim().toLowerCase() === groups[askGroup - 1];
    const ok2 = check2.trim().toLowerCase() === groups[7];
    return (
      <Screen
        header={{ title: 'Check your backup', back: () => setStep('show') }}
        footer={
          <Button
            title="Confirm backup"
            disabled={!ok1 || !ok2}
            onPress={async () => {
              await markBackedUp();
              setStep('done');
            }}
          />
        }
      >
        <Body muted>From your paper copy, type group {askGroup} and group 8.</Body>
        <Field
          label={`Group ${askGroup}`}
          mono
          value={check}
          onChangeText={(t) => {
            const v = t.replace(/\s+/g, '');
            setCheck(v);
            if (v.length === 8) second.current?.focus();
          }}
          maxLength={8}
          placeholder="8 characters"
          keyboardType="visible-password"
          autoComplete="off"
          importantForAutofill="no"
          error={check.length === 8 && !ok1 ? 'That does not match. Check your paper copy.' : null}
          hint={ok1 ? '✓ Matches' : null}
        />
        <Field
          ref={second}
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
          hint={ok2 ? '✓ Matches' : null}
        />
      </Screen>
    );
  }

  return (
    <Screen
      header={{ title: 'Your secret' }}
      footer={
        secret ? (
          meta.backedUp ? (
            <Button title="Done" onPress={() => goBack()} />
          ) : (
            <Button title="I wrote it down" onPress={() => setStep('check')} />
          )
        ) : denied ? (
          <Button
            title="Try again"
            onPress={() => {
              setDenied(false);
              return reveal();
            }}
          />
        ) : undefined
      }
    >
      {meta.origin === 'photo' ? (
        <Banner tone="warn" icon="image">
          This wallet came from a photo. An untouched copy of that photo works as a backup, but this written secret is the safer one:
          write it down too.
        </Banner>
      ) : null}
      {denied ? <Body muted>Unlock was cancelled. Your secret stays hidden until you confirm it’s you.</Body> : null}
      {!secret && !denied ? (
        <View style={{ alignItems: 'center', gap: space.md, paddingVertical: space.xxl }}>
          <ActivityIndicator color={colors.accent} />
          <Body muted>Confirm it’s you to see your secret…</Body>
        </View>
      ) : null}
      {secret ? (
        <>
          <Body muted>Write these 64 characters on paper. They restore this wallet on any phone or on the desktop wallet.</Body>
          <SecretView secretHex={secret} />
          <KeyValue label="Wallet ID" value={meta.keyId} />
          <Banner tone="warn">Keep it offline. Don’t screenshot it or paste it into chats or cloud notes.</Banner>
        </>
      ) : null}
    </Screen>
  );
}
