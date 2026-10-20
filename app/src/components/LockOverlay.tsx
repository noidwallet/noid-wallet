import { useEffect } from 'react';
import { BackHandler, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { LockView } from '@/components/LockView';
import { colors } from '@/theme';

/**
 * Covers the app after it re-locks from the background. The screens below
 * keep their state, so the user lands back exactly where they were.
 */
export function LockOverlay() {
  // Back must not reveal or close what is underneath.
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => true);
    return () => sub.remove();
  }, []);
  return (
    <View style={[StyleSheet.absoluteFill, { backgroundColor: colors.bg, zIndex: 100, elevation: 100 }]} accessibilityViewIsModal>
      <SafeAreaView style={{ flex: 1 }} edges={['top', 'bottom']}>
        <LockView subtitle="Unlock to pick up where you left off." />
      </SafeAreaView>
    </View>
  );
}
