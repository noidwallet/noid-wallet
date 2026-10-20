import { useCallback, useEffect, useRef, useState } from 'react';
import { usePreventScreenCapture } from 'expo-screen-capture';
import { ActivityIndicator, Pressable, Text, View, type TextInput } from 'react-native';

import { Icon } from '@/components/Icon';
import { SecretView } from '@/components/SecretView';
import { Banner, Body, Button, Field, KeyValue, Screen, Title } from '@/components/ui';
import { core, type NewKey } from '@/lib/core';
import { goRoot, useHardwareBack } from '@/lib/nav';
import { useWallet } from '@/state/wallet';
import { colors, space, type } from '@/theme';

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
  const [revealed, setRevealed] = useState(false);
  const second = useRef<TextInput>(null);

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
      <Screen header={{ title: 'New wallet' }}>
        <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', gap: space.md }}>
          {error ? <Banner tone="danger">{error}</Banner> : <ActivityIndicator color={colors.accent} size="large" />}
          {!error ? <Body muted>Creating your wallet…</Body> : null}
          {error ? (
            <Button
              title="Try again"
              kind="secondary"
              onPress={() => {
                setError(null);
                core.generateSecret().then(setKey, (e: Error) => setError(e.message));
              }}
            />
          ) : null}
        </View>
      </Screen>
    );
  }

  if (step === 'show') {
    return (
      <Screen header={{ title: 'Step 1 of 2' }} footer={<Button title="I wrote it down" disabled={!revealed} onPress={() => setStep('confirm')} />}>
        <StepBar step={1} />
        <Title>Write down your secret</Title>
        <Body muted>
          These 64 characters are your wallet. Anyone who has them can spend your NOID. If you lose this phone, they are the only
          way back in. There is no recovery service.
        </Body>
        {revealed ? (
          <SecretView secretHex={key.secretHex} />
        ) : (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Reveal your secret"
            onPress={() => setRevealed(true)}
            style={({ pressed }) => ({
              minHeight: 180,
              borderRadius: 20,
              borderWidth: 1,
              borderColor: colors.lineStrong,
              backgroundColor: pressed ? colors.s2 : colors.s1,
              alignItems: 'center',
              justifyContent: 'center',
              gap: space.sm,
            })}
          >
            <Icon name="key" size={28} color={colors.accent} />
            <Text style={type.title}>Tap to reveal</Text>
            <Text style={type.bodySm}>Make sure nobody is looking at your screen</Text>
          </Pressable>
        )}
        <KeyValue label="Wallet ID" value={key.keyId} />
        <Banner tone="warn">Write it on paper and keep it offline. Don’t screenshot it or paste it into chats or cloud notes.</Banner>
      </Screen>
    );
  }

  const groups = key.secretHex.match(/.{8}/g) ?? [];
  const ok1 = check.trim().toLowerCase() === groups[askGroup - 1];
  const ok2 = check2.trim().toLowerCase() === groups[7];
  const ok = ok1 && ok2;
  return (
    <Screen
      header={{ title: 'Step 2 of 2', back: () => (busy ? undefined : setStep('show')) }}
      footer={
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
      }
    >
      <StepBar step={2} />
      <Title>Check your backup</Title>
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
      {error ? <Banner tone="danger">{error}</Banner> : null}
    </Screen>
  );
}

function StepBar({ step }: { step: 1 | 2 }) {
  return (
    <View style={{ flexDirection: 'row', gap: space.sm }} accessibilityLabel={`Step ${step} of 2`}>
      {[1, 2].map((i) => (
        <View key={i} style={{ flex: 1, height: 4, borderRadius: 2, backgroundColor: i <= step ? colors.accent : colors.s3 }} />
      ))}
    </View>
  );
}
