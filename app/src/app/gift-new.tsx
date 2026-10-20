import { useCallback, useState } from 'react';
import { router } from 'expo-router';
import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native';

import { GiftCard, THEME_LABEL } from '@/components/GiftCard';
import { Body, Button, Card, Field, KeyValue, Notice, Screen, Title } from '@/components/ui';
import { formatNoid, parseNoid } from '@/lib/amount';
import { core, type SendPlan } from '@/lib/core';
import { claimFee, freshGiftIndex, newGiftRecord, nextGiftIndex } from '@/lib/gifts';
import { GIFT_THEMES, MAX_GIFT_FROM, MAX_GIFT_MESSAGE, type GiftTheme } from '@/lib/links';
import { goBack, useHardwareBack } from '@/lib/nav';
import { fiat } from '@/lib/safety';
import { executeSend, FeeChanged, hasUnresolvedSend, planSend, SubmitUnknown, type Stage } from '@/lib/send';
import { storage, type GiftRecord } from '@/lib/storage';
import { useWallet } from '@/state/wallet';
import { colors, radius, space } from '@/theme';

type Step = 'form' | 'review' | 'sending';

const STAGE_TEXT: Record<Stage, string> = {
  preparing: 'Getting the latest network state…',
  forging: 'Forging your zero-knowledge proof on this phone…',
  submitting: 'Sending your gift to the network…',
  retrying: 'A new block arrived. Rebuilding with fresh data…',
};

