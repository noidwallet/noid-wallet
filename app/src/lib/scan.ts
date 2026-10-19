// Hand-off between the QR scanner and the send screen.
let last: string | null = null;
export const scanResult = {
  set(v: string) {
    last = v;
  },
  take(): string | null {
    const v = last;
    last = null;
    return v;
  },
};

/** Accepts a bare address or a `noid:<address>?amount=<NOID>` link. */
export function parsePaymentQr(data: string): { address: string; amount?: string } {
  const trimmed = data.trim();
  const m = /^(?:noid:)?(o1[0-9a-z]+)(?:\?(.*))?$/i.exec(trimmed);
  if (!m) return { address: trimmed };
  const params = new URLSearchParams(m[2] ?? '');
  const amount = params.get('amount') ?? undefined;
  return { address: m[1]!.toLowerCase(), amount };
}
