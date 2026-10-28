import { useCallback, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import { Pressable, Text, View } from 'react-native';


import { GiftCard } from '@/components/GiftCard';
import { Avatar, Banner, Body, Button, EmptyState, IconButton, ListRow, Pill, Screen } from '@/components/ui';
import { formatNoid } from '@/lib/amount';
import { core } from '@/lib/core';
import { findLostGifts, GIFT_BADGE, GIFT_TONE, giftState, newGiftRecord, type GiftState } from '@/lib/gifts';
import type { GiftTheme } from '@/lib/links';
import { go } from '@/lib/nav';
import { storage } from '@/lib/storage';
import { useWallet } from '@/state/wallet';
import { colors, space, type } from '@/theme';

export default function Gifts() {
  const w = useWallet();
  const [note, setNote] = useState<{ tone: 'info' | 'danger'; text: string } | null>(null);
  const [live, setLive] = useState<Record<number, GiftState>>({});
  const [scanning, setScanning] = useState<string | null>(null);
  const visible = w.gifts.filter((g) => !g.hidden);

  // Re-check open gifts whenever the list is shown, so statuses are current.
  useFocusEffect(
    useCallback(() => {
      let alive = true;
      for (const g of w.gifts.filter((x) => !x.hidden && x.status !== 'claimed' && x.status !== 'takenBack')) {
        giftState(w.api, g)
          .then((s) => {
            if (!alive) return;
            setLive((prev) => ({ ...prev, [g.index]: s }));
            if (w.status?.synced && (s === 'claimed' || s === 'takenBack')) w.saveGift({ ...g, status: s });
          })
          .catch(() => {});
      }
      return () => {
        alive = false;
      };
    }, [w]),
  );

  async function findGifts() {
    setNote(null);
    setScanning('Looking for your gifts…');
    try {
      const secret = await storage.readSecret();
      const found = await findLostGifts(
        w.api,
        (start, count) => core.giftAddresses(secret, start, count),
        w.gifts,
        { onProgress: (done, total) => setScanning(`Looking for your gifts… ${Math.round((done / total) * 100)}%`) },
      );
      for (const f of found) {
        const old = w.gifts.find((g) => g.index === f.index && g.address === f.address);
        w.saveGift(
          old
            ? { ...old, hidden: false, status: 'funded' }
            : { ...newGiftRecord({ index: f.index, address: f.address, amount: f.balance, message: '', theme: 'vault', from: '' }), status: 'funded' },
        );
        await storage.raiseGiftHighWater(f.index);
      }
      setNote({
        tone: 'info',
        text:
          found.length > 0
            ? `Found ${found.length} unclaimed gift${found.length === 1 ? '' : 's'}. Open one to share it again or take it back.`
            : 'No unclaimed gifts found.',
      });
    } catch (e) {
      setNote({ tone: 'danger', text: (e as Error).message });
    } finally {
      setScanning(null);
    }
  }

  return (
    <Screen
      header={{ title: 'Gift cards', right: <IconButton icon="plus" label="Create a gift card" onPress={() => go('/gift-new')} /> }}
      footer={<Button title="Create a gift card" icon="gift" onPress={() => go('/gift-new')} />}
    >
      {visible.length === 0 ? (
        <EmptyState
          icon="gift"
          title="Send NOID as a gift"
          body="Make a gift card anyone can open with a link or QR code. They claim it into their own NOID wallet, and until then you can take it back."
        />
      ) : null}

      <ListRow
        leading={<Avatar icon="receive" tone="success" />}
        title="Claim a gift"
        subtitle="Someone sent you a gift link or QR"
        chevron
        onPress={() => go('/claim')}
      />

      {visible.length > 0 ? (
        <View style={{ gap: space.xs }}>
          <Text style={type.h2}>Gifts you sent</Text>
          {visible.map((g) => {
            const state: GiftState = live[g.index] ?? (g.status === 'funded' ? 'funded' : g.status);
            return (
              <Pressable
                key={g.index}
                accessibilityRole="button"
                accessibilityLabel={`Gift card of ${formatNoid(g.amount)} NOID, ${GIFT_BADGE[state]}`}
                onPress={() => go({ pathname: '/gift/[index]', params: { index: String(g.index) } })}
                style={({ pressed }) => ({
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: space.md,
                  paddingVertical: space.sm,
                  paddingHorizontal: space.xs,
                  borderRadius: 14,
                  backgroundColor: pressed ? colors.s2 : 'transparent',
                })}
              >
                <GiftCard theme={g.theme as GiftTheme} amount={formatNoid(g.amount)} width={88} />
                <View style={{ flex: 1, gap: 4 }}>
                  <Text style={[type.mono, { fontSize: 16 }]}>{formatNoid(g.amount)} NOID</Text>
                  <Text style={[type.bodySm, { fontSize: 13 }]} numberOfLines={1}>
                    {g.message ? `“${g.message}”` : new Date(g.createdAt).toLocaleDateString()}
                  </Text>
                </View>
                <Pill text={GIFT_BADGE[state]} tone={GIFT_TONE[state]} />
              </Pressable>
            );
          })}
        </View>
      ) : null}

      <Button title={scanning ?? 'Find gifts from a restored wallet'} kind="tertiary" disabled={!!scanning} onPress={findGifts} />
      {note ? <Banner tone={note.tone === 'danger' ? 'danger' : 'neutral'}>{note.text}</Banner> : null}
      <Body muted style={{ fontSize: 13, textAlign: 'center' }}>Gift links are like cash: anyone who has one can claim it.</Body>
    </Screen>
  );
}
