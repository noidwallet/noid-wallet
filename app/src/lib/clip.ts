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
 * Copy something that is worth money (a gift link). The clipboard is cleared
 * after a minute if it still holds it, so other apps can't read it later.
 */
export async function copySensitive(text: string, what: string) {
  await copyText(text, what);
  setTimeout(() => {
    void Clipboard.getStringAsync()
      .then((now) => (now === text ? Clipboard.setStringAsync('') : undefined))
      .catch(() => {});
  }, 60_000);
}
