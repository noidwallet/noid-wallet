import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useFonts, JetBrainsMono_500Medium, JetBrainsMono_700Bold } from '@expo-google-fonts/jetbrains-mono';
import { ActivityIndicator, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { ToastHost } from '@/components/ui';
import { setupNotificationHandler } from '@/lib/push';
import { WalletProvider, useWallet } from '@/state/wallet';
import { colors } from '@/theme';

setupNotificationHandler();
function Routes() {
  const { loading, meta, locked } = useWallet();
  if (loading) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }
  const hasWallet = !!meta;
  return (
    <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg }, animation: 'fade' }}>
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
        <Stack.Screen name="gifts" options={{ animation: 'slide_from_right' }} />
        <Stack.Screen name="gift-new" options={{ animation: 'slide_from_right' }} />
        <Stack.Screen name="gift/[index]" options={{ animation: 'slide_from_right' }} />
        <Stack.Screen name="claim" options={{ animation: 'slide_from_bottom' }} />
        <Stack.Screen name="request" options={{ animation: 'slide_from_right' }} />
        <Stack.Screen name="contacts" options={{ animation: 'slide_from_right' }} />
        <Stack.Screen name="activity" options={{ animation: 'slide_from_right' }} />
        <Stack.Screen name="remove-wallet" options={{ animation: 'slide_from_right' }} />
      </Stack.Protected>
      {/* Reachable before a wallet exists and while unlocked, never behind the lock. */}
      <Stack.Protected guard={!hasWallet || !locked}>
        <Stack.Screen name="server" options={{ animation: 'slide_from_right' }} />
      </Stack.Protected>
    </Stack>
  );
}

export default function RootLayout() {
  const [fontsLoaded] = useFonts({ JetBrainsMono_500Medium, JetBrainsMono_700Bold });
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
