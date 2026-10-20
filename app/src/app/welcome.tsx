import { Text, View } from 'react-native';
import Svg, { Circle, Defs, Path, RadialGradient, Stop } from 'react-native-svg';

import { Icon, type IconName } from '@/components/Icon';
import { Banner, Button, IconButton, Screen } from '@/components/ui';
import { useInbox } from '@/lib/inbox';
import { go } from '@/lib/nav';
import { colors, fonts, space, type } from '@/theme';

const TRUST: { icon: IconName; text: string }[] = [
  { icon: 'key', text: 'Your keys stay on this phone' },
  { icon: 'shield', text: 'Locked with your fingerprint or PIN' },
  { icon: 'check', text: 'No account, no email, no sign-up' },
];

/** Original logo mark: a mint hexagon (a vault) with a solid core, on a soft glow. */
function Logo() {
  return (
    <Svg width={96} height={96} viewBox="0 0 96 96">
      <Defs>
        <RadialGradient id="g" cx="50%" cy="50%" r="50%">
          <Stop offset="0" stopColor={colors.accent} stopOpacity={0.35} />
          <Stop offset="1" stopColor={colors.accent} stopOpacity={0} />
        </RadialGradient>
      </Defs>
      <Circle cx={48} cy={48} r={48} fill="url(#g)" />
      <Path d="M48 20l24 14v28L48 76 24 62V34z" stroke={colors.accent} strokeWidth={5} strokeLinejoin="round" fill="none" />
      <Circle cx={48} cy={48} r={8} fill={colors.accent} />
    </Svg>
  );
}

export default function Welcome() {
  const incoming = useInbox();
  return (
    <Screen
      footer={
        <>
          <Button title="Create a new wallet" onPress={() => go('/create')} />
          <Button title="I already have a wallet" kind="secondary" onPress={() => go('/restore')} />
          <Button title="Use a photo as my key · Advanced" kind="tertiary" onPress={() => go('/photo')} />
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
        <Logo />
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
