import { useCallback, useState } from 'react';
import { useFocusEffect, useLocalSearchParams } from 'expo-router';
import * as Clipboard from 'expo-clipboard';
import { View } from 'react-native';

import {
  Avatar,
  Banner,
  Body,
  Button,
  Card,
  EmptyState,
  Field,
  IconButton,
  ListRow,
  Screen,
  initialsOf,
  toneFor,
} from '@/components/ui';
import { shortAddress } from '@/lib/amount';
import { copyText } from '@/lib/clip';
import { LINK_HOSTS } from '@/lib/config';
import { core } from '@/lib/core';
import { parseLink } from '@/lib/links';
import { go, goBack } from '@/lib/nav';
import { checkAddress } from '@/lib/safety';
import { contactPick, scanResult } from '@/lib/scan';
import { useWallet } from '@/state/wallet';
import { space } from '@/theme';

export default function Contacts() {
  const { pick } = useLocalSearchParams<{ pick?: string }>();
  const w = useWallet();
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [address, setAddress] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [query, setQuery] = useState('');

  useFocusEffect(
    useCallback(() => {
      const scanned = scanResult.take();
      if (scanned) {
        const p = parseLink(scanned, LINK_HOSTS);
        if (p && p.kind !== 'gift') {
          setAddress(p.address);
          setAdding(true);
        } else setError('That QR code isn’t a NOID address.');
      }
    }, []),
  );

  const q = query.trim().toLowerCase();
  const sorted = [...w.contacts]
    .sort((a, b) => a.name.localeCompare(b.name))
    .filter((c) => !q || c.name.toLowerCase().includes(q) || c.address.includes(q));

  function closeForm() {
    setAdding(false);
    setError(null);
    setName('');
    setAddress('');
  }

  async function save() {
    setError(null);
    const trimmed = name.trim();
    if (!trimmed) {
      setError('Give the contact a name.');
      return;
    }
    const check = await core.validateAddress(address.trim());
    if (!check.valid || !check.address) {
      setError(check.error ?? 'That isn’t a valid NOID address.');
      return;
    }
    if (check.address === w.meta?.address) {
      setError('That’s your own address.');
      return;
    }
    const others = w.contacts.filter((c) => c.address !== check.address);
    const safety = checkAddress(check.address, others, w.sentTo);
    if (safety.kind === 'lookalike') {
      setError(`This looks like ${safety.name ?? 'another saved address'} but is different. Check every character before saving.`);
      return;
    }
    w.saveContact(trimmed.slice(0, 40), check.address);
    closeForm();
  }

  const form = (
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
        autoCapitalize="none"
        autoCorrect={false}
        right={
          <View style={{ flexDirection: 'row' }}>
            <IconButton
              icon="paste"
              label="Paste address"
              onPress={async () => {
                const t = (await Clipboard.getStringAsync()).trim();
                const p = t ? parseLink(t, LINK_HOSTS) : null;
                if (p && p.kind !== 'gift') setAddress(p.address);
                else setError('Copy a NOID address first.');
              }}
            />
            <IconButton icon="scan" label="Scan QR code" onPress={() => go('/scan')} />
          </View>
        }
      />
      {error ? <Banner tone="danger">{error}</Banner> : null}
      <Button title="Save contact" disabled={!name.trim() || !address.trim()} onPress={save} />
      <Button title="Cancel" kind="tertiary" onPress={closeForm} />
    </Card>
  );

  return (
    <Screen
      scroll
      header={{
        title: pick ? 'Choose a contact' : 'Contacts',
        right: !adding && !pick ? <IconButton icon="plus" label="Add a contact" onPress={() => setAdding(true)} /> : undefined,
      }}
    >
      {adding ? form : null}

      {w.contacts.length === 0 && !adding ? (
        <EmptyState
          icon="contacts"
          title="No contacts yet"
          body="Save the people you pay often. NOID shows their name when you send and warns you about look-alike addresses."
          action={<Button title="Add a contact" icon="plus" onPress={() => setAdding(true)} />}
        />
      ) : null}

      {w.contacts.length > 8 ? (
        <Field label="Search" value={query} onChangeText={setQuery} placeholder="Name or address" autoCapitalize="none" autoCorrect={false} />
      ) : null}
      {q && sorted.length === 0 ? <Body muted>No contact matches “{query.trim()}”.</Body> : null}

      <View>
        {sorted.map((c) => (
          <View key={c.id}>
            <ListRow
              leading={<Avatar initials={initialsOf(c.name)} tone={toneFor(c.name)} />}
              title={c.name}
              subtitle={shortAddress(c.address, 6)}
              chevron={!pick}
              onPress={() => {
                if (pick) {
                  contactPick.set(c.address);
                  goBack();
                  return;
                }
                setConfirmRemove(false);
                setOpen(open === c.id ? null : c.id);
              }}
            />
            {open === c.id && !pick ? (
              <View style={{ flexDirection: 'row', gap: space.sm, paddingBottom: space.md, flexWrap: 'wrap' }}>
                <View style={{ flex: 1, minWidth: 96 }}>
                  <Button title="Send" icon="send" kind="secondary" onPress={() => {
                      contactPick.set(c.address);
                      go('/send');
                    }} />
                </View>
                <View style={{ flex: 1, minWidth: 96 }}>
                  <Button title="Copy" icon="copy" kind="secondary" onPress={() => void copyText(c.address, 'Address')} />
                </View>
                <View style={{ flex: 1, minWidth: 96 }}>
                  {confirmRemove ? (
                    <Button
                      title="Confirm"
                      kind="danger"
                      onPress={() => {
                        w.removeContact(c.id);
                        setOpen(null);
                        setConfirmRemove(false);
                      }}
                    />
                  ) : (
                    <Button title="Remove" kind="tertiary" onPress={() => setConfirmRemove(true)} />
                  )}
                </View>
              </View>
            ) : null}
          </View>
        ))}
      </View>
    </Screen>
  );
}
