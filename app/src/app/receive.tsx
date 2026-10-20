import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import { Share, Text, View } from 'react-native';
import QRCode from 'react-native-qrcode-svg';

import { Body, IconAction, Screen, toast } from '@/components/ui';
import { go } from '@/lib/nav';
import { groupAddress } from '@/lib/safety';
import { useWallet } from '@/state/wallet';
import { colors, radius, space, type } from '@/theme';

export default function Receive() {
  const { meta } = useWallet();
  if (!meta) return null;

  return (
    <Screen header={{ title: 'Receive NOID' }}>
      <Body muted style={{ textAlign: 'center' }}>
        Let the sender scan this code, or share your address. Only send NOID to it.
      </Body>
      <View style={{ alignItems: 'center', padding: space.xl, backgroundColor: '#fff', borderRadius: radius.xl, alignSelf: 'center' }}>
        <QRCode
          value={`noid:${meta.address}`}
          size={220}
          backgroundColor="#fff"
          color="#000"
          logo={require('../../assets/icon.png')}
          logoSize={44}
          logoBackgroundColor="#fff"
          logoBorderRadius={10}
          ecl="H"
        />
      </View>
      <Text selectable style={[type.mono, { textAlign: 'center', lineHeight: 24 }]} accessibilityLabel={`Your address ${meta.address}`}>
        {groupAddress(meta.address)}
      </Text>
      <View style={{ flexDirection: 'row', justifyContent: 'space-evenly', paddingTop: space.md }}>
        <IconAction
          icon="copy"
          label="Copy"
          highlight
          onPress={async () => {
            await Clipboard.setStringAsync(meta.address);
            void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            toast('Address copied');
          }}
        />
        <IconAction icon="share" label="Share" onPress={() => Share.share({ message: `My NOID wallet address (send only NOID to it): ${meta.address}` }).catch(() => {})} />
        <IconAction icon="request" label="Request" onPress={() => go('/request')} />
      </View>
      <Text style={[type.bodySm, { textAlign: 'center', color: colors.faint }]}>Tip: Request lets you ask for an exact amount with a note.</Text>
    </Screen>
  );
}
