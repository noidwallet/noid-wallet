import { useCallback, useState } from 'react';
import { router } from 'expo-router';
import { Pressable, ScrollView, Text, View } from 'react-native';

import { GiftCard, THEME_LABEL } from '@/components/GiftCard';
import { SendProgress } from '@/components/Progress';
import { AmountField } from '@/components/AmountField';
import { Banner, Body, Button, Card, Field, KeyValue, Screen } from '@/components/ui';
import { formatNoid, parseNoid } from '@/lib/amount';
import { core, type SendPlan } from '@/lib/core';
import { claimFee, freshGiftIndex, newGiftRecord, pickGiftIndex } from '@/lib/gifts';
import { GIFT_THEMES, MAX_GIFT_FROM, MAX_GIFT_MESSAGE, type GiftTheme } from '@/lib/links';
import { useArmed, useHardwareBack } from '@/lib/nav';
import { fiat } from '@/lib/safety';
import { executeSend, FeeChanged, hasUnresolvedSend, overrideRefusals, planSend, RefusedButSpent, SubmitUnknown, type Stage } from '@/lib/send';
import { walletFeeLabel } from '@/lib/walletFee';
import { storage, type GiftRecord } from '@/lib/storage';
import { useWallet } from '@/state/wallet';
import { colors, fonts, space } from '@/theme';

type Step = 'form' | 'review' | 'sending';

