import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';

import { GiftCard } from '@/components/GiftCard';
import { Body, Button, Notice, Screen, Title } from '@/components/ui';
import { formatNoid } from '@/lib/amount';
import { core } from '@/lib/core';
import { findLostGifts } from '@/lib/gifts';
import type { GiftTheme } from '@/lib/links';
import { go, goBack } from '@/lib/nav';
import { storage } from '@/lib/storage';
import { useWallet } from '@/state/wallet';
import { colors, space } from '@/theme';

const STATUS: Record<string, { text: string; color: string }> = {
  draft: { text: 'Not sent', color: colors.muted },
  funded: { text: 'Waiting to be claimed', color: colors.warn },
  claimed: { text: 'Claimed', color: colors.accent },
  takenBack: { text: 'Taken back', color: colors.muted },
};

/** How many gift numbers "Find my gifts" checks after a restore. */
const SCAN = 40;

export default function Gifts() {
  const w = useWallet();
  const [note, setNote] = useState<{ tone: 'info' | 'danger'; text: string } | null>(null);
  const visible = w.gifts.filter((g) => !g.hidden);

  async function findGifts() {
    setNote(null);
    try {
      const secret = await storage.readSecret();
      const addresses = await core.giftAddresses(secret, 0, SCAN);
      const found = await findLostGifts(w.api, addresses, w.gifts);
      for (const f of found) {
        w.saveGift({
          index: f.index,
          address: f.address,
          amount: f.balance,
          message: '',
          theme: 'vault',
          from: '',
          createdAt: Date.now(),
          fundTxid: null,
          // Empty but used before: keep the number reserved, out of sight.
          status: f.balance > 0 ? 'funded' : 'claimed',
          hidden: f.balance === 0,
        });
      }
      const funded = found.filter((f) => f.balance > 0).length;
      setNote({
        tone: 'info',
        text: funded > 0 ? `Found ${funded} unclaimed gift${funded === 1 ? '' : 's'}. You can share or take them back.` : 'No unclaimed gifts found.',
      });
    } catch (e) {
      setNote({ tone: 'danger', text: (e as Error).message });
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
            const s = STATUS[g.status] ?? STATUS.funded!;
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
                  <Text style={{ color: s.color, fontWeight: '600' }}>{s.text}</Text>
                  <Text style={{ color: colors.muted }}>{new Date(g.createdAt).toLocaleDateString()}</Text>
                </View>
              </Pressable>
            );
          })}
        </View>
      ) : null}

      <Button title="Find gifts from a restored wallet" kind="ghost" onPress={findGifts} />
      {note ? <Notice tone={note.tone}>{note.text}</Notice> : null}
      <Button title="Back" kind="ghost" onPress={() => goBack()} />
    </Screen>
  );
}
