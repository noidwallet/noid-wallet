import { Pressable, Text, View } from 'react-native';

import { formatNoid, shortAddress } from '@/lib/amount';
import { go } from '@/lib/nav';
import type { HistoryItem } from '@/lib/api';
import type { PendingTx } from '@/lib/storage';
import { colors, fonts, space } from '@/theme';

export const TX_LABEL: Record<HistoryItem['direction'], string> = {
  sent: 'Sent',
  received: 'Received',
  self: 'Merged coins',
  mined: 'Mined',
  contract: 'Contract',
};

function when(unixSeconds: number) {
  const d = new Date(unixSeconds * 1000);
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function HistoryRow({ item }: { item: HistoryItem }) {
  const outgoing = item.direction === 'sent' || item.direction === 'self' || item.direction === 'contract';
  const shown = item.direction === 'self' ? item.fee : item.amount + (item.direction === 'sent' ? item.fee : 0);
  return (
    <Pressable
      accessibilityRole="button"
      onPress={() => go({ pathname: '/tx/[txid]', params: { txid: item.txid } })}
      style={({ pressed }) => [row, pressed && { opacity: 0.6 }]}
    >
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={{ color: colors.text, fontSize: 16, fontWeight: '600' }}>{TX_LABEL[item.direction]}</Text>
        <Text style={{ color: colors.muted, fontSize: 13 }}>
          {item.counterparty && item.direction !== 'self' ? `${shortAddress(item.counterparty, 4)} · ` : ''}
          {when(item.time)}
        </Text>
      </View>
      <Text style={{ fontFamily: fonts.mono, fontSize: 15, color: outgoing ? colors.text : colors.accent }}>
        {item.direction === 'contract' ? '' : outgoing ? '−' : '+'}
        {formatNoid(shown)}
      </Text>
    </Pressable>
  );
}

export function PendingRow({ item }: { item: PendingTx }) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={() => go({ pathname: '/tx/[txid]', params: { txid: item.txid } })}
      style={({ pressed }) => [row, pressed && { opacity: 0.6 }]}
    >
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={{ color: colors.warn, fontSize: 16, fontWeight: '600' }}>
          {PENDING_LABEL[item.kind]} ·{' '}
          {item.state === 'submitting' ? 'checking with the network' : 'waiting for a block'}
        </Text>
        <Text style={{ color: colors.muted, fontSize: 13 }}>
          {item.kind === 'claim' ? 'Into your wallet' : item.kind === 'gift' ? 'Gift card' : item.to ? shortAddress(item.to, 4) : 'To yourself'}
        </Text>
      </View>
      <Text style={{ fontFamily: fonts.mono, fontSize: 15, color: item.kind === 'claim' ? colors.accent : colors.text }}>
        {item.kind === 'claim'
          ? `+${formatNoid(item.amount)}`
          : `−${formatNoid(item.kind === 'consolidate' ? item.fee : item.amount + item.fee)}`}
      </Text>
    </Pressable>
  );
}

const PENDING_LABEL: Record<PendingTx['kind'], string> = {
  send: 'Sending',
  consolidate: 'Merging coins',
  gift: 'Creating gift card',
  claim: 'Claiming gift',
};

const row = {
  flexDirection: 'row' as const,
  alignItems: 'center' as const,
  gap: space.md,
  paddingVertical: space.md,
  borderBottomWidth: 1,
  borderBottomColor: colors.line,
};
