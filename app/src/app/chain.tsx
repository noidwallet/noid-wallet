import { useState } from 'react';
import { Text, View } from 'react-native';

import { Banner, Body, Button, Card, KeyValue, Pill, Screen } from '@/components/ui';
import { STALE_AFTER_MS, syncChain, useChain } from '@/lib/chain';
import { ago, useNow } from '@/lib/nav';
import { useWallet } from '@/state/wallet';
import { colors, fonts, space, type } from '@/theme';

export default function Chain() {
  const { api, status } = useWallet();
  const chain = useChain();
  const now = useNow();
  const [busy, setBusy] = useState(false);
  const info = chain.info;
  const behind = info && chain.serverTip !== null ? Math.max(0, chain.serverTip - info.tipHeight) : null;
  const tipAge = info ? now - info.tipTimestamp * 1000 : null;
  const stale = chain.kind === 'ready' && tipAge !== null && tipAge > STALE_AFTER_MS;

  const pill =
    chain.kind === 'problem'
      ? { text: 'Problem', tone: 'danger' as const }
      : chain.kind === 'syncing'
        ? { text: 'Checking…', tone: 'neutral' as const }
        : chain.kind === 'ready'
          ? stale
            ? { text: 'Chain verified, behind', tone: 'warn' as const }
            : { text: 'Chain verified', tone: 'success' as const }
          : { text: 'Off', tone: 'neutral' as const };

  async function again() {
    if (!status) return;
    setBusy(true);
    try {
      await syncChain(api, status.height);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen header={{ title: 'Chain check' }}>
      <View style={{ alignItems: 'center', gap: space.sm, paddingVertical: space.md }}>
        <Pill text={pill.text} tone={pill.tone} />
        {info ? (
          <>
            <Text adjustsFontSizeToFit numberOfLines={1} style={type.display}>
              {info.tipHeight.toLocaleString()}
            </Text>
            <Text style={type.bodySm}>last block checked on this phone{tipAge !== null ? `, mined ${ago(info.tipTimestamp * 1000, now)}` : ''}</Text>
          </>
        ) : null}
      </View>

      {chain.problem ? <Banner tone="danger">{chain.problem.message}</Banner> : null}
      {stale && !chain.problem ? (
        <Banner tone="warn">
          The last block your phone checked is over 30 minutes old. The server may be behind, or it may be holding back blocks. Pull to refresh on the
          home screen, and check again here.
        </Banner>
      ) : null}
      {chain.kind === 'off' && !chain.problem ? (
        <Banner tone="neutral">
          {status?.features?.headers === false || (status && !status.features?.headers)
            ? 'This wallet server does not serve block headers yet, so the phone cannot check its chain.'
            : 'The check runs after the wallet connects to its server.'}
        </Banner>
      ) : null}

      <Card>
        <KeyValue label="Server reports" value={chain.serverTip !== null ? `block ${chain.serverTip.toLocaleString()}` : '…'} />
        <KeyValue label="Checked on phone" value={info ? `block ${info.tipHeight.toLocaleString()}` : '…'} />
        {behind !== null ? <KeyValue label="Behind the server" value={`${behind.toLocaleString()} ${behind === 1 ? 'block' : 'blocks'}`} /> : null}
        <KeyValue label="Built-in checkpoint" value={info ? `block ${info.checkpointHeight.toLocaleString()}` : 'block 274,821'} />
        {info ? <KeyValue label="Blocks checked since" value={(info.tipHeight - info.checkpointHeight).toLocaleString()} /> : null}
        {chain.lastSyncAt ? <KeyValue label="Last check" value={ago(chain.lastSyncAt, now)} mono={false} /> : null}
      </Card>

      <Button title={busy || chain.kind === 'syncing' ? 'Checking…' : 'Check again'} kind="secondary" disabled={busy || chain.kind === 'syncing' || !status} onPress={() => void again()} />

      <View style={{ gap: space.sm }}>
        <Text style={type.title}>What this checks</Text>
        <Body>
          Your phone verifies the chain of blocks itself, starting from block 274,821, which is built into this version of the app. For every block
          after it, the phone checks the proof of work, the difficulty rule, the timestamps, the link to the previous block, and that the whole chain
          carries real mining work. A wallet server cannot invent blocks or a fake chain tip without this check failing.
        </Body>
        <Text style={type.title}>What it does not check yet</Text>
        <Body>
          Whether a payment is really inside a block. Your balance and activity still come from the server. A later update will check payments
          against these blocks once the Parano1d node can provide the proofs.
        </Body>
        <Text style={{ color: colors.faint, fontFamily: fonts.ui, fontSize: 12 }}>
          Checking one block takes well under a millisecond. The phone keeps the last 2,048 block ids to match recent payments against.
        </Text>
      </View>
    </Screen>
  );
}
