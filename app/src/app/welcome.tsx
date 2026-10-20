import { router } from 'expo-router';
import { Text, View } from 'react-native';

import { Body, Button, Screen } from '@/components/ui';
import { colors, fonts, space } from '@/theme';

export default function Welcome() {
  return (
    <Screen>
      <View style={{ flex: 1, justifyContent: 'center', gap: space.lg }}>
        <Text style={{ color: colors.accent, fontFamily: fonts.monoBold, fontSize: 15, letterSpacing: 1 }}>Noidly</Text>
        <Text style={{ color: colors.text, fontSize: 34, fontWeight: '800', letterSpacing: -0.8, lineHeight: 40 }}>
          Your Parano1d wallet, in your pocket.
        </Text>
        <Body muted>
          Your secret stays on this phone. Every send is proven here with a zero-knowledge proof, so no signature
          and no key ever leaves the device.
        </Body>
      </View>
      <View style={{ gap: space.md }}>
        <Button title="Create a new wallet" onPress={() => router.push('/create')} />
        <Button title="Restore with my secret" kind="secondary" onPress={() => router.push('/restore')} />
        <Button title="Use a photo as my key" kind="secondary" onPress={() => router.push('/photo')} />
        <Button title="Wallet server settings" kind="ghost" onPress={() => router.push('/server')} />
      </View>
    </Screen>
  );
}
