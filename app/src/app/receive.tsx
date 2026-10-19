import { useState } from 'react';
import { router } from 'expo-router';
import * as Clipboard from 'expo-clipboard';
import { Share, Text, View } from 'react-native';
import QRCode from 'react-native-qrcode-svg';

import { Body, Button, Screen, Title } from '@/components/ui';
import { useWallet } from '@/state/wallet';
import { colors, fonts, radius, space } from '@/theme';

export default function Receive() {
  const { meta } = useWallet();
  const [copied, setCopied] = useState(false);
  if (!meta) return null;

  return (
    <Screen>
      <Title>Receive NOID</Title>
      <Body muted>Share this address or let the sender scan the code. Only send NOID to it.</Body>
      <View style={{ alignItems: 'center', padding: space.lg, backgroundColor: '#fff', borderRadius: radius.lg, alignSelf: 'center' }}>
        <QRCode value={`noid:${meta.address}`} size={220} backgroundColor="#fff" color="#000" />
      </View>
      <Text selectable style={{ color: colors.text, fontFamily: fonts.mono, fontSize: 15, lineHeight: 22, textAlign: 'center' }}>
        {meta.address}
      </Text>
      <View style={{ flex: 1 }} />
      <Button
        title={copied ? 'Copied' : 'Copy address'}
        onPress={async () => {
          await Clipboard.setStringAsync(meta.address);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
      />
      <Button title="Share" kind="secondary" onPress={() => Share.share({ message: meta.address })} />
      <Button title="Back" kind="ghost" onPress={() => router.back()} />
    </Screen>
  );
}
