import { useEffect, useState, type ReactNode } from 'react';
import { Pressable, Switch, Text, View } from 'react-native';

import { Avatar, Banner, ListRow, Pill, Screen } from '@/components/ui';
import { core } from '@/lib/core';
import { go } from '@/lib/nav';
import { disablePush, enablePush } from '@/lib/push';
import type { Currency } from '@/lib/safety';
import { useWallet } from '@/state/wallet';
import { colors, fonts, radius, space, type } from '@/theme';

const ORIGIN = { generated: 'Created on this phone', imported: 'Restored from secret', photo: 'Photo Key' } as const;
const CURRENCIES: { id: Currency; label: string }[] = [
  { id: 'none', label: 'NOID only' },
  { id: 'usd', label: 'US dollar' },
  { id: 'ngn', label: 'Naira' },
];

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <View style={{ gap: space.xs }}>
      <Text style={[type.caption, { paddingHorizontal: space.xs }]}>{title}</Text>
      <View style={{ backgroundColor: colors.s1, borderRadius: radius.lg, paddingHorizontal: space.sm, borderWidth: 1, borderColor: colors.line }}>
        {children}
      </View>
    </View>
  );
}

export default function Settings() {
  const w = useWallet();
  const [version, setVersion] = useState('');
  const [pushNote, setPushNote] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const [pushBusy, setPushBusy] = useState(false);

  useEffect(() => {
    core.version().then((v) => setVersion(`core ${v.core} · parano1d ${v.parano1dRev.slice(0, 7)}`), () => {});
  }, []);

  if (!w.meta) return null;
  const meta = w.meta;
  const server = w.settings.apiUrl ? w.settings.apiUrl.replace(/^https?:\/\//, '') : 'Not set';
  const online = !!w.settings.apiUrl && !!w.status && !w.error;
  const currency = w.settings.currency ?? 'none';
  const pushOn = !!w.settings.pushToken;
  const pushAvailable = w.status?.features?.push === true;
  const priceAvailable = w.status?.features?.price !== false;

  async function togglePush(on: boolean) {
    setPushNote(null);
    setPushBusy(true);
    try {
      if (!on && w.settings.pushToken) {
        await disablePush(w.api, meta.address, w.settings.pushToken);
        await w.updateSettings({ pushToken: null });
      } else if (on) {
        const token = await enablePush(w.api, meta.address);
        await w.updateSettings({ pushToken: token });
        setPushNote({ tone: 'success', text: 'You’ll get a notification when NOID arrives.' });
      }
    } catch (e) {
      setPushNote({ tone: 'danger', text: (e as Error).message });
    } finally {
      setPushBusy(false);
    }
  }

  return (
    <Screen header={{ title: 'Settings' }}>
      <Section title="Security">
        <ListRow
          leading={<Avatar icon="key" tone={meta.backedUp ? 'success' : 'warn'} />}
          title={meta.backedUp ? 'Show my secret' : 'Back up my secret'}
          subtitle={meta.backedUp ? 'Backup confirmed' : 'Not backed up yet'}
          chevron
          onPress={() => go('/backup')}
        />
        <ListRow leading={<Avatar icon="shield" />} title="Wallet ID" subtitle={`${ORIGIN[meta.origin]} · ${meta.keyId}`} />
      </Section>

      <Section title="Network">
        <ListRow
          leading={<Avatar icon="server" tone={online ? 'success' : 'danger'} />}
          title="Wallet server"
          subtitle={`${server} · ${online ? 'connected' : 'not reachable'}`}
          chevron
          onPress={() => go('/server')}
        />
      </Section>

      <Section title="Preferences">
        <View style={{ paddingVertical: space.md, paddingHorizontal: space.xs, gap: space.sm }}>
          <Text style={[type.title, { fontSize: 16 }]}>Show values in</Text>
          <View style={{ flexDirection: 'row', backgroundColor: colors.s2, borderRadius: radius.md, padding: 4 }}>
            {CURRENCIES.map((c) => (
              <Pressable
                key={c.id}
                accessibilityRole="radio"
                accessibilityState={{ selected: currency === c.id }}
                onPress={() => void w.updateSettings({ currency: c.id })}
                style={{
                  flex: 1,
                  minHeight: 40,
                  alignItems: 'center',
                  justifyContent: 'center',
                  borderRadius: radius.sm,
                  backgroundColor: currency === c.id ? colors.s3 : 'transparent',
                }}
              >
                <Text style={{ color: currency === c.id ? colors.text : colors.textSecondary, fontFamily: fonts.uiSemi }}>{c.label}</Text>
              </Pressable>
            ))}
          </View>
          {currency !== 'none' ? (
            <Text style={type.bodySm}>
              {priceAvailable ? 'Prices come from SafeTrade via your wallet server and are a guide only.' : 'Your wallet server doesn’t provide prices.'}
            </Text>
          ) : null}
        </View>
        <View style={{ height: 1, backgroundColor: colors.line }} />
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md, paddingVertical: space.md, paddingHorizontal: space.xs }}>
          <Avatar icon="bell" />
          <View style={{ flex: 1 }}>
            <Text style={[type.title, { fontSize: 16 }]}>Payment notifications</Text>
            <Text style={[type.bodySm, { fontSize: 13 }]}>
              {pushAvailable || pushOn ? 'Get notified when NOID arrives' : 'Your wallet server doesn’t send notifications yet'}
            </Text>
          </View>
          <Switch
            accessibilityLabel="Payment notifications"
            value={pushOn}
            disabled={pushBusy || (!pushOn && !pushAvailable)}
            onValueChange={(v) => void togglePush(v)}
            trackColor={{ true: colors.accent, false: colors.s3 }}
            thumbColor={colors.text}
          />
        </View>
      </Section>
      {pushNote ? <Banner tone={pushNote.tone}>{pushNote.text}</Banner> : null}
      {pushOn ? (
        <Text style={[type.bodySm, { fontSize: 13 }]}>Your wallet server learns which phone to notify for your address. It never sees your secret.</Text>
      ) : null}

      <Section title="More">
        <ListRow leading={<Avatar icon="contacts" />} title="Contacts" subtitle={`${w.contacts.length} saved`} chevron onPress={() => go('/contacts')} />
        <ListRow leading={<Avatar icon="gift" />} title="Gift cards" chevron onPress={() => go('/gifts')} />
        <ListRow leading={<Avatar icon="merge" />} title="Merge coins" subtitle={`${w.utxos.length} coins`} chevron onPress={() => go('/consolidate')} />
      </Section>

      <Section title="Danger zone">
        <ListRow
          leading={<Avatar icon="warning" tone="danger" />}
          title="Remove wallet from this phone"
          chevron
          onPress={() => go('/remove-wallet')}
        />
      </Section>

      <View style={{ alignItems: 'center', gap: space.xs, paddingVertical: space.md }}>
        <Pill text="NOID 0.1" />
        <Text style={{ color: colors.faint, fontFamily: fonts.ui, fontSize: 12 }}>{version}</Text>
      </View>
    </Screen>
  );
}
