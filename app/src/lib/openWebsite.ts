import { Alert, Linking } from 'react-native';

/**
 * A token's or NFT's project website is chosen by its creator, not by NOID.
 * Show the host and ask before leaving the app.
 */
export function openProjectWebsite(url: string) {
  const host = /^https:\/\/([^/?#]+)/.exec(url)?.[1];
  if (!host) return;
  Alert.alert(
    `Open ${host}?`,
    'This website belongs to whoever created this token, not to NOID. Never type your secret into a website.',
    [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Open', onPress: () => void Linking.openURL(url) },
    ],
  );
}
