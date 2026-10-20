import { useCallback, useState } from 'react';
import { useFocusEffect, useLocalSearchParams } from 'expo-router';
import * as Clipboard from 'expo-clipboard';
import { Pressable, Text, View } from 'react-native';

import { Body, Button, Card, Field, Link, Notice, Screen, Title } from '@/components/ui';
import { shortAddress } from '@/lib/amount';
import { LINK_HOSTS } from '@/lib/config';
import { core } from '@/lib/core';
import { parseLink } from '@/lib/links';
import { go, goBack } from '@/lib/nav';
import { checkAddress } from '@/lib/safety';
import { contactPick, scanResult } from '@/lib/scan';
import { useWallet } from '@/state/wallet';
import { colors, fonts, space } from '@/theme';

export default function Contacts() {
  const { pick } = useLocalSearchParams<{ pick?: string }>();
  const w = useWallet();
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [address, setAddress] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);

  useFocusEffect(
    useCallback(() => {
      const scanned = scanResult.take();
      if (scanned) {
        const p = parseLink(scanned, LINK_HOSTS);
        if (p && p.kind !== 'gift') {
          setAddress(p.address);
          setAdding(true);
        } else setError('That QR code is not a NOID address.');
      }
    }, []),
  );

  const sorted = [...w.contacts].sort((a, b) => a.name.localeCompare(b.name));

  async function save() {
    setError(null);
    const trimmed = name.trim();
    if (!trimmed) {
      setError('Give the contact a name.');
      return;
    }
    const check = await core.validateAddress(address.trim());
    if (!check.valid || !check.address) {
      setError(check.error ?? 'That is not a valid NOID address.');
      return;
    }
    if (check.address === w.meta?.address) {
      setError('That is your own address.');
      return;
    }
    const others = w.contacts.filter((c) => c.address !== check.address);
    const safety = checkAddress(check.address, others, []);
    if (safety.kind === 'lookalike') {
      setError(
        `This looks like ${safety.name ?? 'another saved address'} but is different. Check every character before saving.`,
      );
      return;
    }
    w.saveContact(trimmed.slice(0, 40), check.address);
    setName('');
    setAddress('');
    setAdding(false);
  }

  return (
    <Screen>
      <Title>{pick ? 'Choose a contact' : 'Contacts'}</Title>
      {sorted.length === 0 && !adding ? (
        <Body muted>Save the people you pay often. NOID then shows their name when you send, and warns you about look-alike addresses.</Body>
      ) : null}

      {sorted.map((c) => (
        <Pressable
          key={c.id}
          accessibilityRole="button"
          onPress={() => {
            if (pick) {
              contactPick.set(c.address);
              goBack();
            }
          }}
          style={({ pressed }) => ({
            paddingVertical: space.md,
            borderBottomWidth: 1,
            borderBottomColor: colors.line,
            opacity: pressed && pick ? 0.6 : 1,
            gap: 4,
          })}
        >
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
            <Text style={{ color: colors.text, fontSize: 16, fontWeight: '600' }}>{c.name}</Text>
            {!pick ? (
              confirmRemove === c.id ? (
                <View style={{ flexDirection: 'row', gap: space.lg }}>
                  <Link title="Keep" onPress={() => setConfirmRemove(null)} />
                  <Pressable
                    accessibilityRole="button"
                    hitSlop={12}
                    onPress={() => {
                      w.removeContact(c.id);
                      setConfirmRemove(null);
                    }}
                  >
                    <Text style={{ color: colors.danger, fontWeight: '600' }}>Remove</Text>
                  </Pressable>
                </View>
              ) : (
                <Link title="Remove" onPress={() => setConfirmRemove(c.id)} />
              )
            ) : null}
          </View>
          <Text style={{ color: colors.muted, fontFamily: fonts.mono, fontSize: 13 }}>{shortAddress(c.address, 8)}</Text>
        </Pressable>
      ))}

      {adding ? (
        <Card>
          <Field label="Name" value={name} onChangeText={setName} maxLength={40} placeholder="Tolu" autoCapitalize="words" />
          <Field
            label="NOID address"
            mono
            value={address}
            onChangeText={(t) => {
              setAddress(t);
              setError(null);
            }}
            placeholder="o1…"
          />
          <View style={{ flexDirection: 'row', gap: space.md }}>
            <View style={{ flex: 1 }}>
              <Button
                title="Paste"
                kind="secondary"
                onPress={async () => {
                  const t = (await Clipboard.getStringAsync()).trim();
                  const p = t ? parseLink(t, LINK_HOSTS) : null;
                  if (p && p.kind !== 'gift') setAddress(p.address);
                  else setError('Copy a NOID address first.');
                }}
              />
            </View>
            <View style={{ flex: 1 }}>
              <Button title="Scan QR" kind="secondary" onPress={() => go('/scan')} />
            </View>
          </View>
          {error ? <Notice tone="danger">{error}</Notice> : null}
          <Button title="Save contact" disabled={!name.trim() || !address.trim()} onPress={save} />
          <Button
            title="Cancel"
            kind="ghost"
            onPress={() => {
              setAdding(false);
              setError(null);
            }}
          />
        </Card>
      ) : (
        <Button title="Add a contact" kind="secondary" onPress={() => setAdding(true)} />
      )}
      <Button title="Back" kind="ghost" onPress={() => goBack()} />
    </Screen>
  );
}
