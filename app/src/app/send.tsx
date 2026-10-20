import { useCallback, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import { ActivityIndicator, Text, View } from 'react-native';

import { Body, Button, Card, Field, KeyValue, Link, Notice, Screen, Title } from '@/components/ui';
import { formatNoid, parseNoid, shortAddress } from '@/lib/amount';
import { core, type SendPlan } from '@/lib/core';
import { go, goBack, goHome, useHardwareBack } from '@/lib/nav';
import { scanResult, parsePaymentQr } from '@/lib/scan';
import { executeSend, FeeChanged, hasUnresolvedSend, planSend, SubmitUnknown, type Stage } from '@/lib/send';
import { storage } from '@/lib/storage';
import { useWallet } from '@/state/wallet';
import { colors, fonts, space } from '@/theme';

type Step = 'form' | 'review' | 'sending' | 'done';

const STAGE_TEXT: Record<Stage, string> = {
  preparing: 'Getting the latest network state…',
  forging: 'Forging your zero-knowledge proof on this phone…',
  submitting: 'Sending to the network…',
  retrying: 'A new block arrived. Rebuilding with fresh data…',
};

export default function Send() {
  const w = useWallet();
  const [to, setTo] = useState('');
  const [amountText, setAmountText] = useState('');
  const [toError, setToError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [plan, setPlan] = useState<SendPlan | null>(null);
  const [step, setStep] = useState<Step>('form');
  const [stage, setStage] = useState<Stage>('preparing');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ txid: string; proveMs: number } | null>(null);
  const [unknownTxid, setUnknownTxid] = useState<string | null>(null);

  // Android back button: from review go back to the form; while sending stay;
  // after sending go home instead of back into a finished send.
  useHardwareBack(
    useCallback(() => {
      if (step === 'sending') return true;
      if (step === 'review') {
        setStep('form');
        return true;
      }
      if (step === 'done') {
        goHome();
        return true;
      }
      return false;
    }, [step]),
  );

  useFocusEffect(
    useCallback(() => {
      const scanned = scanResult.take();
      if (scanned) {
        const p = parsePaymentQr(scanned);
        setTo(p.address);
        if (p.amount) setAmountText(p.amount);
        setToError(null);
      }
    }, []),
  );

  if (!w.meta) return null;
  const meta = w.meta;
  const amount = parseNoid(amountText);

  async function review() {
    setError(null);
    setToError(null);
    const check = await core.validateAddress(to);
    if (!check.valid || !check.address) {
      setToError(check.error ?? 'That is not a valid NOID address.');
      return;
    }
    if (check.address === meta.address) {
      setToError('This is your own address.');
      return;
    }
    if (!amount) {
      setError('Enter an amount, with at most 6 decimal places.');
      return;
    }
    setBusy(true);
    try {
      const { plan } = await planSend(w.api, meta.address, w.pending, amount);
      setTo(check.address);
      setPlan(plan);
      setStep('review');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function sendMax() {
    setError(null);
    const locked = new Set(w.pending.flatMap((p) => p.inputSlots));
    const coins = w.utxos.filter((u) => !locked.has(u.slotIndex));
    if (!w.status || coins.length === 0) return;
    if (coins.length > 504) {
      setError('Your balance is spread over more than 504 coins. Merge coins first, then send everything.');
      return;
    }
    // Spending every coin into one output never adds a slot, so the fee is
    // base + inputs + one output (consensus rules), or the relay floor if higher.
    const fee = Math.max(w.status.relayFloor, 5_000 + 100 * coins.length + 700);
    const spendable = coins.reduce((s, u) => s + u.value, 0);
    if (spendable > fee) setAmountText(formatNoid(spendable - fee).replace(/,/g, ''));
    else setError('Your balance is smaller than the network fee.');
  }

  async function confirmAndSend() {
    if (!plan) return;
    const ok = await w.confirmUser(`Send ${formatNoid(plan.amount)} NOID`);
    if (!ok) return;
    setStep('sending');
    setError(null);
    try {
      const secretHex = await storage.readSecret();
      const { built, pending } = await executeSend({
        api: w.api,
        secretHex,
        keyIndex: meta.keyIndex,
        address: meta.address,
        pending: w.pending,
        record: w.recordPending,
        discard: w.discardPending,
        to,
        amount: plan.amount,
        reviewedFee: plan.fee,
        onStage: (s) => setStage(s),
      });
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setResult({ txid: pending.txid, proveMs: built.proveMs });
      setStep('done');
      void w.refresh();
    } catch (e) {
      if (e instanceof SubmitUnknown) {
        setUnknownTxid(e.txid);
        setStep('done');
        return;
      }
      if (e instanceof FeeChanged && 'selectedSlots' in e.newPlan) {
        setPlan(e.newPlan);
        setError(`The network fee is now ${formatNoid(e.newPlan.fee)} NOID. Review and confirm again.`);
      } else {
        setError((e as Error).message);
      }
      setStep('review');
    }
  }

  if (step === 'sending') {
    return (
      <Screen>
        <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', gap: space.lg }}>
          <ActivityIndicator size="large" color={colors.accent} />
          <Body style={{ textAlign: 'center' }}>{STAGE_TEXT[stage]}</Body>
          <Body muted style={{ textAlign: 'center', fontSize: 14 }}>Keep the app open until this finishes.</Body>
        </View>
      </Screen>
    );
  }

  if (step === 'done' && unknownTxid && plan) {
    return (
      <Screen>
        <View style={{ flex: 1, justifyContent: 'center', gap: space.lg }}>
          <Text style={{ color: colors.warn, fontFamily: fonts.monoBold, fontSize: 14, letterSpacing: 1.5 }}>CHECKING</Text>
          <Title>We lost contact while sending</Title>
          <Body muted>
            Your transaction was saved before it was sent. The wallet keeps checking and re-sends this same transaction if
            needed, so it can never be paid twice. Do not send it again. It shows in Activity until it is confirmed.
          </Body>
          <Card>
            <KeyValue label="Amount" value={`${formatNoid(plan.amount)} NOID`} />
            <KeyValue label="To" value={shortAddress(to)} />
            <KeyValue label="Transaction" value={shortAddress(unknownTxid, 6)} />
          </Card>
        </View>
        <Button title="Back to wallet" onPress={goHome} />
      </Screen>
    );
  }

  if (step === 'done' && result && plan) {
    return (
      <Screen>
        <View style={{ flex: 1, justifyContent: 'center', gap: space.lg }}>
          <Text style={{ color: colors.accent, fontFamily: fonts.monoBold, fontSize: 14, letterSpacing: 1.5 }}>SENT</Text>
          <Title>{formatNoid(plan.amount)} NOID is on its way</Title>
          <Body muted>
            It confirms when the next block includes it, usually within a minute. Your proof took{' '}
            {(result.proveMs / 1000).toFixed(1)} s on this phone.
          </Body>
          <Card>
            <KeyValue label="To" value={shortAddress(to)} />
            <KeyValue label="Network fee" value={`${formatNoid(plan.fee)} NOID`} />
            <KeyValue label="Transaction" value={shortAddress(result.txid, 6)} />
          </Card>
        </View>
        <Button title="Done" onPress={goHome} />
      </Screen>
    );
  }

  if (step === 'review' && plan) {
    return (
      <Screen>
        <Title>Review send</Title>
        <Card>
          <Text style={{ color: colors.muted, fontSize: 13 }}>You send</Text>
          <Text style={{ color: colors.text, fontFamily: fonts.monoBold, fontSize: 32 }}>{formatNoid(plan.amount)} NOID</Text>
          <Text style={{ color: colors.muted, fontSize: 13, marginTop: space.sm }}>To</Text>
          <Text selectable style={{ color: colors.text, fontFamily: fonts.mono, fontSize: 14, lineHeight: 20 }}>
            {to}
          </Text>
        </Card>
        <Card>
          <KeyValue label="Network fee" value={`${formatNoid(plan.fee)} NOID`} />
          {plan.feeBreakdown.stateGrowth > 0 ? (
            <KeyValue label="  of which burned" value={`${formatNoid(plan.feeBreakdown.stateGrowth)} NOID`} />
          ) : null}
          <KeyValue label="Total" value={`${formatNoid(plan.totalSpend)} NOID`} />
          <KeyValue label="Coins used" value={String(plan.inputCount)} />
          {plan.change > 0 ? <KeyValue label="Change back to you" value={`${formatNoid(plan.change)} NOID`} /> : null}
        </Card>
        {plan.fee > Math.max(50_000, plan.amount / 100) ? (
          <Notice tone="warn">
            This fee is unusually high ({formatNoid(plan.fee)} NOID). If the network is not busy, your wallet server may be
            misconfigured. Check Settings before you send.
          </Notice>
        ) : null}
        <Notice>Check the address carefully. NOID sends cannot be reversed.</Notice>
        {error ? <Notice tone="danger">{error}</Notice> : null}
        <View style={{ flex: 1 }} />
        <Button title="Forge proof and send" onPress={confirmAndSend} />
        <Button
          title="Edit"
          kind="ghost"
          onPress={() => {
            setError(null);
            setStep('form');
          }}
        />
      </Screen>
    );
  }

  if (hasUnresolvedSend(w.pending)) {
    return (
      <Screen>
        <Title>Send NOID</Title>
        <Notice tone="warn">
          Your last send is still being checked with the network. Wait until it shows as sent in Activity, then try again.
        </Notice>
        <Button title="Back" kind="ghost" onPress={() => goBack()} />
      </Screen>
    );
  }

  return (
    <Screen>
      <Title>Send NOID</Title>
      <Field
        label="To"
        mono
        value={to}
        onChangeText={(t) => {
          setTo(t);
          setToError(null);
        }}
        placeholder="o1…"
        error={toError}
      />
      <View style={{ flexDirection: 'row', gap: space.md }}>
        <View style={{ flex: 1 }}>
          <Button
            title="Paste"
            kind="secondary"
            onPress={async () => {
              const t = (await Clipboard.getStringAsync()).trim();
              if (!t) {
                setToError('Nothing to paste. Copy a NOID address first.');
                return;
              }
              const p = parsePaymentQr(t);
              setTo(p.address);
              if (p.amount) setAmountText(p.amount);
              setToError(null);
            }}
          />
        </View>
        <View style={{ flex: 1 }}>
          <Button title="Scan QR" kind="secondary" onPress={() => go('/scan')} />
        </View>
      </View>
      <Field
        label="Amount (NOID)"
        mono
        value={amountText}
        onChangeText={(t) => {
          setAmountText(t);
          setError(null);
        }}
        keyboardType="decimal-pad"
        placeholder="0.0"
      />
      <Link title="Send everything" onPress={sendMax} disabled={!w.status || w.utxos.length === 0} />
      {error ? <Notice tone="danger">{error}</Notice> : null}
      <View style={{ flex: 1 }} />
      <Button title="Review" busy={busy} disabled={!to || !amountText} onPress={review} />
      <Button title="Cancel" kind="ghost" onPress={() => goBack()} />
    </Screen>
  );
}
