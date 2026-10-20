import { useCallback, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import { Pressable, ScrollView, Text, View } from 'react-native';

import { AmountField } from '@/components/AmountField';
import { Icon } from '@/components/Icon';
import { SendProgress } from '@/components/Progress';
import {
  Avatar,
  Banner,
  Body,
  Button,
  Card,
  Field,
  IconButton,
  initialsOf,
  KeyValue,
  Screen,
  SuccessMark,
  Title,
  toneFor,
} from '@/components/ui';
import { formatNoid, parseNoid, shortAddress } from '@/lib/amount';
import { LINK_HOSTS } from '@/lib/config';
import { core, type SendPlan } from '@/lib/core';
import { inbox } from '@/lib/inbox';
import { parseLink, type ParsedLink } from '@/lib/links';
import { go, goHandoff, goHome, useHardwareBack } from '@/lib/nav';
import { checkAddress, fiat, groupAddress } from '@/lib/safety';
import { contactPick, scanResult } from '@/lib/scan';
import { executeSend, FeeChanged, hasUnresolvedSend, planSend, SubmitUnknown, type Stage } from '@/lib/send';
import { storage } from '@/lib/storage';
import { useWallet } from '@/state/wallet';
import { colors, fonts, radius, space, type } from '@/theme';

type Step = 'form' | 'review' | 'sending' | 'done';

export default function Send() {
  const w = useWallet();
  const [to, setTo] = useState('');
  const [amountText, setAmountText] = useState('');
  // Currency text that can't be turned into an amount (see AmountField).
  const [amountInvalid, setAmountInvalid] = useState(false);
  const [toError, setToError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [plan, setPlan] = useState<SendPlan | null>(null);
  const [step, setStep] = useState<Step>('form');
  const [stage, setStage] = useState<Stage>('preparing');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{
    txid: string;
    proveMs: number;
  } | null>(null);
  const [unknownTxid, setUnknownTxid] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [checkedLookalike, setCheckedLookalike] = useState(false);
  const [contactName, setContactName] = useState('');
  const [savedContact, setSavedContact] = useState(false);
  const [fromLink, setFromLink] = useState(false);
  const [showDetails, setShowDetails] = useState(false);

  const fill = useCallback((p: ParsedLink) => {
    if (p.kind === 'gift') {
      // A gift link belongs on the claim screen.
      inbox.set(p);
      goHandoff('/claim');
      return;
    }
    setTo(p.address);
    if (p.amount) setAmountText(p.amount);
    setNote(p.kind === 'pay' ? p.note : '');
    setToError(null);
  }, []);

  // Android back button: from review go back to the form; while sending stay;
  // after sending go home instead of back into a finished send.
  useHardwareBack(
    useCallback(() => {
      if (step === 'sending') return true;
      if (step === 'review') {
        setError(null);
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
      const incoming = inbox.peek();
      if (incoming && incoming.kind !== 'gift') {
        fill(inbox.take()!);
        setFromLink(true);
      }
      const scanned = scanResult.take();
      if (scanned) {
        const p = parseLink(scanned, LINK_HOSTS);
        if (p) fill(p);
        else setToError('That QR code is not a NOID address or payment request.');
      }
      const picked = contactPick.take();
      if (picked) {
        setTo(picked);
        setToError(null);
      }
    }, [fill]),
  );

  if (!w.meta) return null;
  const meta = w.meta;
  const amount = parseNoid(amountText);
  const currency = w.settings.currency ?? 'none';
  const lockedSlots = new Set(w.pending.flatMap((p) => p.inputSlots));
  const available = w.utxos.filter((u) => !lockedSlots.has(u.slotIndex)).reduce((s, u) => s + u.value, 0);
  const cleanTo = to.trim().toLowerCase();
  const safety = checkAddress(cleanTo, w.contacts, w.sentTo);
  const contactForTo = safety.kind === 'contact' ? safety.name : null;
  const tooMuch = !!amount && amount > available;
  const online = !!w.settings.apiUrl && !!w.status && !w.error;
  // Just opened (e.g. from a payment link): the first check hasn't answered yet.
  const connecting = !!w.settings.apiUrl && !w.status && !w.error;
  const blocker = !w.settings.apiUrl
    ? 'NOID isn’t connected to a wallet server yet. Add one in Settings to send.'
    : connecting
      ? null
      : !online
        ? 'Can’t reach your wallet server, so sending is paused. Check your connection.'
        : available === 0 && w.utxos.length > 0
          ? 'Your NOID is tied up in a payment that hasn’t confirmed yet. Try again in a minute.'
          : available === 0
            ? 'You have no NOID to send yet. Receive some first.'
            : null;

  // "0.0123 NOID (≈ ₦9)" when a currency is chosen.
  const withFiat = (micro: number) => {
    const f = fiat(micro, w.price, currency);
    return `${formatNoid(micro)} NOID${f ? ` (${f})` : ''}`;
  };

  // Recent people to pay: contacts first, then addresses you paid before.
  const recents = [
    ...w.contacts.map((c) => ({ address: c.address, name: c.name })),
    ...w.sentTo.filter((a) => !w.contacts.some((c) => c.address === a)).map((a) => ({ address: a, name: shortAddress(a, 4) })),
  ].slice(0, 8);

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
      setError('Enter an amount like 1500 or 1.5: a dot for decimals, no commas for thousands.');
      return;
    }
    setBusy(true);
    setCheckedLookalike(false);
    setShowDetails(false);
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
    const coins = w.utxos.filter((u) => !lockedSlots.has(u.slotIndex));
    if (!w.status || coins.length === 0) return;
    if (coins.length > 504) {
      setError('Your balance is in more than 504 pieces. Combine them first (Settings), then send everything.');
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

  if (step === 'sending' && plan) {
    return (
      <Screen>
        <SendProgress stage={stage} title={`Sending ${formatNoid(plan.amount)} NOID`} />
      </Screen>
    );
  }

  const recipientName = contactForTo ?? null;
  const recipientRow = (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
      <Avatar
        initials={recipientName ? initialsOf(recipientName) : undefined}
        icon={recipientName ? undefined : 'send'}
        tone={recipientName ? toneFor(recipientName) : 'neutral'}
      />
      <View style={{ flex: 1 }}>
        <Text style={type.title}>{recipientName ?? 'NOID address'}</Text>
        <Text selectable style={[type.monoSm, { lineHeight: 20 }]}>
          {groupAddress(to)}
        </Text>
      </View>
    </View>
  );

  if (step === 'done' && unknownTxid && plan) {
    return (
      <Screen
        footer={
          <>
            <Button title="Back to wallet" onPress={goHome} />
            <Button
              title="View transaction"
              kind="tertiary"
              onPress={() => go({ pathname: '/tx/[txid]', params: { txid: unknownTxid } })}
            />
          </>
        }
      >
        <View
          style={{
            flex: 1,
            justifyContent: 'center',
            alignItems: 'center',
            gap: space.lg,
          }}
        >
          <SuccessMark tone="warn" />
          <Title style={{ textAlign: 'center' }}>Still checking with the network</Title>
          <Body muted style={{ textAlign: 'center' }}>
            Your payment was saved before it was sent. The wallet keeps checking and re-sends this same payment if needed, so it can never
            be paid twice. Don’t send it again; it shows in Activity until it confirms.
          </Body>
          <Card style={{ alignSelf: 'stretch' }}>
            <KeyValue label="Amount" value={`${formatNoid(plan.amount)} NOID`} />
            <KeyValue label="To" value={recipientName ?? shortAddress(to)} mono={!recipientName} />
          </Card>
        </View>
      </Screen>
    );
  }

  if (step === 'done' && result && plan) {
    return (
      <Screen
        footer={
          <>
            <Button title="Done" onPress={goHome} />
            <Button
              title="View transaction"
              kind="tertiary"
              onPress={() => go({ pathname: '/tx/[txid]', params: { txid: result.txid } })}
            />
          </>
        }
      >
        <View
          style={{
            flex: 1,
            justifyContent: 'center',
            alignItems: 'center',
            gap: space.lg,
          }}
        >
          <SuccessMark />
          <Title style={{ textAlign: 'center' }}>{formatNoid(plan.amount)} NOID sent</Title>
          <Body muted style={{ textAlign: 'center' }}>
            It confirms with the next block, usually within a minute.
          </Body>
          <Card style={{ alignSelf: 'stretch' }}>
            {recipientRow}
            <KeyValue label="Network fee" value={`${formatNoid(plan.fee)} NOID`} />
          </Card>
          {!contactForTo && !savedContact && safety.kind !== 'lookalike' ? (
            <View style={{ alignSelf: 'stretch' }}>
              <Field
                label="Save as contact"
                value={contactName}
                onChangeText={setContactName}
                maxLength={40}
                placeholder="Name"
                autoCapitalize="words"
                right={
                  <Button
                    title="Save"
                    kind="tertiary"
                    disabled={!contactName.trim()}
                    onPress={() => {
                      w.saveContact(contactName.trim(), to);
                      setSavedContact(true);
                    }}
                  />
                }
              />
            </View>
          ) : null}
          {savedContact ? <Banner tone="success">Saved {contactName.trim()} to your contacts.</Banner> : null}
        </View>
      </Screen>
    );
  }

  if (step === 'review' && plan) {
    const value = fiat(plan.amount, w.price, currency);
    return (
      <Screen
        header={{
          title: 'Review',
          back: () => {
            setError(null);
            setStep('form');
          },
        }}
        footer={
          <Button
            title={`Send ${formatNoid(plan.amount)} NOID`}
            icon="send"
            disabled={safety.kind === 'lookalike' && !checkedLookalike}
            onPress={confirmAndSend}
          />
        }
      >
        <View
          style={{
            alignItems: 'center',
            gap: space.xs,
            paddingVertical: space.md,
          }}
        >
          <Text style={type.caption}>You send</Text>
          <Text adjustsFontSizeToFit numberOfLines={1} maxFontSizeMultiplier={1.3} style={type.display}>{formatNoid(plan.amount)}</Text>
          <Text style={{ color: colors.accent, fontFamily: fonts.monoBold }}>NOID</Text>
          {value ? <Text style={type.bodySm}>{value}</Text> : null}
        </View>
        <Card>
          <Text style={type.caption}>To</Text>
          {recipientRow}
          {note ? <Text style={type.bodySm}>For: {note}</Text> : null}
        </Card>
        {safety.kind === 'lookalike' ? (
          <Card
            style={{
              borderColor: colors.danger,
              backgroundColor: colors.dangerTint,
            }}
          >
            <View
              style={{
                flexDirection: 'row',
                gap: space.sm,
                alignItems: 'center',
              }}
            >
              <Icon name="warning" size={20} color={colors.danger} />
              <Text style={[type.title, { color: colors.danger }]}>Possible look-alike address</Text>
            </View>
            <Text style={[type.bodySm, { color: colors.text }]}>
              This address starts and ends like {safety.name ? `your contact ${safety.name}` : 'an address you paid before'}, but the middle
              is different. Scammers create addresses like this so a quick glance looks right.
            </Text>
            <Text style={type.monoSm}>Known: {groupAddress(safety.similarTo)}</Text>
            <Pressable
              accessibilityRole="checkbox"
              accessibilityState={{ checked: checkedLookalike }}
              onPress={() => setCheckedLookalike((v) => !v)}
              style={{
                flexDirection: 'row',
                gap: space.sm,
                alignItems: 'center',
                paddingVertical: 4,
              }}
              hitSlop={8}
            >
              <View
                style={{
                  width: 24,
                  height: 24,
                  borderRadius: 6,
                  borderWidth: 2,
                  borderColor: colors.danger,
                  backgroundColor: checkedLookalike ? colors.danger : 'transparent',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                {checkedLookalike ? <Icon name="check" size={16} color={colors.bg} /> : null}
              </View>
              <Text style={[type.body, { flex: 1 }]}>I checked every character with the person I am paying</Text>
            </Pressable>
          </Card>
        ) : safety.kind === 'new' ? (
          <Banner tone="warn">First time paying this address. Confirm it with the person you are paying.</Banner>
        ) : null}
        <Card>
          <KeyValue label="Network fee" value={withFiat(plan.fee)} />
          <KeyValue label="Total" value={withFiat(plan.totalSpend)} />
          {showDetails ? (
            <>
              {plan.feeBreakdown.stateGrowth > 0 ? (
                <KeyValue label="Part of the fee for network storage" value={`${formatNoid(plan.feeBreakdown.stateGrowth)} NOID`} />
              ) : null}
              {plan.change > 0 ? <KeyValue label="Change back to you" value={`${formatNoid(plan.change)} NOID`} /> : null}
              <KeyValue label="Balance pieces used" value={String(plan.inputCount)} />
            </>
          ) : (
            <Pressable accessibilityRole="button" onPress={() => setShowDetails(true)} hitSlop={12}>
              <Text style={{ color: colors.accent, fontFamily: fonts.uiSemi }}>Show details</Text>
            </Pressable>
          )}
        </Card>
        {plan.fee > Math.max(50_000, plan.amount / 100) ? (
          <Banner tone="warn">
            This fee is unusually high ({formatNoid(plan.fee)} NOID). If the network is not busy, check your wallet server in Settings
            before you send.
          </Banner>
        ) : null}
        <Banner tone="danger">Payments can’t be reversed. Check the address and amount.</Banner>
        {error ? <Banner tone="danger">{error}</Banner> : null}
      </Screen>
    );
  }

  if (hasUnresolvedSend(w.pending)) {
    return (
      <Screen header={{ title: 'Send' }}>
        <Banner tone="warn" icon="clock">
          Your last payment is still being checked with the network. Wait until it shows as sent in Activity, then try again.
        </Banner>
      </Screen>
    );
  }

  return (
    <Screen
      header={{ title: 'Send NOID' }}
      footer={
        <Button title="Continue" busy={busy} disabled={!to || !amountText || amountInvalid || tooMuch || !!blocker || connecting} onPress={review} />
      }
    >
      {blocker ? <Banner tone="warn">{blocker}</Banner> : null}
      {connecting ? <Banner tone="neutral">Connecting to the network…</Banner> : null}
      {fromLink ? <Banner tone="warn">Filled in from a link someone sent you. Check the address and amount before you send.</Banner> : null}
      <Field
        label="To"
        mono
        value={to}
        onChangeText={(t) => {
          setTo(t);
          setToError(null);
        }}
        placeholder="o1… address"
        error={toError}
        hint={contactForTo ? `✓ ${contactForTo}` : null}
        right={
          <>
            <IconButton
              icon="paste"
              label="Paste address"
              size={40}
              onPress={async () => {
                const t = (await Clipboard.getStringAsync()).trim();
                if (!t) {
                  setToError('Nothing to paste. Copy a NOID address first.');
                  return;
                }
                const p = parseLink(t, LINK_HOSTS);
                if (p) fill(p);
                else setToError('The copied text is not a NOID address.');
              }}
            />
            <IconButton icon="scan" label="Scan QR code" size={40} onPress={() => go('/scan')} />
            <IconButton
              icon="contacts"
              label="Choose contact"
              size={40}
              onPress={() => go({ pathname: '/contacts', params: { pick: '1' } })}
            />
          </>
        }
      />
      {recents.length > 0 && !to ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={{ flexGrow: 0 }}
          contentContainerStyle={{ gap: space.sm, alignItems: 'center' }}
        >
          {recents.map((r) => (
            <Pressable
              key={r.address}
              accessibilityRole="button"
              accessibilityLabel={`Pay ${r.name}`}
              onPress={() => {
                setTo(r.address);
                setToError(null);
              }}
              style={({ pressed }) => ({
                flexDirection: 'row',
                alignItems: 'center',
                gap: space.sm,
                backgroundColor: pressed ? colors.s3 : colors.s2,
                borderRadius: radius.pill,
                paddingLeft: 6,
                paddingRight: space.md,
                paddingVertical: 6,
              })}
            >
              <Avatar initials={initialsOf(r.name)} tone={toneFor(r.name)} size={28} />
              <Text style={{ color: colors.text, fontFamily: fonts.uiSemi }} numberOfLines={1}>
                {r.name}
              </Text>
            </Pressable>
          ))}
        </ScrollView>
      ) : null}
      {note ? <Banner tone="neutral">Payment request: {note}</Banner> : null}
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
        error={tooMuch ? `More than you have (${formatNoid(available)} NOID available).` : null}
        hint={`${amount && fiat(amount, w.price, currency) ? `${fiat(amount, w.price, currency)} · ` : ''}Available: ${formatNoid(available)} NOID`}
        extraRight={
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Send everything"
            hitSlop={8}
            onPress={sendMax}
            disabled={!w.status || w.utxos.length === 0}
            style={{
              backgroundColor: colors.accentTint,
              borderRadius: radius.pill,
              paddingHorizontal: space.md,
              paddingVertical: 6,
              marginRight: space.sm,
            }}
          >
            <Text style={{ color: colors.accent, fontFamily: fonts.uiBold }}>Max</Text>
          </Pressable>
        }
      />
      {error ? <Banner tone="danger">{error}</Banner> : null}
    </Screen>
  );
}