export default function NewGift() {
  const w = useWallet();
  const [theme, setTheme] = useState<GiftTheme>('celebrate');
  const [amountText, setAmountText] = useState('');
  // Currency text that can't be turned into an amount (see AmountField).
  const [amountInvalid, setAmountInvalid] = useState(false);
  const [message, setMessage] = useState('');
  const [from, setFrom] = useState('');
  const [step, setStep] = useState<Step>('form');
  const [stage, setStage] = useState<Stage>('preparing');
  const [plan, setPlan] = useState<SendPlan | null>(null);
  const [fee, setFee] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The plan whose review offered the override: a new review (new plan) hides it.
  const [refusedFor, setRefusedFor] = useState<unknown>(null);
  const refusedBlock = refusedFor !== null && refusedFor === plan;
  // "Create gift card" sits where "Review" was: no tap-through (see useArmed).
  const armed = useArmed(step === 'review' ? plan : null);

  useHardwareBack(
    useCallback(() => {
      if (step === 'sending') return true;
      if (step === 'review') {
        setError(null);
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
  const lockedSlots = new Set(w.pending.flatMap((p) => p.inputSlots));
  const available = w.utxos.filter((u) => !lockedSlots.has(u.slotIndex)).reduce((s, u) => s + u.value, 0);

  async function review() {
    setError(null);
    if (!amount) {
      setError('Enter an amount like 1500 or 1.5: a dot for decimals, no commas for thousands.');
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
    if (!plan || !amount || !armed) return;
    if (!(await w.confirmUser(`Create a ${formatNoid(amount)} NOID gift card`))) return;
    setStep('sending');
    setError(null);
    let index = -1;
    let record: GiftRecord | null = null;
    try {
      const secretHex = await storage.readSecret();
      const start = pickGiftIndex(w.gifts, await storage.giftHighWater());
      const fresh = await freshGiftIndex(w.api, start, async (i) => (await core.giftKey(secretHex, i)).address);
      index = fresh.index;
      const gift = await core.giftKey(secretHex, index);
      // Saved before any coins move, so the gift can always be found again,
      // and the number is burned for good even if this send fails.
      record = newGiftRecord({ index, address: gift.address, amount, message, theme, from });
      await storage.raiseGiftHighWater(index);
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
        setRefusedFor(null);
        setPlan(e.newPlan);
        setError(`The network fee is now ${formatNoid(e.newPlan.fee)} NOID. Review and confirm again.`);
      } else {
        setRefusedFor(e instanceof RefusedButSpent && e.missing ? plan : null);
        setError((e as Error).message);
      }
      setStep('review');
    }
  }

  if (step === 'sending' && amount) {
    return (
      <Screen>
        <SendProgress stage={stage} title={`Creating a ${formatNoid(amount)} NOID gift`} />
      </Screen>
    );
  }

  if (step === 'review' && plan && amount) {
    const shownAmount = formatNoid(amount);
    const value = fiat(amount, w.price, currency);
    return (
      <Screen
        header={{
          title: 'Review gift',
          back: () => {
            setError(null);
            setStep('form');
          },
        }}
        footer={<Button title="Create gift card" icon="gift" disabled={!armed} onPress={create} />}
      >
        <GiftCard theme={theme} amount={shownAmount} from={from.trim() || undefined} />
        {message.trim() ? <Body style={{ fontStyle: 'italic', textAlign: 'center' }}>“{message.trim()}”</Body> : null}
        <Card>
          <KeyValue label="They receive" value={`${shownAmount} NOID`} />
          {value ? <KeyValue label="Worth" value={value} /> : null}
          <KeyValue label="Their claim fee (you cover it)" value={`${formatNoid(fee)} NOID`} />
          {plan.walletFee > 0 ? <KeyValue label={walletFeeLabel(plan.amount, plan.walletFee)} value={`${formatNoid(plan.walletFee)} NOID`} /> : null}
          <KeyValue label="Network fee" value={`${formatNoid(plan.fee)} NOID`} />
          <KeyValue label="Total from your wallet" value={`${formatNoid(plan.totalSpend)} NOID`} />
        </Card>
        {fee > 20_000 ? (
          <Banner tone="danger">
            The claim fee is unusually high ({formatNoid(fee)} NOID). If the network is not busy, check your wallet server in
            Settings first.
          </Banner>
        ) : null}
        <Banner tone="warn" icon="gift">
          Anyone who has the gift link can claim it, so send it only to the person it is for. Until they claim it, you can take it
          back.
        </Banner>
        {error ? <Banner tone="danger">{error}</Banner> : null}
        {refusedBlock && w.meta ? (
          <Button
            title="I checked Activity: allow this payment"
            kind="secondary"
            onPress={() => {
              if (w.meta) overrideRefusals(w.meta.address);
              setRefusedFor(null);
              setError(null);
            }}
          />
        ) : null}
      </Screen>
    );
  }

  if (hasUnresolvedSend(w.pending)) {
    return (
      <Screen header={{ title: 'New gift card' }}>
        <Banner tone="warn" icon="clock">Your last payment is still being checked with the network. Try again once it shows as sent.</Banner>
      </Screen>
    );
  }

  const QUICK = ['1', '5', '10', '50'];
  return (
    <Screen
      header={{ title: 'New gift card' }}
      footer={<Button title="Review" busy={busy} disabled={!amountText || amountInvalid || (!!amount && amount > available)} onPress={review} />}
    >
      <GiftCard theme={theme} amount={amount ? formatNoid(amount) : '0'} from={from.trim() || undefined} />
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={{ flexGrow: 0 }}
        contentContainerStyle={{ gap: space.sm, alignItems: 'center' }}
      >
        {GIFT_THEMES.map((t) => (
          <Pressable
            key={t}
            accessibilityRole="radio"
            accessibilityLabel={`${THEME_LABEL[t]} design`}
            accessibilityState={{ checked: t === theme }}
            onPress={() => setTheme(t)}
            style={{ alignItems: 'center', gap: 6 }}
          >
            <View style={{ borderRadius: 12, borderWidth: 2, borderColor: t === theme ? colors.accent : 'transparent', padding: 2 }}>
              <GiftCard theme={t} amount="" width={96} />
            </View>
            <Text style={{ color: t === theme ? colors.text : colors.textSecondary, fontSize: 12, fontFamily: fonts.uiSemi }}>{THEME_LABEL[t]}</Text>
          </Pressable>
        ))}
      </ScrollView>
      <AmountField
        label="Amount"
        noidText={amountText}
        onChangeNoid={(t) => {
          setAmountText(t);
          setError(null);
        }}
        onInvalidChange={setAmountInvalid}
        price={w.price}
        currency={currency}
        error={amount && amount > available ? `More than you have (${formatNoid(available)} NOID available).` : null}
        hint={`${amount && fiat(amount, w.price, currency) ? `${fiat(amount, w.price, currency)} · ` : ''}Available: ${formatNoid(available)} NOID`}
      />
      <View style={{ flexDirection: 'row', gap: space.sm }}>
        {QUICK.map((q) => (
          <Pressable
            key={q}
            accessibilityRole="button"
            accessibilityLabel={`${q} NOID`}
            onPress={() => setAmountText(q)}
            style={({ pressed }) => ({
              flex: 1,
              minHeight: 44,
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: 999,
              backgroundColor: amountText === q ? colors.accentTint : pressed ? colors.s3 : colors.s2,
            })}
          >
            <Text style={{ color: amountText === q ? colors.accent : colors.text, fontFamily: fonts.uiBold }}>{q}</Text>
          </Pressable>
        ))}
      </View>
      <Field
        label={`Message (optional) · ${message.length}/${MAX_GIFT_MESSAGE}`}
        value={message}
        onChangeText={setMessage}
        maxLength={MAX_GIFT_MESSAGE}
        placeholder="Happy birthday!"
        autoCapitalize="sentences"
        multiline
      />
      <Field label="From (optional)" value={from} onChangeText={setFrom} maxLength={MAX_GIFT_FROM} placeholder="Your name" autoCapitalize="words" />
      <Body muted style={{ fontSize: 13 }}>The message and name travel inside the gift link. Anyone with the link can read them.</Body>
      {error ? <Banner tone="danger">{error}</Banner> : null}
    </Screen>
  );
}
