// Links that open NOID (gift cards, payment requests) are held in the inbox and
// the app goes to `/`, which shows the right screen for the wallet's state:
// home claims or pays once unlocked; welcome explains a gift needs a wallet.
import { LINK_HOSTS } from '@/lib/config';
import { inbox } from '@/lib/inbox';
import { parseLink } from '@/lib/links';

export function redirectSystemPath({ path }: { path: string; initial: boolean }): string | null {
  try {
    const link = parseLink(path, LINK_HOSTS);
    if (link) inbox.set(link);
    // Never let another app deep-link into an arbitrary screen.
    return '/';
  } catch {
    return '/';
  }
}
