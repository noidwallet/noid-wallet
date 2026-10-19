import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useFonts, JetBrainsMono_500Medium, JetBrainsMono_700Bold } from '@expo-google-fonts/jetbrains-mono';
import { ActivityIndicator, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { WalletProvider, useWallet } from '@/state/wallet';
import { colors } from '@/theme';

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
      <Stack.Screen name="server" options={{ animation: 'slide_from_right' }} />
      <Stack.Protected guard={!hasWallet}>
        <Stack.Screen name="welcome" />
        <Stack.Screen name="create" />
        <Stack.Screen name="restore" />
        <Stack.Screen name="photo" />
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
      </WalletProvider>
    </SafeAreaProvider>
  );
}
