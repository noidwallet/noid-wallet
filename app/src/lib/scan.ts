// One-shot hand-offs between screens (scanner -> send, contacts -> send).
function handoff() {
  let last: string | null = null;
  return {
    set(v: string) {
      last = v;
    },
    take(): string | null {
      const v = last;
      last = null;
      return v;
    },
  };
}

export const scanResult = handoff();
export const contactPick = handoff();
/** A screen to open once home is showing (e.g. backup right after a Photo Key wallet). */
export const nextRoute = handoff();
