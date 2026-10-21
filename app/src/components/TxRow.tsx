import { Avatar, ListRow } from '@/components/ui';
import { formatNoid, shortAddress } from '@/lib/amount';
import type { HistoryItem } from '@/lib/api';
import { go } from '@/lib/nav';
import { fiat } from '@/lib/safety';
import type { Currency, PendingTx } from '@/lib/storage';
import { colors } from '@/theme';
import type { IconName } from '@/components/Icon';

export const TX_LABEL: Record<HistoryItem['direction'], string> = {
  sent: 'Sent',
  received: 'Received',
  self: 'Combined pieces',
  mined: 'Mined',
  contract: 'Contract',
};

const TX_ICON: Record<HistoryItem['direction'], IconName> = {
  sent: 'send',
  received: 'receive',
  self: 'merge',
  mined: 'mined',
  contract: 'shield',
};

export function when(unixSeconds: number) {
  const d = new Date(unixSeconds * 1000);
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** Contact name for an address, or its short form. */
export type NameOf = (address: string) => string;
/** Value of an amount in the chosen currency ("≈ ₦755"), or null when off. */
export type FiatOf = (micro: number) => string | null;

export function makeFiatOf(price: { usd: number; ngn: number | null } | null, currency: Currency | undefined): FiatOf {
  return (micro) => fiat(micro, price, currency ?? 'none');
}

const HIDDEN = '••••';

interface RowOpts {
  nameOf: NameOf;
  fiatOf?: FiatOf;
  /** Balance hidden: amounts are masked too. */
  hidden?: boolean;
}

export function HistoryRow({ item, nameOf, fiatOf, hidden }: RowOpts & { item: HistoryItem }) {
  const outgoing = item.direction === 'sent' || item.direction === 'self' || item.direction === 'contract';
  // What left the wallet: amount, network fee and NOID wallet fee.
  const shown = item.direction === 'self' ? item.fee : item.amount + (item.direction === 'sent' ? item.fee + (item.walletFee ?? 0) : 0);
  const who = item.counterparty && item.direction !== 'self' ? nameOf(item.counterparty) : null;
  const sign = item.direction === 'contract' ? '' : outgoing ? '−' : '+';
  return (
    <ListRow
      leading={<Avatar icon={TX_ICON[item.direction]} tone={outgoing ? 'neutral' : 'success'} />}
      title={who && item.direction !== 'mined' ? `${TX_LABEL[item.direction]} · ${who}` : TX_LABEL[item.direction]}
      subtitle={when(item.time)}
      value={hidden ? HIDDEN : `${sign}${formatNoid(shown)}`}
      valueSub={hidden ? null : fiatOf?.(shown)}
      valueColor={outgoing ? colors.text : colors.accent}
      onPress={() => go({ pathname: '/tx/[txid]', params: { txid: item.txid } })}
      accessibilityLabel={`${TX_LABEL[item.direction]}${hidden ? '' : ` ${formatNoid(shown)} NOID`}${who ? `, ${who}` : ''}, ${when(item.time)}`}
    />
  );
}

const PENDING_LABEL: Record<PendingTx['kind'], string> = {
  send: 'Sending',
  consolidate: 'Combining pieces',
  gift: 'Creating gift card',
  claim: 'Claiming gift',
};

/** Shown for the few seconds between "confirmed" and the history row arriving. */
const CONFIRMED_LABEL: Record<PendingTx['kind'], string> = {
  send: 'Sent',
  consolidate: 'Combined pieces',
  gift: 'Gift card',
  claim: 'Gift claimed',
};

export function PendingRow({ item, nameOf, fiatOf, hidden }: RowOpts & { item: PendingTx }) {
  const incoming = item.kind === 'claim';
  const micro = incoming ? item.amount : item.kind === 'consolidate' ? item.fee : item.amount + item.fee + (item.walletFee ?? 0);
  const value = `${incoming ? '+' : '−'}${formatNoid(micro)}`;
  const where =
    item.kind === 'claim' ? 'Into your wallet' : item.kind === 'gift' ? 'Gift card' : item.to ? nameOf(item.to) : 'To yourself';
  const state = item.confirmedAt ? 'Confirmed' : item.state === 'submitting' ? 'Checking with the network' : 'Waiting for a block';
  return (
    <ListRow
      leading={<Avatar icon={item.confirmedAt ? 'check' : 'clock'} tone={item.confirmedAt ? 'success' : 'warn'} />}
      title={`${(item.confirmedAt ? CONFIRMED_LABEL : PENDING_LABEL)[item.kind]} · ${where}`}
      subtitle={state}
      value={hidden ? HIDDEN : value}
      valueSub={hidden ? null : fiatOf?.(micro)}
      valueColor={incoming ? colors.accent : colors.text}
      onPress={() => go({ pathname: '/tx/[txid]', params: { txid: item.txid } })}
    />
  );
}

export function makeNameOf(contacts: { name: string; address: string }[]): NameOf {
  const map = new Map(contacts.map((c) => [c.address, c.name]));
  return (address) => map.get(address) ?? shortAddress(address, 4);
}
