import { useEffect, useState } from 'react';
import { router } from 'expo-router';
import { Text, View } from 'react-native';

import { Body, Button, Screen } from '@/components/ui';
import { useWallet } from '@/state/wallet';
import { colors, fonts, space } from '@/theme';

export default function Lock() {
  const { unlock, meta } = useWallet();
  const [failed, setFailed] = useState(false);

  function tryUnlock() {
    unlock().then((ok) => (ok ? router.replace('/home') : setFailed(true)));
  }

  // Prompt once as soon as the lock screen opens.
  useEffect(() => {
    unlock().then((ok) => (ok ? router.replace('/home') : setFailed(true)));
  }, [unlock]);

  return (
    <Screen>
      <View style={{ flex: 1, justifyContent: 'center', gap: space.md }}>
        <Text style={{ color: colors.accent, fontFamily: fonts.monoBold, letterSpacing: 1 }}>Noidly</Text>
        <Text style={{ color: colors.text, fontSize: 28, fontWeight: '800' }}>Wallet locked</Text>
        <Body muted>{meta ? `Fingerprint ${meta.keyId}` : ''}</Body>
        {failed ? <Body muted>Unlock was cancelled. Try again.</Body> : null}
      </View>
      <Button title="Unlock" onPress={tryUnlock} />
    </Screen>
  );
}
