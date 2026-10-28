import { Alert, Linking } from 'react-native';

/**
 * The host a link really goes to, or null when the link should not be offered:
 * only plain https links whose host is ASCII letters, digits, dots and dashes
 * (no user@ part, no backslashes, no look-alike Unicode).
 */
export function websiteHost(url: string): string | null {
  const m = /^https:\/\/([a-z0-9.-]+)(:\d{1,5})?(?:[/?#][^\s\\]*)?$/i.exec(url);
  if (!m || m[1]!.startsWith('.') || m[1]!.includes('..')) return null;
  return m[1]!.toLowerCase();
}

/**
 * A token's or NFT's project website is chosen by its creator, not by NOID.
 * Show the host and ask before leaving the app.
 */
export function openProjectWebsite(url: string) {
  const host = websiteHost(url);
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
