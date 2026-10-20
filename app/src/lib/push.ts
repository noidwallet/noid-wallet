// Opt-in "NOID received" notifications. The phone's push token and public
// address are registered with your wallet server, which sends a notification
// when it indexes a payment to that address. Nothing secret is involved.
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

import type { Api } from './api';

let handlerSet = false;

/** Show notifications while the app is open too. */
export function setupNotificationHandler() {
  if (handlerSet) return;
  handlerSet = true;
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
    }),
  });
}

export async function enablePush(api: Api, address: string): Promise<string> {
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('payments', {
      name: 'Payments received',
      importance: Notifications.AndroidImportance.HIGH,
    });
  }
  const perm = await Notifications.requestPermissionsAsync();
  if (!perm.granted) throw new Error('Notifications are off for NOID. Turn them on in your phone’s app settings.');
  let token: string;
  try {
    token = String((await Notifications.getDevicePushTokenAsync()).data);
  } catch {
    throw new Error('This version of NOID is not set up for notifications yet.');
  }
  await api.pushSubscribe(address, token);
  return token;
}

export async function disablePush(api: Api, address: string, token: string) {
  await api.pushUnsubscribe(address, token).catch(() => {});
}

/** Re-register if Firebase rotates the token. */
export function onPushTokenChange(fn: (token: string) => void) {
  const sub = Notifications.addPushTokenListener((t) => fn(String(t.data)));
  return () => sub.remove();
}
