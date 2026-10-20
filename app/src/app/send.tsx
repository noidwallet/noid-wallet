import { useCallback, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';

import { Body, Button, Card, Field, KeyValue, Link, Notice, Screen, Title } from '@/components/ui';
import { formatNoid, parseNoid, shortAddress } from '@/lib/amount';
import { LINK_HOSTS } from '@/lib/config';
import { core, type SendPlan } from '@/lib/core';
import { inbox } from '@/lib/inbox';
import { parseLink, type ParsedLink } from '@/lib/links';
import { go, goBack, goHome, useHardwareBack } from '@/lib/nav';
import { checkAddress, fiat, groupAddress } from '@/lib/safety';
import { contactPick, scanResult } from '@/lib/scan';
import { executeSend, FeeChanged, hasUnresolvedSend, planSend, SubmitUnknown, type Stage } from '@/lib/send';
import { storage } from '@/lib/storage';
import { useWallet } from '@/state/wallet';
import { colors, fonts, space } from '@/theme';

type Step = 'form' | 'review' | 'sending' | 'done';

const STAGE_TEXT: Record<Stage, string> = {
  preparing: 'Getting the latest network state…',
  forging: 'Securing your payment on this phone… This can take up to a minute.',
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
  const [note, setNote] = useState('');
  const [checkedLookalike, setCheckedLookalike] = useState(false);
  const [contactName, setContactName] = useState('');
  const [savedContact, setSavedContact] = useState(false);
  const [fromLink, setFromLink] = useState(false);

  const fill = useCallback((p: ParsedLink) => {
    if (p.kind === 'gift') {
      // A gift link belongs on the claim screen.
      inbox.set(p);
      go('/claim');
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
    setCheckedLookalike(false);
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
          {!contactForTo && !savedContact ? (
            <Card>
              <Text style={{ color: colors.text, fontWeight: '600' }}>Save this address as a contact?</Text>
              <Field value={contactName} onChangeText={setContactName} maxLength={40} placeholder="Name" autoCapitalize="words" />
              <Button
                title="Save contact"
                kind="secondary"
                disabled={!contactName.trim() || safety.kind === 'lookalike'}
                onPress={() => {
                  w.saveContact(contactName.trim(), to);
                  setSavedContact(true);
                }}
              />
            </Card>
          ) : null}
          {savedContact ? <Notice>Saved {contactName.trim()} to your contacts.</Notice> : null}
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
          {fiat(plan.amount, w.price, currency) ? (
            <Text style={{ color: colors.muted, fontSize: 14 }}>{fiat(plan.amount, w.price, currency)}</Text>
          ) : null}
          <Text style={{ color: colors.muted, fontSize: 13, marginTop: space.sm }}>To</Text>
          {contactForTo ? <Text style={{ color: colors.accent, fontSize: 17, fontWeight: '700' }}>{contactForTo}</Text> : null}
          <Text selectable style={{ color: colors.text, fontFamily: fonts.mono, fontSize: 14, lineHeight: 22 }}>
            {groupAddress(to)}
          </Text>
          {note ? <Text style={{ color: colors.muted, fontSize: 14, marginTop: space.sm }}>For: {note}</Text> : null}
        </Card>
        {safety.kind === 'lookalike' ? (
          <Card style={{ borderColor: colors.danger }}>
            <Text style={{ color: colors.danger, fontWeight: '700', fontSize: 16 }}>Possible look-alike address</Text>
            <Body style={{ fontSize: 14 }}>
              This address starts and ends like {safety.name ? `your contact ${safety.name}` : 'an address you used before'}, but
              the middle is different. Scammers create addresses like this so a quick glance looks right.
            </Body>
            <Text style={{ color: colors.muted, fontFamily: fonts.mono, fontSize: 12 }}>Known: {groupAddress(safety.similarTo)}</Text>
            <Pressable
              accessibilityRole="checkbox"
              accessibilityState={{ checked: checkedLookalike }}
              onPress={() => setCheckedLookalike((v) => !v)}
              style={{ flexDirection: 'row', gap: space.sm, alignItems: 'center', paddingVertical: 4 }}
              hitSlop={8}
            >
              <View
                style={{
                  width: 22,
                  height: 22,
                  borderRadius: 6,
                  borderWidth: 2,
                  borderColor: colors.danger,
                  backgroundColor: checkedLookalike ? colors.danger : 'transparent',
                }}
              />
              <Text style={{ color: colors.text, flex: 1 }}>I checked every character with the person I am paying</Text>
            </Pressable>
          </Card>
        ) : safety.kind === 'new' ? (
          <Notice tone="warn">First time sending to this address. Confirm it with the person you are paying.</Notice>
        ) : null}
        <Card>
          <KeyValue label="Network fee" value={`${formatNoid(plan.fee)} NOID`} />
          {plan.feeBreakdown.stateGrowth > 0 ? (
            <KeyValue label="  includes storage fee" value={`${formatNoid(plan.feeBreakdown.stateGrowth)} NOID`} />
          ) : null}
          <KeyValue label="Total" value={`${formatNoid(plan.totalSpend)} NOID`} />
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
        <Button title={`Send ${formatNoid(plan.amount)} NOID`} disabled={safety.kind === 'lookalike' && !checkedLookalike} onPress={confirmAndSend} />
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
      {contactForTo ? <Text style={{ color: colors.accent, fontWeight: '600', marginTop: -space.sm }}>{contactForTo}</Text> : null}
      <View style={{ flexDirection: 'row', gap: space.sm }}>
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
              const p = parseLink(t, LINK_HOSTS);
              if (p) fill(p);
              else setToError('The copied text is not a NOID address.');
            }}
          />
        </View>
        <View style={{ flex: 1 }}>
          <Button title="Scan" kind="secondary" onPress={() => go('/scan')} />
        </View>
        <View style={{ flex: 1 }}>
          <Button title="Contacts" kind="secondary" onPress={() => go({ pathname: '/contacts', params: { pick: '1' } })} />
        </View>
      </View>
      {fromLink ? (
        <Notice tone="warn">Filled in from a link someone sent you. Check the address and amount before you send.</Notice>
      ) : null}
      {note ? <Notice>Payment request: {note}</Notice> : null}
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
      <Text style={{ color: colors.muted, fontSize: 14, marginTop: -space.sm }}>
        {amount && fiat(amount, w.price, currency) ? `${fiat(amount, w.price, currency)} · ` : ''}Available: {formatNoid(available)} NOID
      </Text>
      <Link title="Send everything" onPress={sendMax} disabled={!w.status || w.utxos.length === 0} />
      {error ? <Notice tone="danger">{error}</Notice> : null}
      <View style={{ flex: 1 }} />
      <Button title="Review" busy={busy} disabled={!to || !amountText} onPress={review} />
      <Button title="Cancel" kind="ghost" onPress={() => goBack()} />
    </Screen>
  );
}
