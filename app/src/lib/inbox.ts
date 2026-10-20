// A NOID link that opened the app (gift card or payment request), held until
// the right screen is ready for it: after unlock, or after a wallet exists.
import { useSyncExternalStore } from 'react';

import type { ParsedLink } from './links';

let current: ParsedLink | null = null;
const listeners = new Set<() => void>();

export const inbox = {
  set(link: ParsedLink) {
    current = link;
    listeners.forEach((l) => l());
  },
  peek: () => current,
  /** Read and clear, so a link is only acted on once. */
  take(): ParsedLink | null {
    const v = current;
    current = null;
    if (v) listeners.forEach((l) => l());
    return v;
  },
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};

export function useInbox(): ParsedLink | null {
  return useSyncExternalStore(inbox.subscribe, inbox.peek, inbox.peek);
}
