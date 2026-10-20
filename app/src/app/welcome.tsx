import { Text, View } from 'react-native';

import { Body, Button, Notice, Screen } from '@/components/ui';
import { useInbox } from '@/lib/inbox';
import { go } from '@/lib/nav';
import { colors, fonts, space } from '@/theme';

export default function Welcome() {
  const incoming = useInbox();
  return (
    <Screen>
      <View style={{ flex: 1, justifyContent: 'center', gap: space.lg }}>
        {incoming?.kind === 'gift' ? (
          <Notice>
            {incoming.from ? `${incoming.from} sent you` : 'You received'} a NOID gift card. Create a wallet (or restore yours)
            and it opens right after.
          </Notice>
        ) : incoming ? (
          <Notice>
            Someone asked you to pay{incoming.amount ? ` ${incoming.amount} NOID` : ''}. Create or restore a wallet first, then
            the payment opens.
          </Notice>
        ) : null}
        <Text style={{ color: colors.accent, fontFamily: fonts.monoBold, fontSize: 15, letterSpacing: 1 }}>NOID</Text>
        <Text style={{ color: colors.text, fontSize: 34, fontWeight: '800', letterSpacing: -0.8, lineHeight: 40 }}>
          Your Parano1d wallet, in your pocket.
        </Text>
        <Body muted>
          Your secret never leaves this phone. Every payment is secured on the phone itself, so nothing that can spend
          your NOID is ever sent anywhere.
        </Body>
      </View>
      <View style={{ gap: space.md }}>
        <Button title="Create a new wallet" onPress={() => go('/create')} />
        <Button title="Restore with my secret" kind="secondary" onPress={() => go('/restore')} />
        <Button title="Use a photo as my key" kind="secondary" onPress={() => go('/photo')} />
        <Button title="Wallet server settings" kind="ghost" onPress={() => go('/server')} />
      </View>
    </Screen>
  );
}
