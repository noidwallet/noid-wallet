import { useState } from 'react';
import { router } from 'expo-router';
import { usePreventScreenCapture } from 'expo-screen-capture';
import { Pressable, Text, View } from 'react-native';

import { Body, Button, Card, Field, KeyValue, Notice, Screen, Title } from '@/components/ui';
import { formatNoid, shortAddress } from '@/lib/amount';
import { core } from '@/lib/core';
import { useWallet } from '@/state/wallet';
import { colors, fonts, radius, space } from '@/theme';

/** How many derived addresses to check for coins when restoring. */
const SCAN = 10;

interface Candidate {
  index: number;
  address: string;
  balance: number | null;
}

export default function Restore() {
  usePreventScreenCapture();
  const { createWallet, api } = useWallet();
  const [secret, setSecret] = useState('');
  const [keyId, setKeyId] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [chosen, setChosen] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const clean = secret.replace(/\s+/g, '').toLowerCase();

  async function check() {
    setError(null);
    setBusy(true);
    try {
      const info = await core.inspectSecret(clean);
      const derived = await core.deriveAddresses(clean, 0, SCAN);
      const withBalance = await Promise.all(
        derived.map(async (d) => ({
          ...d,
          balance: await api
            .utxos(d.address)
            .then((r) => r.balance)
            .catch(() => null),
        })),
      );
      setKeyId(info.keyId);
      setCandidates(withBalance);
      const firstFunded = withBalance.find((c) => (c.balance ?? 0) > 0);
      setChosen(firstFunded ? firstFunded.index : 0);
    } catch (e) {
      setKeyId(null);
      setCandidates([]);
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen>
      <Title>Restore your wallet</Title>
      <Body muted>
        Enter the 64-character master secret. It is the same one the desktop Parano1d wallet shows under Export.
      </Body>
      <Field
        label="Master secret"
        mono
        multiline
        value={secret}
        onChangeText={(t) => {
          setSecret(t);
          setKeyId(null);
          setCandidates([]);
        }}
        placeholder="64 hexadecimal characters"
        error={error}
        // Keep the secret out of keyboard learning, autofill and the clipboard menu.
        keyboardType="visible-password"
        autoComplete="off"
        importantForAutofill="no"
        textContentType="none"
        contextMenuHidden
        spellCheck={false}
        style={{ minHeight: 96, textAlignVertical: 'top' }}
      />
      {!keyId ? (
        <Button title="Check secret" busy={busy} disabled={clean.length !== 64} onPress={check} />
      ) : (
        <>
          <Card>
            <KeyValue label="Key fingerprint" value={keyId} />
          </Card>
          <Notice>Compare the fingerprint with the one your desktop wallet shows before you continue.</Notice>
          <Body muted style={{ fontSize: 14 }}>
            Choose the address to use. The desktop wallet calls the one you were using your active address.
          </Body>
          <View style={{ gap: space.sm }}>
            {candidates.map((c) => (
              <Pressable
                key={c.index}
                accessibilityRole="radio"
                accessibilityState={{ selected: c.index === chosen }}
                onPress={() => setChosen(c.index)}
                style={{
                  flexDirection: 'row',
                  justifyContent: 'space-between',
                  padding: space.md,
                  borderRadius: radius.md,
                  borderWidth: 1,
                  borderColor: c.index === chosen ? colors.accent : colors.line,
                  backgroundColor: colors.surface,
                }}
              >
                <Text style={{ color: colors.text, fontFamily: fonts.mono, fontSize: 13 }}>
                  #{c.index} {shortAddress(c.address, 5)}
                </Text>
                <Text style={{ color: (c.balance ?? 0) > 0 ? colors.accent : colors.muted, fontFamily: fonts.mono, fontSize: 13 }}>
                  {c.balance === null ? 'offline' : `${formatNoid(c.balance, { maxDecimals: 4 })} NOID`}
                </Text>
              </Pressable>
            ))}
          </View>
          <Button
            title={`Restore with address #${chosen}`}
            busy={busy}
            onPress={async () => {
              setBusy(true);
              try {
                await createWallet(clean, 'imported', chosen);
                router.replace('/home');
              } catch (e) {
                setError((e as Error).message);
                setBusy(false);
              }
            }}
          />
        </>
      )}
    </Screen>
  );
}
