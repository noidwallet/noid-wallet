import { useCallback, useEffect, useState } from 'react';
import { usePreventScreenCapture } from 'expo-screen-capture';

import { Body, Button, Field, KeyValue, Notice, Screen, Title } from '@/components/ui';
import { SecretView } from '@/components/SecretView';
import { core, type NewKey } from '@/lib/core';
import { goBack, goRoot, useHardwareBack } from '@/lib/nav';
import { useWallet } from '@/state/wallet';

export default function Create() {
  usePreventScreenCapture();
  const { createWallet } = useWallet();
  const [key, setKey] = useState<NewKey | null>(null);
  const [step, setStep] = useState<'show' | 'confirm'>('show');
  const [check, setCheck] = useState('');
  const [check2, setCheck2] = useState('');
  // Ask for one random early group plus the last one, so a partial copy is caught.
  const [askGroup] = useState(() => 1 + Math.floor(Math.random() * 7));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Android back from the check step returns to the secret, not out of setup.
  useHardwareBack(
    useCallback(() => {
      if (step !== 'confirm' || busy) return busy;
      setStep('show');
      return true;
    }, [step, busy]),
  );

  useEffect(() => {
    core.generateSecret().then(setKey, (e: Error) => setError(e.message));
  }, []);

  if (!key) {
    return (
      <Screen>
        <Title>Creating your wallet…</Title>
        {error ? <Notice tone="danger">{error}</Notice> : null}
        <Button title="Back" kind="ghost" onPress={() => goBack()} />
      </Screen>
    );
  }

  if (step === 'show') {
    return (
      <Screen>
        <Title>Write down your secret</Title>
        <Body muted>
          These 64 characters are your wallet. Anyone who has them can spend your NOID. If you lose this phone,
          they are the only way back in. There is no recovery service.
        </Body>
        <SecretView secretHex={key.secretHex} />
        <KeyValue label="Key fingerprint" value={key.keyId} />
        <Notice tone="warn">
          Write it on paper and keep it offline. Do not screenshot it or paste it into chats or cloud notes.
        </Notice>
        <Button title="I wrote it down" onPress={() => setStep('confirm')} />
        <Button title="Cancel" kind="ghost" onPress={() => goBack()} />
      </Screen>
    );
  }

  const groups = key.secretHex.match(/.{8}/g) ?? [];
  const ok1 = check.trim().toLowerCase() === groups[askGroup - 1];
  const ok2 = check2.trim().toLowerCase() === groups[7];
  const ok = ok1 && ok2;
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
        title="Create wallet"
        disabled={!ok}
        busy={busy}
        onPress={async () => {
          setBusy(true);
          try {
            await createWallet(key.secretHex, 'generated');
            goRoot();
          } catch (e) {
            setError((e as Error).message);
            setBusy(false);
          }
        }}
      />
      <Button title="Show the secret again" kind="ghost" onPress={() => setStep('show')} />
      {error ? <Notice tone="danger">{error}</Notice> : null}
    </Screen>
  );
}
