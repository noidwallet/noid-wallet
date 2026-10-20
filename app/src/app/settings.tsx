import { useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';

import { Body, Button, Card, Field, KeyValue, Notice, Screen, Title } from '@/components/ui';
import { core } from '@/lib/core';
import { go, goBack, goRoot } from '@/lib/nav';
import { disablePush, enablePush } from '@/lib/push';
import type { Currency } from '@/lib/safety';
import { useWallet } from '@/state/wallet';
import { colors, radius, space } from '@/theme';

const CURRENCIES: { id: Currency; label: string }[] = [
  { id: 'none', label: 'NOID only' },
  { id: 'usd', label: 'US dollar' },
  { id: 'ngn', label: 'Naira' },
];

const ORIGIN = { generated: 'Created on this phone', imported: 'Restored from secret', photo: 'Photo Key' } as const;

export default function Settings() {
  const w = useWallet();
  const [version, setVersion] = useState('');
  const [confirmRemove, setConfirmRemove] = useState('');
  const [pushNote, setPushNote] = useState<{ tone: 'info' | 'danger'; text: string } | null>(null);

  useEffect(() => {
    core.version().then((v) => setVersion(`core ${v.core} · parano1d ${v.parano1dRev.slice(0, 7)}`), () => {});
  }, []);

  if (!w.meta) return null;
  const server = w.settings.apiUrl ? w.settings.apiUrl.replace(/^https?:\/\//, '') : 'not set';
  const meta = w.meta;
  const currency = w.settings.currency ?? 'none';
  const pushOn = !!w.settings.pushToken;
  const pushAvailable = w.status?.features?.push === true;
  const priceAvailable = w.status?.features?.price !== false;
  const openGifts = w.gifts.filter((g) => !g.hidden && g.status === 'funded').length;

  async function togglePush() {
    setPushNote(null);
    try {
      if (pushOn) {
        await disablePush(w.api, meta.address, w.settings.pushToken!);
        await w.updateSettings({ pushToken: null });
        setPushNote({ tone: 'info', text: 'Notifications are off.' });
      } else {
        const token = await enablePush(w.api, meta.address);
        await w.updateSettings({ pushToken: token });
        setPushNote({ tone: 'info', text: 'You will get a notification when NOID arrives.' });
      }
    } catch (e) {
      setPushNote({ tone: 'danger', text: (e as Error).message });
    }
  }

  return (
    <Screen>
      <Title>Settings</Title>

      <Card>
        <KeyValue label="Wallet" value={ORIGIN[w.meta.origin]} mono={false} />
        <KeyValue label="Wallet ID" value={w.meta.keyId} />
        <KeyValue label="Backup" value={w.meta.backedUp ? 'Confirmed' : 'Not confirmed'} mono={false} />
      </Card>
      <Button title={w.meta.backedUp ? 'Show my secret' : 'Back up my secret'} kind="secondary" onPress={() => go('/backup')} />

      <Button title={`Wallet server · ${server}`} kind="secondary" onPress={() => go('/server')} />
      <Body muted style={{ fontSize: 14 }}>
        The server only sees your public address and finished transactions. Your secret never leaves this phone.
      </Body>

      <View style={{ gap: space.sm }}>
        <Text style={{ color: colors.text, fontSize: 16, fontWeight: '700' }}>Show values in</Text>
        <View style={{ flexDirection: 'row', gap: space.sm }}>
          {CURRENCIES.map((c) => (
            <Pressable
              key={c.id}
              accessibilityRole="radio"
              accessibilityState={{ selected: currency === c.id }}
              onPress={() => void w.updateSettings({ currency: c.id })}
              style={{
                flex: 1,
                paddingVertical: space.md,
                alignItems: 'center',
                borderRadius: radius.md,
                borderWidth: 1,
                borderColor: currency === c.id ? colors.accent : colors.line,
                backgroundColor: currency === c.id ? colors.surfaceRaised : colors.surface,
              }}
            >
              <Text style={{ color: currency === c.id ? colors.text : colors.muted, fontWeight: '600' }}>{c.label}</Text>
            </Pressable>
          ))}
        </View>
        {currency !== 'none' ? (
          <Body muted style={{ fontSize: 13 }}>
            {priceAvailable
              ? 'Prices come from SafeTrade through your wallet server and are a guide only.'
              : 'Your wallet server does not provide prices, so only NOID amounts are shown.'}
          </Body>
        ) : null}
      </View>

      <View style={{ gap: space.sm }}>
        <Text style={{ color: colors.text, fontSize: 16, fontWeight: '700' }}>Notifications</Text>
        <Body muted style={{ fontSize: 13 }}>
          Get a notification when NOID arrives, even with the app closed. Your wallet server learns which phone to notify for
          your address; it never sees your secret.
        </Body>
        <Button
          title={pushOn ? 'Turn off notifications' : 'Turn on notifications'}
          kind="secondary"
          disabled={!pushOn && !pushAvailable}
          onPress={togglePush}
        />
        {!pushOn && !pushAvailable ? <Body muted style={{ fontSize: 13 }}>Your wallet server does not send notifications yet.</Body> : null}
        {pushNote ? <Notice tone={pushNote.tone}>{pushNote.text}</Notice> : null}
      </View>

      <View style={{ flexDirection: 'row', gap: space.md }}>
        <View style={{ flex: 1 }}>
          <Button title="Contacts" kind="secondary" onPress={() => go('/contacts')} />
        </View>
        <View style={{ flex: 1 }}>
          <Button title="Gift cards" kind="secondary" onPress={() => go('/gifts')} />
        </View>
      </View>

      <Card style={{ borderColor: colors.danger }}>
        <Text style={{ color: colors.danger, fontWeight: '700', fontSize: 16 }}>Remove wallet from this phone</Text>
        {w.meta.backedUp ? (
          <Body muted style={{ fontSize: 14 }}>
            Your NOID stays on the network, but you can only get back in with your secret. Type REMOVE to confirm.
          </Body>
        ) : (
          <Notice tone="danger">
            You have not confirmed a backup of this wallet’s secret. Removing it now would lose your NOID for good. Back it
            up first with Show my secret.
          </Notice>
        )}
        {openGifts > 0 ? (
          <Notice tone="warn">
            {openGifts} gift card{openGifts === 1 ? ' is' : 's are'} still waiting to be claimed. After you restore this wallet,
            Gift cards → Find gifts brings them back so you can take them back.
          </Notice>
        ) : null}
        <Field
          value={confirmRemove}
          onChangeText={(t) => setConfirmRemove(t.toUpperCase())}
          placeholder="Type REMOVE"
          autoCapitalize="characters"
          editable={w.meta.backedUp}
        />
        <Button
          title="Remove wallet"
          kind="danger"
          disabled={confirmRemove !== 'REMOVE' || !w.meta.backedUp}
          onPress={async () => {
            if (!(await w.confirmUser('Remove this wallet'))) return;
            await w.removeWallet();
            goRoot();
          }}
        />
      </Card>

      <Text style={{ color: colors.faint, fontSize: 12, marginTop: space.md }}>{version}</Text>
      <Button title="Back" kind="ghost" onPress={() => goBack()} />
    </Screen>
  );
}
