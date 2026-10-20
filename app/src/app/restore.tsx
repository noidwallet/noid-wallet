import { useState } from 'react';
import { usePreventScreenCapture } from 'expo-screen-capture';
import { Pressable, Text, View } from 'react-native';

import { Banner, Body, Button, Card, Field, KeyValue, Screen, Skeleton } from '@/components/ui';
import { formatNoid, shortAddress } from '@/lib/amount';
import { core } from '@/lib/core';
import { go, goRoot } from '@/lib/nav';
import { useWallet } from '@/state/wallet';
import { colors, radius, space, type } from '@/theme';

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
  const [restoreError, setRestoreError] = useState<string | null>(null);

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

  async function restore() {
    setRestoreError(null);
    setBusy(true);
    try {
      await createWallet(clean, 'imported', chosen);
      goRoot();
    } catch (e) {
      setRestoreError((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <Screen
      header={{ title: 'Restore wallet' }}
      footer={
        !keyId ? (
          <Button title="Check secret" busy={busy} disabled={clean.length !== 64} onPress={check} />
        ) : (
          <Button title="Restore wallet" busy={busy} onPress={restore} />
        )
      }
    >
      <Body muted>Enter your 64-character secret. It is the same one the desktop Parano1d wallet shows under Export.</Body>
      <Field
        label="Secret"
        mono
        multiline
        value={secret}
        onChangeText={(t) => {
          setSecret(t);
          setKeyId(null);
          setCandidates([]);
          setError(null);
        }}
        placeholder="64 characters, 0–9 and a–f"
        error={error}
        hint={clean.length > 0 && clean.length !== 64 ? `${clean.length}/64 characters` : null}
        // Keep the secret out of keyboard learning, autofill and the clipboard menu.
        keyboardType="visible-password"
        autoComplete="off"
        importantForAutofill="no"
        textContentType="none"
        contextMenuHidden
        spellCheck={false}
        style={{ minHeight: 96, textAlignVertical: 'top' }}
      />
      {busy && !keyId ? (
        <View style={{ gap: space.sm }}>
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} width="100%" height={52} />
          ))}
        </View>
      ) : null}
      {keyId ? (
        <>
          <Card>
            <KeyValue label="Wallet ID" value={keyId} />
          </Card>
          <Banner tone="info">Compare this Wallet ID with the key fingerprint your desktop wallet shows before you continue.</Banner>
          <Text style={type.bodySm}>Pick the account that holds your NOID. It’s usually the one with a balance.</Text>
          <View style={{ gap: space.sm }}>
            {candidates.map((c) => {
              const selected = c.index === chosen;
              return (
                <Pressable
                  key={c.index}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: selected }}
                  accessibilityLabel={`Account ${c.index + 1}, ${c.balance === null ? 'no balance info' : `${formatNoid(c.balance)} NOID`}`}
                  onPress={() => setChosen(c.index)}
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: space.md,
                    padding: space.md,
                    borderRadius: radius.md,
                    borderWidth: 1,
                    borderColor: selected ? colors.accent : colors.line,
                    backgroundColor: selected ? colors.accentTint : colors.s1,
                  }}
                >
                  <View
                    style={{
                      width: 20,
                      height: 20,
                      borderRadius: 10,
                      borderWidth: 2,
                      borderColor: selected ? colors.accent : colors.lineStrong,
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    {selected ? <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: colors.accent }} /> : null}
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={type.title}>Account {c.index + 1}</Text>
                    <Text style={type.monoSm}>
                      #{c.index} · {shortAddress(c.address, 6)}
                    </Text>
                  </View>
                  <Text style={[type.mono, { color: (c.balance ?? 0) > 0 ? colors.accent : colors.textSecondary }]}>
                    {c.balance === null ? 'No balance info' : `${formatNoid(c.balance, { maxDecimals: 4 })}`}
                  </Text>
                </Pressable>
              );
            })}
          </View>
          {candidates.every((c) => c.balance === null) ? (
            <Banner tone="warn" icon="server" onPress={() => go('/server')}>
              Balances couldn’t load because no wallet server is reachable. You can still restore, or tap to check the server.
            </Banner>
          ) : null}
          {restoreError ? <Banner tone="danger">{restoreError}</Banner> : null}
        </>
      ) : null}
    </Screen>
  );
}
