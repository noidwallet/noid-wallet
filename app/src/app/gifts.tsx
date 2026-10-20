import { useCallback, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import { Pressable, Text, View } from 'react-native';

import { GiftCard } from '@/components/GiftCard';
import { Body, Button, Notice, Screen, Title } from '@/components/ui';
import { formatNoid } from '@/lib/amount';
import { core } from '@/lib/core';
import { findLostGifts, GIFT_STATUS, GIFTS_PER_DAY, giftState, newGiftRecord, type GiftState } from '@/lib/gifts';
import type { GiftTheme } from '@/lib/links';
import { go, goBack } from '@/lib/nav';
import { storage } from '@/lib/storage';
import { useWallet } from '@/state/wallet';
import { colors, space } from '@/theme';

/** "Find gifts" checks the first few gifts of each recent day. */
const SCAN_DAYS = 120;
const SCAN_PER_DAY = 5;

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
        (day) => core.giftAddresses(secret, day * GIFTS_PER_DAY, SCAN_PER_DAY),
        w.gifts,
        { days: SCAN_DAYS, onProgress: (done, total) => setScanning(`Looking for your gifts… ${Math.round((done / total) * 100)}%`) },
      );
      for (const f of found) {
        w.saveGift({ ...newGiftRecord({ index: f.index, address: f.address, amount: f.balance, message: '', theme: 'vault', from: '' }), status: 'funded' });
        await storage.raiseGiftHighWater(f.index);
      }
      setNote({
        tone: 'info',
        text:
          found.length > 0
            ? `Found ${found.length} unclaimed gift${found.length === 1 ? '' : 's'}. Open one to share it again or take it back.`
            : `No unclaimed gifts found from the last ${SCAN_DAYS} days.`,
      });
    } catch (e) {
      setNote({ tone: 'danger', text: (e as Error).message });
    } finally {
      setScanning(null);
    }
  }

  return (
    <Screen>
      <Title>Gift cards</Title>
      <Body muted>
        Send NOID as a gift card anyone can open with a link or QR code. They claim it into their own NOID wallet. Until
        then, you can take it back.
      </Body>
      <Button title="Create a gift card" onPress={() => go('/gift-new')} />
      <Button title="Claim a gift someone sent me" kind="secondary" onPress={() => go('/claim')} />

      {visible.length > 0 ? (
        <View style={{ gap: space.lg }}>
          <Text style={{ color: colors.text, fontSize: 18, fontWeight: '700' }}>Gifts you sent</Text>
          {visible.map((g) => {
            const state: GiftState = live[g.index] ?? (g.status === 'funded' ? 'funded' : g.status);
            const s = GIFT_STATUS[state];
            return (
              <Pressable
                key={g.index}
                accessibilityRole="button"
                accessibilityLabel={`Gift card of ${formatNoid(g.amount)} NOID, ${s.text}`}
                onPress={() => go({ pathname: '/gift/[index]', params: { index: String(g.index) } })}
                style={({ pressed }) => ({ gap: space.sm, opacity: pressed ? 0.7 : 1 })}
              >
                <GiftCard theme={g.theme as GiftTheme} amount={formatNoid(g.amount)} from={g.from || undefined} />
                <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                  <Text style={{ color: s.color, fontWeight: '600', flex: 1 }}>{s.text}</Text>
                  <Text style={{ color: colors.muted }}>{new Date(g.createdAt).toLocaleDateString()}</Text>
                </View>
              </Pressable>
            );
          })}
        </View>
      ) : null}

      <Button title={scanning ?? 'Find gifts from a restored wallet'} kind="ghost" disabled={!!scanning} onPress={findGifts} />
      {note ? <Notice tone={note.tone}>{note.text}</Notice> : null}
      <Button title="Back" kind="ghost" onPress={() => goBack()} />
    </Screen>
  );
}
