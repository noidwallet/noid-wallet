import type { RefObject } from 'react';
import type { View } from 'react-native';
import { File } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { captureRef } from 'react-native-view-shot';

// Image files written for sharing live in the cache. The share sheet can return
// before the receiving app has read the file, so each one is removed a few
// minutes later, and any left over when the screen closes are removed then.

const pending = new Set<string>();

export function removeSharedFiles() {
  for (const uri of pending) removeFile(uri);
  pending.clear();
}

function removeFile(uri: string) {
  try {
    new File(uri).delete();
  } catch {
    // already gone
  }
}

/**
 * Capture a view as a PNG (`width` px wide, same shape as on screen) and open
 * the phone's share sheet: WhatsApp, Telegram, Discord, X and the rest.
 */
export async function shareViewAsImage(
  view: RefObject<View | null>,
  opts: { size: { width: number; height: number }; width?: number; dialogTitle: string },
): Promise<void> {
  if (!view.current || !opts.size.width || !opts.size.height) throw new Error('The image isn’t ready yet. Try again in a moment.');
  const width = opts.width ?? 1080;
  const height = Math.round((width * opts.size.height) / opts.size.width);
  const uri = await captureRef(view, { format: 'png', quality: 1, result: 'tmpfile', width, height });
  pending.add(uri);
  setTimeout(() => {
    removeFile(uri);
    pending.delete(uri);
  }, 5 * 60_000);
  await Sharing.shareAsync(uri, { mimeType: 'image/png', dialogTitle: opts.dialogTitle });
}
