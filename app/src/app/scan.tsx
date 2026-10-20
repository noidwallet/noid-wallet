import { useRef } from 'react';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { Linking, Pressable, Text, View } from 'react-native';

import { Body, Button, Screen, Title } from '@/components/ui';
import { goBack } from '@/lib/nav';
import { scanResult } from '@/lib/scan';
import { colors, radius, space } from '@/theme';

export default function Scan() {
  const [permission, requestPermission] = useCameraPermissions();
  const done = useRef(false);

  if (!permission) return <Screen>{null}</Screen>;
  if (!permission.granted) {
    return (
      <Screen>
        <Title>Scan a NOID QR code</Title>
        <Body muted>Allow camera access to scan a NOID address QR code. The camera is only used on this screen.</Body>
        {permission.canAskAgain ? (
          <Button title="Allow camera" onPress={requestPermission} />
        ) : (
          <>
            <Body muted>Camera access was turned off for NOID. Turn it on in your phone’s app settings, or paste the address instead.</Body>
            <Button title="Open app settings" kind="secondary" onPress={() => Linking.openSettings()} />
          </>
        )}
        <Button title="Cancel" kind="ghost" onPress={() => goBack()} />
      </Screen>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: '#000' }}>
      <CameraView
        style={{ flex: 1 }}
        facing="back"
        barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
        onBarcodeScanned={(r) => {
          if (done.current) return;
          done.current = true;
          scanResult.set(r.data);
          goBack();
        }}
      />
      <View style={{ position: 'absolute', left: 0, right: 0, bottom: 48, alignItems: 'center', gap: space.md }}>
        <Text style={{ color: '#fff', fontSize: 16, backgroundColor: 'rgba(0,0,0,0.55)', paddingHorizontal: 14, paddingVertical: 8, borderRadius: radius.sm }}>
          Point at a NOID QR code
        </Text>
        <Pressable accessibilityRole="button" onPress={() => goBack()} hitSlop={16}>
          <Text style={{ color: colors.accent, fontSize: 16, fontWeight: '600', padding: 12 }}>Cancel</Text>
        </Pressable>
      </View>
    </View>
  );
}
