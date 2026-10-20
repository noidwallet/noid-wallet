/**
 * Fired when the wallet re-locks after time in the background. The screens
 * underneath stay as they were (so a half-filled send survives a trip to
 * WhatsApp), but screens that show a secret or gift link drop it at once.
 */
type Listener = () => void;
const listeners = new Set<Listener>();

export function onRelock(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function emitRelock() {
  for (const l of listeners) l();
}
