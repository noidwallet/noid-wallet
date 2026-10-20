import { useCallback } from 'react';
import { BackHandler } from 'react-native';
import { router, useFocusEffect, type Href } from 'expo-router';

/**
 * Navigation helpers used by every screen.
 *
 * - `go` ignores a second tap that lands while the first navigation is still
 *   animating, so a quick double tap never opens a screen twice.
 * - `goBack` always works: when there is no screen underneath (after a relock
 *   or a reload), it goes to `/` instead, which sends the user to the right
 *   place (welcome, lock or home).
 * - `goHome` returns to the existing home screen instead of stacking a new one.
 */

const TAP_GUARD_MS = 600;
let lastNav = 0;

function guarded(fn: () => void) {
  const now = Date.now();
  if (now - lastNav < TAP_GUARD_MS) return;
  lastNav = now;
  fn();
}

export function go(href: Href) {
  guarded(() => router.push(href));
}

export function goBack(fallback: Href = '/') {
  guarded(() => {
    if (router.canGoBack()) router.back();
    else router.replace(fallback);
  });
}

export function goHome() {
  guarded(() => router.dismissTo('/home'));
}

/** Leave the current flow for `/`, which picks welcome, lock or home from the wallet state. */
export function goRoot() {
  router.replace('/');
}

/**
 * Take over Android's hardware/gesture back button while this screen is
 * focused. Return true from `handler` to stay on the screen.
 */
export function useHardwareBack(handler: () => boolean) {
  useFocusEffect(
    useCallback(() => {
      const sub = BackHandler.addEventListener('hardwareBackPress', handler);
      return () => sub.remove();
    }, [handler]),
  );
}
