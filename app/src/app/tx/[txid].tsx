import { useEffect, useState } from 'react';
import { useLocalSearchParams } from 'expo-router';
import * as Clipboard from 'expo-clipboard';
import { Text } from 'react-native';

import { Button, Card, KeyValue, Screen, Title } from '@/components/ui';
import { TX_LABEL } from '@/components/TxRow';
import { formatNoid, shortAddress } from '@/lib/amount';
import { goBack } from '@/lib/nav';
import type { TxStatus } from '@/lib/api';
import { useWallet } from '@/state/wallet';
import { colors, fonts } from '@/theme';

export default function TxDetail() {
  const { txid } = useLocalSearchParams<{ txid: string }>();
  const { api, history, pending } = useWallet();
  const [status, setStatus] = useState<TxStatus | null>(null);
  const [copied, setCopied] = useState(false);
  const item = history.find((h) => h.txid === txid);
  const pend = pending.find((p) => p.txid === txid);

  useEffect(() => {
    if (txid) api.tx(txid).then(setStatus, () => {});
  }, [api, txid]);

  const statusText =
    status?.status === 'confirmed'
      ? `Confirmed · ${status.confirmations} confirmation${status.confirmations === 1 ? '' : 's'}`
      : status?.status === 'pending'
        ? 'Waiting for a block'
        : pend
          ? 'Submitted'
          : item
            ? 'Confirmed'
            : 'Checking…';

  return (
    <Screen>
      <Title>Transaction</Title>
      <Text style={{ color: status?.status === 'confirmed' || item ? colors.accent : colors.warn, fontSize: 16, fontWeight: '600' }}>
        {statusText}
      </Text>
      <Card>
        {item ? (
          <>
            <KeyValue label="Type" value={TX_LABEL[item.direction]} mono={false} />
            <KeyValue label="Amount" value={`${formatNoid(item.amount)} NOID`} />
            {item.fee ? <KeyValue label="Fee" value={`${formatNoid(item.fee)} NOID`} /> : null}
            {item.counterparty ? <KeyValue label="Other party" value={shortAddress(item.counterparty)} /> : null}
            <KeyValue label="Block" value={item.height.toLocaleString()} />
          </>
        ) : pend ? (
          <>
            <KeyValue label="Amount" value={`${formatNoid(pend.amount)} NOID`} />
            <KeyValue label="Fee" value={`${formatNoid(pend.fee)} NOID`} />
            {pend.to ? <KeyValue label="To" value={shortAddress(pend.to)} /> : null}
          </>
        ) : null}
      </Card>
      <Text selectable style={{ color: colors.muted, fontFamily: fonts.mono, fontSize: 13 }}>
        {txid}
      </Text>
      <Button
        title={copied ? 'Copied' : 'Copy transaction ID'}
        kind="secondary"
        onPress={async () => {
          if (!txid) return;
          await Clipboard.setStringAsync(txid);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
      />
      <Button title="Back" kind="ghost" onPress={() => goBack()} />
    </Screen>
  );
}
