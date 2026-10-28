import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { Inter_400Regular, Inter_500Medium, Inter_600SemiBold, Inter_700Bold } from '@expo-google-fonts/inter';
import { useFonts, JetBrainsMono_500Medium, JetBrainsMono_700Bold } from '@expo-google-fonts/jetbrains-mono';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { LockOverlay } from '@/components/LockOverlay';
import { ToastHost } from '@/components/ui';
import { setupNotificationHandler } from '@/lib/push';
import { storage } from '@/lib/storage';
import { WalletProvider, useWallet } from '@/state/wallet';
import { colors } from '@/theme';

setupNotificationHandler();

/**
 * Last line of defence if a screen fails to draw (for example on data a
 * wallet server should never have sent). Your secret is untouched: this only
 * offers to try again, or to drop the saved activity and load it afresh.
 */
export function ErrorBoundary({ retry }: { error: Error; retry: () => Promise<void> }) {
  const button = (title: string, onPress: () => void) => (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => ({
        backgroundColor: colors.s1,
        borderRadius: 14,
        paddingVertical: 14,
        paddingHorizontal: 20,
        opacity: pressed ? 0.7 : 1,
        alignSelf: 'stretch',
      })}
    >
      <Text style={{ color: colors.text, textAlign: 'center', fontSize: 16 }}>{title}</Text>
    </Pressable>
  );
  return (
    <View style={{ flex: 1, backgroundColor: colors.bg, padding: 24, justifyContent: 'center', gap: 16 }}>
      <Text style={{ color: colors.text, fontSize: 20, fontWeight: '700' }}>Something went wrong</Text>
      <Text style={{ color: colors.textSecondary, fontSize: 15, lineHeight: 22 }}>
        This screen could not be shown. Your wallet and secret are safe. Try again, or reload your activity from the wallet server.
      </Text>
      {button('Try again', () => void retry())}
      {button('Reload activity', () => {
        storage.clearSnapshot();
        void retry();
      })}
    </View>
  );
}

function Routes() {
  const { loading, meta, locked, paused } = useWallet();
  if (loading) {
    return (
      <View
        style={{
          flex: 1,
          backgroundColor: colors.bg,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }
  const hasWallet = !!meta;
  const covered = hasWallet && !locked && paused;
  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      {/* While the lock cover is up, screen readers must not read the wallet behind it. */}
      <View
        style={{ flex: 1 }}
        importantForAccessibility={covered ? 'no-hide-descendants' : 'auto'}
        accessibilityElementsHidden={covered}
      >
        <Stack
          screenOptions={{
            headerShown: false,
            contentStyle: { backgroundColor: colors.bg },
            animation: 'fade',
          }}
        >
          {/* First on purpose: whenever the current screen stops being allowed
            (wallet locked, removed or created), the app falls back here and
            `/` picks welcome, lock or home. */}
          <Stack.Screen name="index" />
          <Stack.Protected guard={!hasWallet}>
            <Stack.Screen name="welcome" />
            <Stack.Screen name="create" options={{ animation: 'slide_from_right' }} />
            <Stack.Screen name="restore" options={{ animation: 'slide_from_right' }} />
            <Stack.Screen name="photo" options={{ animation: 'slide_from_right' }} />
          </Stack.Protected>
          <Stack.Protected guard={hasWallet && locked}>
            <Stack.Screen name="lock" />
          </Stack.Protected>
          <Stack.Protected guard={hasWallet && !locked}>
            <Stack.Screen name="home" />
            <Stack.Screen name="send" options={{ animation: 'slide_from_right' }} />
            <Stack.Screen name="scan" options={{ animation: 'slide_from_bottom' }} />
            <Stack.Screen name="receive" options={{ animation: 'slide_from_right' }} />
            <Stack.Screen name="consolidate" options={{ animation: 'slide_from_right' }} />
            <Stack.Screen name="settings" options={{ animation: 'slide_from_right' }} />
            <Stack.Screen name="backup" options={{ animation: 'slide_from_right' }} />
            <Stack.Screen name="tx/[txid]" options={{ animation: 'slide_from_right' }} />
            <Stack.Screen name="assets" options={{ animation: 'slide_from_right' }} />
            <Stack.Screen name="token/[id]" options={{ animation: 'slide_from_right' }} />
            <Stack.Screen name="nft/[id]" options={{ animation: 'slide_from_right' }} />
            <Stack.Screen name="gifts" options={{ animation: 'slide_from_right' }} />
            <Stack.Screen name="gift-new" options={{ animation: 'slide_from_right' }} />
            <Stack.Screen name="gift/[index]" options={{ animation: 'slide_from_right' }} />
            <Stack.Screen name="claim" options={{ animation: 'slide_from_bottom' }} />
            <Stack.Screen name="request" options={{ animation: 'slide_from_right' }} />
            <Stack.Screen name="contacts" options={{ animation: 'slide_from_right' }} />
            <Stack.Screen name="activity" options={{ animation: 'slide_from_right' }} />
            <Stack.Screen name="remove-wallet" options={{ animation: 'slide_from_right' }} />
            <Stack.Screen name="currency" options={{ animation: 'slide_from_right' }} />
          </Stack.Protected>
          {/* Reachable before a wallet exists and while unlocked, never behind the lock. */}
          <Stack.Protected guard={!hasWallet || !locked}>
            <Stack.Screen name="server" options={{ animation: 'slide_from_right' }} />
            <Stack.Screen name="safety" options={{ animation: 'slide_from_right' }} />
          </Stack.Protected>
        </Stack>
      </View>
      {covered ? <LockOverlay /> : null}
    </View>
  );
}

export default function RootLayout() {
  const [fontsLoaded] = useFonts({
    Inter_400Regular,
    Inter_500Medium,
    Inter_600SemiBold,
    Inter_700Bold,
    JetBrainsMono_500Medium,
    JetBrainsMono_700Bold,
  });
  if (!fontsLoaded) return <View style={{ flex: 1, backgroundColor: colors.bg }} />;
  return (
    <SafeAreaProvider>
      <WalletProvider>
        <StatusBar style="light" />
        <Routes />
        <ToastHost />
      </WalletProvider>
    </SafeAreaProvider>
  );
}
