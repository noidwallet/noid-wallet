import { useCallback, useEffect, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import { usePreventScreenCapture } from 'expo-screen-capture';
import { ActivityIndicator, Text, View } from 'react-native';

import { GiftCard } from '@/components/GiftCard';
import { Body, Button, Card, Field, KeyValue, Notice, Screen, Title } from '@/components/ui';
import { formatNoid } from '@/lib/amount';
import { LINK_HOSTS } from '@/lib/config';
import { core, type SendPlan } from '@/lib/core';
import { inbox } from '@/lib/inbox';
import { parseLink, type ParsedLink } from '@/lib/links';
import { go, goBack, goHome, useHardwareBack } from '@/lib/nav';
import { fiat } from '@/lib/safety';
import { scanResult } from '@/lib/scan';
import { executeSweep, hasUnresolvedSend, planSweep, SubmitUnknown, type Stage } from '@/lib/send';
import { useWallet } from '@/state/wallet';
import { colors, fonts, space } from '@/theme';

type Gift = Extract<ParsedLink, { kind: 'gift' }>;
type View_ = 'enter' | 'loading' | 'ready' | 'empty' | 'failed' | 'claiming' | 'done';

const STAGE_TEXT: Record<Stage, string> = {
  preparing: 'Opening the gift…',
  forging: 'Securing the transfer on this phone…',
  submitting: 'Moving the NOID into your wallet…',
  retrying: 'A new block arrived. Trying again…',
};

export default function Claim() {
  // The gift secret is on this screen: no screenshots or app-switcher previews.
  usePreventScreenCapture();
  const w = useWallet();
  const [gift, setGift] = useState<Gift | null>(null);
  const [giftAddress, setGiftAddress] = useState<string | null>(null);
  const [plan, setPlan] = useState<SendPlan | null>(null);
  const [view, setView] = useState<View_>('enter');
  const [stage, setStage] = useState<Stage>('preparing');
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [unknown, setUnknown] = useState(false);

  useHardwareBack(useCallback(() => view === 'claiming', [view]));

  const open = useCallback(
    async (g: Gift) => {
      setGift(g);
      setError(null);
      setView('loading');
      try {
        const info = await core.inspectSecret(g.secretHex);
        setGiftAddress(info.address);
        const { plan } = await planSweep(w.api, info.address, w.pending);
        setPlan(plan);
        setView('ready');
      } catch (e) {
        const code = (e as { code?: string }).code;
        if (code === 'empty') setView('empty');
        else {
          // Keep the gift on screen so the user can simply try again.
          setError(
            !w.settings.apiUrl
              ? 'NOID is not connected to a wallet server yet. Add one in Settings, then try again.'
              : (e as Error).message,
          );
          setView('failed');
        }
      }
    },
    [w.api, w.pending, w.settings.apiUrl],
  );

  // A gift link that opened the app, or one scanned with the camera.
  useFocusEffect(
    useCallback(() => {
      const incoming = inbox.peek();
      if (incoming?.kind === 'gift') {
        inbox.take();
        void open(incoming);
        return;
      }
      const scanned = scanResult.take();
      if (scanned) {
        const p = parseLink(scanned, LINK_HOSTS);
        if (p?.kind === 'gift') void open(p);
        else setError('That QR code is not a NOID gift card.');
      }
    }, [open]),
  );

  // Gift links can arrive while this screen is open.
  useEffect(
    () =>
      inbox.subscribe(() => {
        const incoming = inbox.peek();
        if (incoming?.kind === 'gift' && view !== 'claiming') {
          inbox.take();
          void open(incoming);
        }
      }),
    [open, view],
  );

  if (!w.meta) return null;
  const meta = w.meta;
  const mine = giftAddress ? w.gifts.some((g) => g.address === giftAddress) : false;

  async function claim() {
    if (!gift || !giftAddress || !plan) return;
    setView('claiming');
    setError(null);
    try {
      await executeSweep({
        api: w.api,
        secretHex: gift.secretHex,
        keyIndex: 0,
        address: giftAddress,
        pending: w.pending,
        record: w.recordPending,
        discard: w.discardPending,
        to: meta.address,
        reviewedFee: plan.fee,
        kind: 'claim',
        onStage: setStage,
      });
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      void w.refresh();
      setView('done');
    } catch (e) {
      if (e instanceof SubmitUnknown) {
        setUnknown(true);
        setView('done');
        return;
      }
      const code = (e as { code?: string }).code;
      if (code === 'empty' || code === 'inputs_spent') {
        setView('empty');
        return;
      }
      setError((e as Error).message);
      setView('ready');
    }
  }

  if (view === 'claiming') {
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

  if (view === 'done' && plan && gift) {
    return (
      <Screen>
        <View style={{ flex: 1, justifyContent: 'center', gap: space.lg }}>
          <Text style={{ color: unknown ? colors.warn : colors.accent, fontFamily: fonts.monoBold, fontSize: 14, letterSpacing: 1.5 }}>
            {unknown ? 'CHECKING' : 'CLAIMED'}
          </Text>
          <GiftCard theme={gift.theme} amount={formatNoid(plan.amount)} from={gift.from || undefined} />
          <Title>{formatNoid(plan.amount)} NOID is on its way to your wallet</Title>
          <Body muted>
            {unknown
              ? 'We lost contact while claiming. Your wallet keeps checking and finishes the claim; it shows in Activity.'
              : 'It lands with the next block, usually within a minute.'}
          </Body>
        </View>
        <Button title="Done" onPress={goHome} />
      </Screen>
    );
  }

  if ((view === 'ready' || view === 'empty' || view === 'loading' || view === 'failed') && gift) {
    const amount = plan ? formatNoid(plan.amount) : gift.amount ?? '…';
    return (
      <Screen>
        <Title>{mine ? 'One of your gift cards' : 'You received a gift'}</Title>
        <GiftCard theme={gift.theme} amount={amount} from={gift.from || undefined} />
        {gift.message ? <Body style={{ fontStyle: 'italic', textAlign: 'center' }}>“{gift.message}”</Body> : null}
        {view === 'loading' ? <ActivityIndicator color={colors.accent} /> : null}
        {view === 'empty' ? (
          <Notice tone="warn">This gift has already been claimed, or taken back by the sender. There is nothing left in it.</Notice>
        ) : null}
        {view === 'ready' && plan ? (
          <Card>
            <KeyValue label="You receive" value={`${formatNoid(plan.amount)} NOID`} />
            {fiat(plan.amount, w.price, w.settings.currency ?? 'none') ? (
              <KeyValue label="Worth" value={fiat(plan.amount, w.price, w.settings.currency ?? 'none')!} />
            ) : null}
            <KeyValue label="Claim fee" value={`${formatNoid(plan.fee)} NOID (inside the gift)`} />
          </Card>
        ) : null}
        {mine && view === 'ready' ? <Notice>Claiming your own gift moves it back into your wallet, like Take it back.</Notice> : null}
        {error ? <Notice tone="danger">{error}</Notice> : null}
        <View style={{ flex: 1 }} />
        {view === 'ready' ? (
          <Button title={`Claim ${formatNoid(plan?.amount ?? 0)} NOID`} disabled={hasUnresolvedSend(w.pending)} onPress={claim} />
        ) : null}
        {view === 'failed' ? <Button title="Try again" onPress={() => open(gift)} /> : null}
        {view === 'ready' && hasUnresolvedSend(w.pending) ? (
          <Body muted style={{ fontSize: 14 }}>Your last transaction is still being checked. Claim once it shows as sent.</Body>
        ) : null}
        <Button title="Back" kind="ghost" onPress={() => goBack()} />
      </Screen>
    );
  }

  return (
    <Screen>
      <Title>Claim a gift card</Title>
      <Body muted>Paste the gift link someone sent you, or scan the gift card’s QR code.</Body>
      <Field
        label="Gift link"
        mono
        multiline
        value={text}
        onChangeText={(t) => {
          setText(t);
          setError(null);
        }}
        placeholder="https://noidusa.com/g#…"
        autoComplete="off"
        importantForAutofill="no"
        style={{ minHeight: 80, textAlignVertical: 'top' }}
      />
      <View style={{ flexDirection: 'row', gap: space.md }}>
        <View style={{ flex: 1 }}>
          <Button
            title="Paste"
            kind="secondary"
            onPress={async () => {
              const t = (await Clipboard.getStringAsync()).trim();
              if (!t) setError('Nothing to paste. Copy the gift link first.');
              else setText(t);
            }}
          />
        </View>
        <View style={{ flex: 1 }}>
          <Button title="Scan QR" kind="secondary" onPress={() => go('/scan')} />
        </View>
      </View>
      {error ? <Notice tone="danger">{error}</Notice> : null}
      <View style={{ flex: 1 }} />
      <Button
        title="Open gift"
        disabled={!text.trim()}
        onPress={() => {
          const p = parseLink(text, LINK_HOSTS);
          if (p?.kind === 'gift') return open(p);
          setError('That is not a NOID gift link. It should start with https://noidusa.com/g#');
        }}
      />
      <Button title="Back" kind="ghost" onPress={() => goBack()} />
    </Screen>
  );
}
