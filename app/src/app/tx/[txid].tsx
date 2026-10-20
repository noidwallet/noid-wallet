import { useEffect, useState } from 'react';
import { useLocalSearchParams } from 'expo-router';
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import { Text, View } from 'react-native';

import { makeFiatOf, makeNameOf, TX_LABEL, when } from '@/components/TxRow';
import { Avatar, Banner, Card, IconButton, KeyValue, Pill, Screen, Skeleton, toast } from '@/components/ui';
import { formatNoid } from '@/lib/amount';
import type { TxStatus } from '@/lib/api';
import { groupAddress } from '@/lib/safety';
import { useWallet } from '@/state/wallet';
import { colors, fonts, space, type } from '@/theme';

async function copy(text: string, what: string) {
  await Clipboard.setStringAsync(text);
  void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  toast(`${what} copied`);
}

export default function TxDetail() {
  const { txid } = useLocalSearchParams<{ txid: string }>();
  const { api, history, pending, contacts, price, settings } = useWallet();
  const [status, setStatus] = useState<TxStatus | null>(null);
  const [lookupDone, setLookupDone] = useState(false);
  const item = history.find((h) => h.txid === txid);
  const pend = pending.find((p) => p.txid === txid);
  const nameOf = makeNameOf(contacts);
  const fiatOf = makeFiatOf(price, settings.currency);

  useEffect(() => {
    if (!txid) return;
    api
      .tx(txid)
      .then(setStatus, () => {})
      .finally(() => setLookupDone(true));
  }, [api, txid]);

  const confirmed = status?.status === 'confirmed' || (!!item && !pend);
  const pill = confirmed
    ? { text: status?.status === 'confirmed' ? `Confirmed · ${status.confirmations}` : 'Confirmed', tone: 'success' as const }
    : pend || status?.status === 'pending'
      ? { text: 'Pending', tone: 'warn' as const }
      : { text: 'Checking…', tone: 'neutral' as const };

  const outgoing = item ? item.direction === 'sent' || item.direction === 'self' || item.direction === 'contract' : pend?.kind !== 'claim';
  const amount = item
    ? item.direction === 'self'
      ? item.fee
      : item.amount
    : pend
      ? pend.kind === 'consolidate'
        ? pend.fee
        : pend.amount
      : null;
  const fiatValue = amount !== null ? fiatOf(amount) : null;
  const label = item ? TX_LABEL[item.direction] : pend
      ? pend.kind === 'claim'
        ? 'Gift claim'
        : pend.kind === 'gift'
          ? 'Gift card'
          : pend.kind === 'consolidate'
            ? 'Merging coins'
            : 'Sending'
      : 'Transaction';
  const counterparty = item?.counterparty && item.direction !== 'self' ? item.counterparty : pend?.to ?? null;
  const partyLabel = item?.direction === 'received' || pend?.kind === 'claim' ? 'From' : 'To';

  return (
    <Screen header={{ title: 'Transaction' }}>
      <View style={{ alignItems: 'center', gap: space.sm, paddingVertical: space.md }}>
        <Avatar icon={outgoing ? 'send' : 'receive'} tone={outgoing ? 'neutral' : 'success'} size={56} />
        <Text style={type.title}>{label}</Text>
        {amount !== null ? (
          <Text style={[type.display, { color: outgoing ? colors.text : colors.accent }]}>
            {outgoing ? '−' : '+'}
            {formatNoid(amount)}
          </Text>
        ) : !lookupDone ? (
          <Skeleton width={160} height={40} />
        ) : null}
        {amount !== null ? <Text style={{ color: colors.accent, fontFamily: fonts.monoBold }}>NOID</Text> : null}
        {amount !== null && fiatValue ? <Text style={type.bodySm}>{fiatValue} at today’s price</Text> : null}
        <Pill text={pill.text} tone={pill.tone} />
      </View>

      {!item && !pend && lookupDone && status?.status !== 'confirmed' && status?.status !== 'pending' ? (
        <Banner tone="neutral">This transaction isn’t on this wallet’s server yet. It may still be on its way.</Banner>
      ) : null}

      {counterparty ? (
        <Card>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
            <Text style={type.caption}>{partyLabel}</Text>
            <IconButton icon="copy" label="Copy address" size={36} onPress={() => void copy(counterparty, 'Address')} />
          </View>
          <Text style={type.title}>{nameOf(counterparty)}</Text>
          <Text selectable style={[type.monoSm, { lineHeight: 20 }]}>
            {groupAddress(counterparty)}
          </Text>
        </Card>
      ) : null}

      {item || pend?.fee || status?.status === 'confirmed' ? (
      <Card>
        {item ? <KeyValue label="Date" value={when(item.time)} mono={false} /> : null}
        {(item?.fee || pend?.fee) ? <KeyValue label="Network fee" value={`${formatNoid(item?.fee || pend?.fee || 0)} NOID`} /> : null}
        {item ? <KeyValue label="Block" value={item.height.toLocaleString()} /> : null}
        {status?.status === 'confirmed' ? <KeyValue label="Confirmations" value={String(status.confirmations)} /> : null}
      </Card>
      ) : null}

      <Card>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
          <Text style={type.caption}>Transaction ID</Text>
          {txid ? <IconButton icon="copy" label="Copy transaction ID" size={36} onPress={() => void copy(txid, 'Transaction ID')} /> : null}
        </View>
        <Text selectable style={[type.monoSm, { lineHeight: 20 }]}>
          {txid}
        </Text>
      </Card>
    </Screen>
  );
}
