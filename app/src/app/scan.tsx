import { useRef, useState } from 'react';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as Haptics from 'expo-haptics';
import { ActivityIndicator, Linking, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Path } from 'react-native-svg';

import { Body, Button, IconButton, Screen, toast } from '@/components/ui';
import { LINK_HOSTS } from '@/lib/config';
import { parseLink } from '@/lib/links';
import { goBack } from '@/lib/nav';
import { scanResult } from '@/lib/scan';
import { colors, radius, space } from '@/theme';

const BOX = 260;
const DIM = 'rgba(0,0,0,0.6)';

export default function Scan() {
  const [permission, requestPermission] = useCameraPermissions();
  const [torch, setTorch] = useState(false);
  const done = useRef(false);
  const cooldownUntil = useRef(0);
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();

  if (!permission) {
    return (
      <Screen header={{ title: 'Scan' }}>
        <ActivityIndicator color={colors.accent} />
      </Screen>
    );
  }
  if (!permission.granted) {
    return (
      <Screen
        header={{ title: 'Scan a NOID code' }}
        footer={
          permission.canAskAgain ? (
            <Button title="Allow camera" icon="scan" onPress={requestPermission} />
          ) : (
            <Button title="Open app settings" kind="secondary" onPress={() => Linking.openSettings()} />
          )
        }
      >
        <Body muted>
          {permission.canAskAgain
            ? 'Allow camera access to scan NOID addresses, payment requests and gift cards. The camera is only used on this screen.'
            : 'Camera access is turned off for NOID. Turn it on in your phone’s app settings, or paste the address instead.'}
        </Body>
      </Screen>
    );
  }

  const top = (height - BOX) / 2 - 40;
  const side = (width - BOX) / 2;

  return (
    <View style={{ flex: 1, backgroundColor: '#000' }}>
      <CameraView
        style={StyleSheet.absoluteFill}
        facing="back"
        enableTorch={torch}
        barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
        onBarcodeScanned={(r) => {
          if (done.current || Date.now() < cooldownUntil.current) return;
          // Check the code here, so a wrong one never closes the camera.
          if (!parseLink(r.data, LINK_HOSTS)) {
            cooldownUntil.current = Date.now() + 1500;
            void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
            toast('That is not a NOID code');
            return;
          }
          done.current = true;
          void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
          scanResult.set(r.data);
          goBack();
        }}
      />
      {/* Dimmed frame around a clear square */}
      <View pointerEvents="none" style={StyleSheet.absoluteFill}>
        <View style={{ height: top, backgroundColor: DIM }} />
        <View style={{ flexDirection: 'row', height: BOX }}>
          <View style={{ width: side, backgroundColor: DIM }} />
          <Svg width={BOX} height={BOX}>
            {[
              'M2 42V14a12 12 0 0112-12h28',
              `M${BOX - 42} 2h28a12 12 0 0112 12v28`,
              `M${BOX - 2} ${BOX - 42}v28a12 12 0 01-12 12h-28`,
              `M42 ${BOX - 2}H14a12 12 0 01-12-12v-28`,
            ].map((d) => (
              <Path key={d} d={d} stroke={colors.accent} strokeWidth={4} strokeLinecap="round" fill="none" />
            ))}
          </Svg>
          <View style={{ width: side, backgroundColor: DIM }} />
        </View>
        <View style={{ flex: 1, backgroundColor: DIM, alignItems: 'center', paddingTop: space.xl }}>
          <Text style={{ color: '#fff', fontSize: 16, fontWeight: '600' }}>Point at a NOID QR code</Text>
          <Text style={{ color: 'rgba(255,255,255,0.7)', fontSize: 14, marginTop: 4 }}>Addresses, payment requests or gift cards</Text>
        </View>
      </View>
      <View style={{ position: 'absolute', top: insets.top + space.sm, left: space.md, right: space.md, flexDirection: 'row', justifyContent: 'space-between' }}>
        <View style={{ backgroundColor: 'rgba(0,0,0,0.45)', borderRadius: radius.pill }}>
          <IconButton icon="close" label="Close scanner" onPress={() => goBack()} />
        </View>
        <View style={{ backgroundColor: torch ? colors.accent : 'rgba(0,0,0,0.45)', borderRadius: radius.pill }}>
          <IconButton icon="torch" label={torch ? 'Turn light off' : 'Turn light on'} onPress={() => setTorch((t) => !t)} />
        </View>
      </View>
    </View>
  );
}
