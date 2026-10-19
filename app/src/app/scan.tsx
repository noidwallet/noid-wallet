import { useRef } from 'react';
import { router } from 'expo-router';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { Text, View } from 'react-native';

import { Body, Button, Screen, Title } from '@/components/ui';
import { scanResult } from '@/lib/scan';
import { colors, radius, space } from '@/theme';

export default function Scan() {
  const [permission, requestPermission] = useCameraPermissions();
  const done = useRef(false);

  if (!permission) return <Screen>{null}</Screen>;
  if (!permission.granted) {
    return (
      <Screen>
        <Title>Scan an address</Title>
        <Body muted>Allow camera access to scan a NOID address QR code. The camera is only used on this screen.</Body>
        <Button title="Allow camera" onPress={requestPermission} />
        <Button title="Cancel" kind="ghost" onPress={() => router.back()} />
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
          router.back();
        }}
      />
      <View style={{ position: 'absolute', left: 0, right: 0, bottom: 48, alignItems: 'center', gap: space.md }}>
        <Text style={{ color: '#fff', fontSize: 16, backgroundColor: 'rgba(0,0,0,0.55)', paddingHorizontal: 14, paddingVertical: 8, borderRadius: radius.sm }}>
          Point at a NOID address QR code
        </Text>
        <Text onPress={() => router.back()} style={{ color: colors.accent, fontSize: 16, padding: 12 }}>
          Cancel
        </Text>
      </View>
    </View>
  );
}
