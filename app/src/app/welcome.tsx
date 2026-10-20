import { Text, View } from 'react-native';

import { Icon, type IconName } from '@/components/Icon';
import { LogoMark } from '@/components/Logo';
import { Banner, Button, IconButton, Screen } from '@/components/ui';
import { useInbox } from '@/lib/inbox';
import { go } from '@/lib/nav';
import { useWallet } from '@/state/wallet';
import { colors, fonts, space, type } from '@/theme';

const TRUST: { icon: IconName; text: string }[] = [
  { icon: 'key', text: 'Your keys stay on this phone' },
  { icon: 'shield', text: 'Locked with your fingerprint or PIN' },
  { icon: 'check', text: 'No account, no email, no sign-up' },
];

export default function Welcome() {
  const incoming = useInbox();
  const { settings } = useWallet();
  // The safety slides come first, once, before any wallet is made or restored.
  const start = (next: 'create' | 'restore' | 'photo') =>
    settings.safetySeen ? go(`/${next}`) : go({ pathname: '/safety', params: { next } });
  return (
    <Screen
      footer={
        <>
          <Button title="Create a new wallet" onPress={() => start('create')} />
          <Button title="I already have a wallet" kind="secondary" onPress={() => start('restore')} />
          <Button title="Use a photo as my key · Advanced" kind="tertiary" onPress={() => start('photo')} />
        </>
      }
    >
      <View style={{ alignItems: 'flex-end' }}>
        <IconButton icon="server" label="Wallet server settings" onPress={() => go('/server')} />
      </View>
      {incoming?.kind === 'gift' ? (
        <Banner tone="success" icon="gift">
          {incoming.from ? `${incoming.from} sent you` : 'You received'} a NOID gift card. Create a wallet (or restore yours) and it
          opens right after.
        </Banner>
      ) : incoming ? (
        <Banner tone="info">
          Someone asked you to pay{incoming.amount ? ` ${incoming.amount} NOID` : ''}. Create or restore a wallet first, then the
          payment opens.
        </Banner>
      ) : null}
      <View style={{ flex: 1, justifyContent: 'center', gap: space.xl }}>
        <LogoMark />
        <Text style={{ color: colors.accent, fontFamily: fonts.monoBold, fontSize: 16, letterSpacing: 2 }}>NOID</Text>
        <Text style={[type.h1, { fontSize: 32, lineHeight: 38 }]}>Your Parano1d wallet, in your pocket.</Text>
        <View style={{ gap: space.md }}>
          {TRUST.map((t) => (
            <View key={t.text} style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
              <Icon name={t.icon} size={20} color={colors.accent} />
              <Text style={type.body}>{t.text}</Text>
            </View>
          ))}
        </View>
      </View>
    </Screen>
  );
}
