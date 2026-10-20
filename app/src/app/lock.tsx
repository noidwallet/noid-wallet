import { useEffect, useRef, useState } from 'react';
import { Text, View } from 'react-native';

import { Body, Button, Screen } from '@/components/ui';
import { goRoot } from '@/lib/nav';
import { useWallet } from '@/state/wallet';
import { colors, fonts, space } from '@/theme';

export default function Lock() {
  const { unlock, meta } = useWallet();
  const [failed, setFailed] = useState(false);

  const prompted = useRef(false);

  async function tryUnlock() {
    setFailed(false);
    const ok = await unlock();
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
      <View style={{ flex: 1, justifyContent: 'center', gap: space.md }}>
        <Text style={{ color: colors.accent, fontFamily: fonts.monoBold, letterSpacing: 1 }}>NOID</Text>
        <Text style={{ color: colors.text, fontSize: 28, fontWeight: '800' }}>Wallet locked</Text>
        <Body muted>{meta ? `Fingerprint ${meta.keyId}` : ''}</Body>
        {failed ? <Body muted>Unlock was cancelled. Try again.</Body> : null}
      </View>
      <Button title="Unlock" onPress={tryUnlock} />
    </Screen>
  );
}
