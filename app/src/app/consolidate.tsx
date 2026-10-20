import { useCallback, useEffect, useState } from 'react';
import { Text, View } from 'react-native';

import { Icon } from '@/components/Icon';
import { Banner, Body, Button, Card, KeyValue, Screen, Skeleton } from '@/components/ui';
import { formatNoid } from '@/lib/amount';
import type { ConsolidationPlan } from '@/lib/core';
import { goHome, useHardwareBack } from '@/lib/nav';
import { executeConsolidation, FeeChanged, planConsolidation, SubmitUnknown } from '@/lib/send';
import { storage } from '@/lib/storage';
import { useWallet } from '@/state/wallet';
import { colors, space, type } from '@/theme';

export default function Consolidate() {
  const w = useWallet();
  const [plan, setPlan] = useState<ConsolidationPlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [done, setDone] = useState(false);

  // While the proof is being forged, stay on this screen so the result is seen.
  useHardwareBack(useCallback(() => sending, [sending]));

  const hasPending = w.pending.length > 0;
  useEffect(() => {
    if (!w.meta || hasPending) return;
    planConsolidation(w.api, w.meta.address, w.pending).then(setPlan, (e: Error) => setError(e.message));
    // Plan once per open; `pending` is checked again inside the core.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [w.api, w.meta, hasPending]);

  if (!w.meta) return null;
  const meta = w.meta;
  const shownError = hasPending && !done ? 'Wait until your pending transaction confirms, then merge coins.' : error;

  async function run() {
    if (!plan) return;
    if (!(await w.confirmUser('Merge your coins'))) return;
    setSending(true);
    setError(null);
    try {
      const secretHex = await storage.readSecret();
      await executeConsolidation({
        api: w.api,
        secretHex,
        keyIndex: meta.keyIndex,
        address: meta.address,
        pending: w.pending,
        record: w.recordPending,
        discard: w.discardPending,
        reviewedFee: plan.fee,
      });
      setDone(true);
      void w.refresh();
    } catch (e) {
      if (e instanceof SubmitUnknown) {
        setDone(true);
        setError(e.message);
      } else if (e instanceof FeeChanged && 'selectedInputSlots' in e.newPlan) {
        setPlan(e.newPlan);
        setError('The fee changed. Review it and try again.');
      } else setError((e as Error).message);
    } finally {
      setSending(false);
    }
  }

  return (
    <Screen
      header={sending ? undefined : { title: 'Merge coins' }}
      footer={
        done ? (
          <Button title="Done" onPress={goHome} />
        ) : (
          <Button title="Merge coins" icon="merge" busy={sending} disabled={!plan || hasPending} onPress={run} />
        )
      }
    >
      <Body muted>
        Your balance is held as separate coins. Merging the smallest ones into one makes later sends cheaper and faster. Your
        balance only goes down by the network fee.
      </Body>
      {plan ? (
        <>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: space.lg, paddingVertical: space.md }}>
            <View style={{ alignItems: 'center' }}>
              <Text style={type.display}>{plan.inputCount}</Text>
              <Text style={type.bodySm}>coins</Text>
            </View>
            <Icon name="chevron" size={28} color={colors.accent} />
            <View style={{ alignItems: 'center' }}>
              <Text style={[type.display, { color: colors.accent }]}>1</Text>
              <Text style={type.bodySm}>coin</Text>
            </View>
          </View>
          <Card>
            {plan.untouchedCount > 0 ? <KeyValue label="Coins left as they are" value={String(plan.untouchedCount)} /> : null}
            <KeyValue label="Network fee" value={`${formatNoid(plan.fee)} NOID`} />
            <KeyValue label="Balance after" value={`${formatNoid(plan.balanceAfter)} NOID`} />
          </Card>
        </>
      ) : !shownError ? (
        <View style={{ gap: space.sm }}>
          <Skeleton width="100%" height={80} />
          <Skeleton width="100%" height={110} />
        </View>
      ) : null}
      {sending ? <Banner tone="info" icon="clock">Securing the merge on this phone. Keep the app open.</Banner> : null}
      {done && !error ? <Banner tone="success">Merging. It confirms with the next block.</Banner> : null}
      {done && error ? <Banner tone="warn" icon="clock">{error}</Banner> : null}
      {!done && shownError ? <Banner tone="danger">{shownError}</Banner> : null}
    </Screen>
  );
}
