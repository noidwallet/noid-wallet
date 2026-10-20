import Constants from 'expo-constants';

/** Web address used in gift and payment links (the landing pages live there). */
export const LINK_BASE = ((Constants.expoConfig?.extra?.linkBaseUrl as string | undefined) ?? 'https://noidusa.com').replace(/\/+$/, '');

/** Hosts whose /g and /pay links NOID opens. */
export const LINK_HOSTS = (() => {
  const host = new URL(LINK_BASE).host.toLowerCase();
  return host.startsWith('www.') ? [host, host.slice(4)] : [host, `www.${host}`];
})();
