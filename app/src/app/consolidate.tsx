import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';

import { Body, Button, Card, KeyValue, Notice, Screen, Title } from '@/components/ui';
import { formatNoid } from '@/lib/amount';
import type { ConsolidationPlan } from '@/lib/core';
import { goBack, goHome, useHardwareBack } from '@/lib/nav';
import { executeConsolidation, FeeChanged, planConsolidation, SubmitUnknown } from '@/lib/send';
import { storage } from '@/lib/storage';
import { useWallet } from '@/state/wallet';
import { colors, space } from '@/theme';

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
    <Screen>
      <Title>Merge coins</Title>
      <Body muted>
        Your balance is held as separate coins. Merging your smallest coins into one makes later sends cheaper and the
        proof smaller. Your balance only goes down by the network fee.
      </Body>
      {plan ? (
        <Card>
          <KeyValue label="Coins merged" value={String(plan.inputCount)} />
          {plan.untouchedCount > 0 ? <KeyValue label="Coins left as they are" value={String(plan.untouchedCount)} /> : null}
          <KeyValue label="Network fee" value={`${formatNoid(plan.fee)} NOID`} />
          <KeyValue label="Balance after" value={`${formatNoid(plan.balanceAfter)} NOID`} />
        </Card>
      ) : !shownError ? (
        <ActivityIndicator color={colors.accent} />
      ) : null}
      {shownError ? <Notice tone="danger">{shownError}</Notice> : null}
      {done ? <Notice>Merging. It confirms with the next block.</Notice> : null}
      <View style={{ flex: 1, minHeight: space.lg }} />
      {sending ? <Body muted style={{ textAlign: 'center', fontSize: 14 }}>Securing the merge on this phone. Keep the app open.</Body> : null}
      {done ? (
        <Button title="Done" onPress={goHome} />
      ) : (
        <>
          <Button title="Merge coins" busy={sending} disabled={!plan || hasPending} onPress={run} />
          {!sending ? <Button title="Back" kind="ghost" onPress={() => goBack()} /> : null}
        </>
      )}
    </Screen>
  );
}
