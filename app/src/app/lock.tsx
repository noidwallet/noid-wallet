import { useEffect, useRef, useState } from 'react';
import { Pressable, Text, View } from 'react-native';

import { Icon } from '@/components/Icon';
import { Banner, Screen } from '@/components/ui';
import { useInbox } from '@/lib/inbox';
import { goRoot } from '@/lib/nav';
import { useWallet } from '@/state/wallet';
import { colors, fonts, space, type } from '@/theme';

export default function Lock() {
  const { unlock } = useWallet();
  const incoming = useInbox();
  const [failed, setFailed] = useState(false);
  const prompted = useRef(false);
  const unlocking = useRef(false);

  async function tryUnlock() {
    // One prompt at a time: a tap while the system prompt is opening is ignored.
    if (unlocking.current) return;
    unlocking.current = true;
    setFailed(false);
    let ok = false;
    try {
      ok = await unlock();
    } catch {
      ok = false;
    } finally {
      unlocking.current = false;
    }
    if (ok) goRoot();
    else setFailed(true);
  }

  // Prompt once as soon as the lock screen opens.
  useEffect(() => {
    if (prompted.current) return;
    prompted.current = true;
    void tryUnlock();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <Screen>
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', gap: space.lg }}>
        <Text style={{ color: colors.accent, fontFamily: fonts.monoBold, fontSize: 16, letterSpacing: 2 }}>NOID</Text>
        <Text style={[type.h1, { alignSelf: 'stretch', textAlign: 'center' }]}>Welcome back</Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Unlock wallet"
          onPress={() => void tryUnlock()}
          style={({ pressed }) => ({
            width: 88,
            height: 88,
            borderRadius: 44,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: pressed ? colors.accentPressed : colors.accent,
            marginTop: space.lg,
          })}
        >
          <Icon name="shield" size={40} color={colors.accentInk} />
        </Pressable>
        <Text style={type.bodySm}>{failed ? 'Not unlocked. Tap to try again.' : 'Tap to unlock'}</Text>
        {incoming?.kind === 'gift' ? (
          <Banner tone="success" icon="gift">
            Unlock to open your gift card.
          </Banner>
        ) : incoming ? (
          <Banner tone="info">Unlock to open the payment request.</Banner>
        ) : null}
      </View>
    </Screen>
  );
}
