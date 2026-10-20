import { Avatar, ListRow } from '@/components/ui';
import { formatNoid, shortAddress } from '@/lib/amount';
import type { HistoryItem } from '@/lib/api';
import { go } from '@/lib/nav';
import type { PendingTx } from '@/lib/storage';
import { colors } from '@/theme';
import type { IconName } from '@/components/Icon';

export const TX_LABEL: Record<HistoryItem['direction'], string> = {
  sent: 'Sent',
  received: 'Received',
  self: 'Merged coins',
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

export function HistoryRow({ item, nameOf }: { item: HistoryItem; nameOf: NameOf }) {
  const outgoing = item.direction === 'sent' || item.direction === 'self' || item.direction === 'contract';
  const shown = item.direction === 'self' ? item.fee : item.amount + (item.direction === 'sent' ? item.fee : 0);
  const who = item.counterparty && item.direction !== 'self' ? nameOf(item.counterparty) : null;
  const sign = item.direction === 'contract' ? '' : outgoing ? '−' : '+';
  return (
    <ListRow
      leading={<Avatar icon={TX_ICON[item.direction]} tone={outgoing ? 'neutral' : 'success'} />}
      title={who && item.direction !== 'mined' ? `${TX_LABEL[item.direction]} · ${who}` : TX_LABEL[item.direction]}
      subtitle={when(item.time)}
      value={`${sign}${formatNoid(shown)}`}
      valueColor={outgoing ? colors.text : colors.accent}
      onPress={() => go({ pathname: '/tx/[txid]', params: { txid: item.txid } })}
      accessibilityLabel={`${TX_LABEL[item.direction]} ${formatNoid(shown)} NOID${who ? `, ${who}` : ''}, ${when(item.time)}`}
    />
  );
}

const PENDING_LABEL: Record<PendingTx['kind'], string> = {
  send: 'Sending',
  consolidate: 'Merging coins',
  gift: 'Creating gift card',
  claim: 'Claiming gift',
};

export function PendingRow({ item, nameOf }: { item: PendingTx; nameOf: NameOf }) {
  const incoming = item.kind === 'claim';
  const value = incoming
    ? `+${formatNoid(item.amount)}`
    : `−${formatNoid(item.kind === 'consolidate' ? item.fee : item.amount + item.fee)}`;
  const where =
    item.kind === 'claim' ? 'Into your wallet' : item.kind === 'gift' ? 'Gift card' : item.to ? nameOf(item.to) : 'To yourself';
  const state = item.state === 'submitting' ? 'Checking with the network' : 'Waiting for a block';
  return (
    <ListRow
      leading={<Avatar icon="clock" tone="warn" />}
      title={`${PENDING_LABEL[item.kind]} · ${where}`}
      subtitle={state}
      value={value}
      valueColor={incoming ? colors.accent : colors.text}
      onPress={() => go({ pathname: '/tx/[txid]', params: { txid: item.txid } })}
    />
  );
}

export function makeNameOf(contacts: { name: string; address: string }[]): NameOf {
  const map = new Map(contacts.map((c) => [c.address, c.name]));
  return (address) => map.get(address) ?? shortAddress(address, 4);
}
