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
/** What to send, from the picker: "noid", "token:<asset id>" or "nft:<nft key>". */
export const assetPick = handoff();
/** A screen to open once home is showing (e.g. backup right after a Photo Key wallet). */
export const nextRoute = handoff();
