import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';

import { toast } from '@/components/ui';

/** Copy with a light tap and a "copied" toast. */
export async function copyText(text: string, what: string) {
  await Clipboard.setStringAsync(text);
  void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  toast(`${what} copied`);
}

/**
 * Which copy button was just used, for 1.5 s: copy icons turn into a check
 * where you tapped, so you see it worked without looking for the toast.
 */
export function useCopied(ms = 1500) {
  const [which, setWhich] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const mark = useCallback(
    (key = 'copy') => {
      setWhich(key);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setWhich(null), ms);
    },
    [ms],
  );
  return { isCopied: (key = 'copy') => which === key, mark };
}

// Something worth money (a gift link) is wiped from the clipboard after a
// minute. Android only lets the app on screen read the clipboard, so the check
// runs when the timer fires while NOID is open, or else the next time NOID
// comes back to the front.
const SENSITIVE_FOR_MS = 60_000;
let sensitive: { text: string; until: number } | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;

async function wipeIfStillThere() {
  const s = sensitive;
  if (!s || Date.now() < s.until) return;
  if (AppState.currentState !== 'active') return; // try again when NOID is back on screen
  sensitive = null;
  try {
    if ((await Clipboard.getStringAsync()) === s.text) await Clipboard.setStringAsync('');
  } catch {
    // clipboard unavailable: nothing to do
  }
}

AppState.addEventListener('change', (state) => {
  if (state === 'active') void wipeIfStillThere();
});

export async function copySensitive(text: string, what: string) {
  await copyText(text, what);
  sensitive = { text, until: Date.now() + SENSITIVE_FOR_MS };
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => void wipeIfStillThere(), SENSITIVE_FOR_MS + 500);
}
