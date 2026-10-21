import { useEffect, useState } from 'react';
import { useLocalSearchParams } from 'expo-router';
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import { Text, View } from 'react-native';

import { makeFiatOf, makeNameOf, TX_LABEL, when } from '@/components/TxRow';
import { Avatar, Banner, Card, IconButton, KeyValue, Pill, Screen, Skeleton, toast } from '@/components/ui';
import { formatNoid } from '@/lib/amount';
import type { TxStatus } from '@/lib/api';
import { useCopied } from '@/lib/clip';
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
  const copied = useCopied();
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
    ? { text: 'Confirmed', tone: 'success' as const }
    : pend || status?.status === 'pending'
      ? { text: 'Pending', tone: 'warn' as const }
      : { text: 'Checking…', tone: 'neutral' as const };

  const outgoing = item ? item.direction === 'sent' || item.direction === 'self' || item.direction === 'contract' : pend?.kind !== 'claim';
  // Same total as the activity row: what left the wallet, fee included.
  const base = item ? (item.direction === 'self' ? 0 : item.amount) : pend ? (pend.kind === 'consolidate' ? 0 : pend.amount) : null;
  const feePart = item ? (item.direction === 'sent' || item.direction === 'self' ? item.fee : 0) : pend && pend.kind !== 'claim' ? pend.fee : 0;
  const walletPart = item ? (item.direction === 'sent' ? (item.walletFee ?? 0) : 0) : pend && pend.kind !== 'claim' ? (pend.walletFee ?? 0) : 0;
  const amount = base === null ? null : base + feePart + walletPart;
  const fiatValue = amount !== null ? fiatOf(amount) : null;
  const label = item ? TX_LABEL[item.direction] : pend
      ? pend.kind === 'claim'
        ? 'Gift claim'
        : pend.kind === 'gift'
          ? 'Gift card'
          : pend.kind === 'consolidate'
            ? pend.confirmedAt
              ? 'Combined pieces'
              : 'Combining pieces'
            : pend.confirmedAt
              ? 'Sent'
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
          <Text adjustsFontSizeToFit numberOfLines={1} maxFontSizeMultiplier={1.3} style={[type.display, { color: outgoing ? colors.text : colors.accent }]}>
            {outgoing ? '−' : '+'}
            {formatNoid(amount)}
          </Text>
        ) : !lookupDone ? (
          <Skeleton width={160} height={40} />
        ) : null}
        {amount !== null ? <Text style={{ color: colors.accent, fontFamily: fonts.monoBold }}>NOID</Text> : null}
        {base !== null && base > 0 && feePart > 0 ? (
          <Text style={type.bodySm}>
            {formatNoid(base)} NOID + {formatNoid(feePart)} network fee
            {walletPart > 0 ? ` + ${formatNoid(walletPart)} wallet fee` : ''}
          </Text>
        ) : null}
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
            <IconButton
              icon={copied.isCopied('address') ? 'check' : 'copy'}
              label={copied.isCopied('address') ? 'Address copied' : 'Copy address'}
              size={36}
              onPress={() => {
                copied.mark('address');
                void copy(counterparty, 'Address');
              }}
            />
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
        {walletPart > 0 ? <KeyValue label="NOID wallet fee" value={`${formatNoid(walletPart)} NOID`} /> : null}
        {item ? <KeyValue label="Block" value={item.height.toLocaleString()} /> : null}
        {status?.status === 'confirmed' ? <KeyValue label="Confirmations" value={String(status.confirmations)} /> : null}
      </Card>
      ) : null}

      <Card>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
          <Text style={type.caption}>Transaction ID</Text>
          {txid ? <IconButton
              icon={copied.isCopied('txid') ? 'check' : 'copy'}
              label={copied.isCopied('txid') ? 'Transaction ID copied' : 'Copy transaction ID'}
              size={36}
              onPress={() => {
                copied.mark('txid');
                void copy(txid, 'Transaction ID');
              }}
            /> : null}
        </View>
        <Text selectable style={[type.monoSm, { lineHeight: 20 }]}>
          {txid}
        </Text>
      </Card>
    </Screen>
  );
}