export default function NewGift() {
  const w = useWallet();
  const [theme, setTheme] = useState<GiftTheme>('celebrate');
  const [amountText, setAmountText] = useState('');
  const [message, setMessage] = useState('');
  const [from, setFrom] = useState('');
  const [step, setStep] = useState<Step>('form');
  const [stage, setStage] = useState<Stage>('preparing');
  const [plan, setPlan] = useState<SendPlan | null>(null);
  const [fee, setFee] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useHardwareBack(
    useCallback(() => {
      if (step === 'sending') return true;
      if (step === 'review') {
        setStep('form');
        return true;
      }
      return false;
    }, [step]),
  );

  if (!w.meta) return null;
  const meta = w.meta;
  const amount = parseNoid(amountText);
  const currency = w.settings.currency ?? 'none';

  async function review() {
    setError(null);
    if (!amount) {
      setError('Enter an amount, with at most 6 decimal places.');
      return;
    }
    if (!w.status) {
      setError('Your wallet server is not reachable right now.');
      return;
    }
    setBusy(true);
    try {
      const covered = claimFee(w.status.relayFloor);
      const { plan } = await planSend(w.api, meta.address, w.pending, amount + covered);
      setFee(covered);
      setPlan(plan);
      setStep('review');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function create() {
    if (!plan || !amount) return;
    if (!(await w.confirmUser(`Create a ${formatNoid(amount)} NOID gift card`))) return;
    setStep('sending');
    setError(null);
    let index = nextGiftIndex(w.gifts);
    let record: GiftRecord | null = null;
    try {
      const secretHex = await storage.readSecret();
      const fresh = await freshGiftIndex(w.api, index, async (i) => (await core.giftKey(secretHex, i)).address);
      index = fresh.index;
      const gift = await core.giftKey(secretHex, index);
      // Saved before any coins move, so the gift can always be found again.
      record = newGiftRecord({ index, address: gift.address, amount, message, theme, from });
      w.saveGift(record);
      const { pending } = await executeSend({
        api: w.api,
        secretHex,
        keyIndex: meta.keyIndex,
        address: meta.address,
        pending: w.pending,
        record: w.recordPending,
        discard: w.discardPending,
        to: gift.address,
        amount: plan.amount,
        reviewedFee: plan.fee,
        kind: 'gift',
        onStage: setStage,
      });
      w.saveGift({ ...record, fundTxid: pending.txid, status: 'funded' });
      void w.refresh();
      router.replace({ pathname: '/gift/[index]', params: { index: String(index), fresh: '1' } });
    } catch (e) {
      if (e instanceof SubmitUnknown && record) {
        // The wallet keeps re-sending this exact transaction; the gift is real.
        w.saveGift({ ...record, fundTxid: e.txid, status: 'funded' });
        router.replace({ pathname: '/gift/[index]', params: { index: String(index), fresh: '1' } });
        return;
      }
      // Definitely not sent: forget the draft so its number is reused.
      if (record) w.removeGift(record.index);
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

  if (step === 'review' && plan && amount) {
    const shownAmount = formatNoid(amount);
    return (
      <Screen>
        <Title>Review gift card</Title>
        <GiftCard theme={theme} amount={shownAmount} from={from.trim() || undefined} />
        {message.trim() ? <Body style={{ fontStyle: 'italic', textAlign: 'center' }}>“{message.trim()}”</Body> : null}
        <Card>
          <KeyValue label="They receive" value={`${shownAmount} NOID`} />
          {fiat(amount, w.price, currency) ? <KeyValue label="Worth" value={fiat(amount, w.price, currency)!} /> : null}
          <KeyValue label="Their claim fee (you cover it)" value={`${formatNoid(fee)} NOID`} />
          <KeyValue label="Network fee" value={`${formatNoid(plan.fee)} NOID`} />
          <KeyValue label="Total from your wallet" value={`${formatNoid(plan.totalSpend)} NOID`} />
        </Card>
        <Notice tone="warn">
          Anyone who has the gift link can claim it, so send it only to the person it is for. Until they claim it, you can
          take it back from Gift cards.
        </Notice>
        {error ? <Notice tone="danger">{error}</Notice> : null}
        <View style={{ flex: 1 }} />
        <Button title="Create gift card" onPress={create} />
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
        <Title>New gift card</Title>
        <Notice tone="warn">Your last send is still being checked with the network. Try again once it shows as sent.</Notice>
        <Button title="Back" kind="ghost" onPress={() => goBack()} />
      </Screen>
    );
  }

  return (
    <Screen>
      <Title>New gift card</Title>
      <GiftCard theme={theme} amount={amount ? formatNoid(amount) : '0'} from={from.trim() || undefined} />
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: space.sm }}>
        {GIFT_THEMES.map((t) => (
          <Pressable
            key={t}
            accessibilityRole="radio"
            accessibilityState={{ selected: t === theme }}
            onPress={() => setTheme(t)}
            style={{
              paddingHorizontal: space.md,
              paddingVertical: space.sm,
              borderRadius: radius.md,
              borderWidth: 1,
              borderColor: t === theme ? colors.accent : colors.line,
              backgroundColor: t === theme ? colors.surfaceRaised : colors.surface,
            }}
          >
            <Text style={{ color: t === theme ? colors.text : colors.muted, fontWeight: '600' }}>{THEME_LABEL[t]}</Text>
          </Pressable>
        ))}
      </ScrollView>
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
      {amount && fiat(amount, w.price, currency) ? (
        <Text style={{ color: colors.muted, fontSize: 14, marginTop: -space.sm }}>{fiat(amount, w.price, currency)}</Text>
      ) : null}
      <Field
        label="Message (optional)"
        value={message}
        onChangeText={setMessage}
        maxLength={MAX_GIFT_MESSAGE}
        placeholder="Happy birthday!"
        autoCapitalize="sentences"
        multiline
      />
      <Field label="From (optional)" value={from} onChangeText={setFrom} maxLength={MAX_GIFT_FROM} placeholder="Your name" autoCapitalize="words" />
      <Body muted style={{ fontSize: 13 }}>The message and name travel inside the gift link. Anyone with the link can read them.</Body>
      {error ? <Notice tone="danger">{error}</Notice> : null}
      <Button title="Review" busy={busy} disabled={!amountText} onPress={review} />
      <Button title="Cancel" kind="ghost" onPress={() => goBack()} />
    </Screen>
  );
}
