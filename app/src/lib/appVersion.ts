// Comparing this app's version with the versions the wallet server announces.
// Pure (no Expo imports) so it runs in tests.
/** Updates only ever come from here; a server can't point the app elsewhere. */
export const UPDATE_URL = 'https://noidusa.com';

function parts(v: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** True when `a` is a newer x.y.z version than `b`; false if either is malformed. */
export function newerThan(a: string | null | undefined, b: string): boolean {
  const x = a ? parts(a) : null, y = parts(b);
  if (!x || !y) return false;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! > y[i]!;
  return false;
}

/** What the home screen should say about updates, if anything. */
export function updateNotice(app: { latest?: string | null; min?: string | null } | undefined, current: string) {
  if (!app) return null;
  if (newerThan(app.min, current)) return { required: true, version: app.latest && newerThan(app.latest, current) ? app.latest : app.min! };
  if (newerThan(app.latest, current)) return { required: false, version: app.latest! };
  return null;
}
