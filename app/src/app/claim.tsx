import { useCallback, useEffect, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import { usePreventScreenCapture } from 'expo-screen-capture';
import { ActivityIndicator, View } from 'react-native';

import { RevealGiftCard } from '@/components/GiftCard';
import { SendProgress } from '@/components/Progress';
import { Banner, Body, Button, Card, Field, IconButton, KeyValue, Pill, Screen, SuccessMark, Title } from '@/components/ui';
import { formatNoid } from '@/lib/amount';
import { LINK_HOSTS } from '@/lib/config';
import { core, type SendPlan } from '@/lib/core';
import { inbox } from '@/lib/inbox';
import { parseLink, type ParsedLink } from '@/lib/links';
import { go, goHome, useHardwareBack } from '@/lib/nav';
import { fiat } from '@/lib/safety';
import { scanResult } from '@/lib/scan';
import { executeSweep, hasUnresolvedSend, planSweep, SubmitUnknown, type Stage } from '@/lib/send';
import { useWallet } from '@/state/wallet';
import { colors, space } from '@/theme';

type Gift = Extract<ParsedLink, { kind: 'gift' }>;
type View_ = 'enter' | 'loading' | 'ready' | 'empty' | 'failed' | 'claiming' | 'done';

export default function Claim() {
  // The gift secret is on this screen: no screenshots or app-switcher previews.
  usePreventScreenCapture('claim');
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
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
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

  if (view === 'claiming' && plan) {
    return (
      <Screen>
        <SendProgress stage={stage} title={`Claiming ${formatNoid(plan.amount)} NOID`} />
      </Screen>
    );
  }

  if (view === 'done' && plan && gift) {
    return (
      <Screen footer={<Button title="Done" onPress={goHome} />}>
        <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', gap: space.lg }}>
          <SuccessMark tone={unknown ? 'warn' : 'success'} />
          <Title style={{ textAlign: 'center' }}>
            {unknown ? 'Still checking with the network' : `${formatNoid(plan.amount)} NOID is yours`}
          </Title>
          <Body muted style={{ textAlign: 'center' }}>
            {unknown
              ? 'We lost contact while claiming. Your wallet keeps checking and finishes the claim; it shows in Activity.'
              : 'It lands in your wallet with the next block, usually within a minute.'}
          </Body>
        </View>
      </Screen>
    );
  }

  if ((view === 'ready' || view === 'empty' || view === 'loading' || view === 'failed') && gift) {
    const empty = view === 'empty';
    const amount = plan ? formatNoid(plan.amount) : gift.amount ?? '…';
    const value = plan ? fiat(plan.amount, w.price, w.settings.currency ?? 'none') : null;
    return (
      <Screen
        header={{ title: '' }}
        footer={
          view === 'ready' ? (
            <>
              <Button
                title={`Claim ${formatNoid(plan?.amount ?? 0)} NOID`}
                icon="receive"
                disabled={hasUnresolvedSend(w.pending)}
                onPress={claim}
              />
              {hasUnresolvedSend(w.pending) ? (
                <Body muted style={{ fontSize: 14, textAlign: 'center' }}>Your last transaction is still being checked. Claim once it shows as sent.</Body>
              ) : null}
            </>
          ) : view === 'failed' ? (
            <Button title="Try again" onPress={() => open(gift)} />
          ) : undefined
        }
      >
        <Title style={{ textAlign: 'center' }}>
          {mine ? 'One of your gift cards' : gift.from ? `${gift.from} sent you a gift` : 'You received a gift'}
        </Title>
        <View style={{ opacity: empty ? 0.4 : 1 }}>
          <RevealGiftCard theme={gift.theme} amount={empty ? '0' : amount} from={gift.from || undefined} />
        </View>
        {empty ? (
          <View style={{ alignItems: 'center' }}>
            <Pill text="Already claimed" tone="neutral" />
          </View>
        ) : null}
        {gift.message ? <Body style={{ fontStyle: 'italic', textAlign: 'center' }}>“{gift.message}”</Body> : null}
        {view === 'loading' ? <ActivityIndicator color={colors.accent} /> : null}
        {empty ? (
          <Banner tone="neutral">This gift has already been claimed, or the sender took it back. There is nothing left in it.</Banner>
        ) : null}
        {view === 'ready' && plan ? (
          <Card>
            <KeyValue label="You receive" value={`${formatNoid(plan.amount)} NOID`} />
            {value ? <KeyValue label="Worth" value={value} /> : null}
            <KeyValue label="Claim fee" value={`${formatNoid(plan.fee)} NOID (paid from the gift)`} />
          </Card>
        ) : null}
        {mine && view === 'ready' ? <Banner tone="info">Claiming your own gift moves it back into your wallet, like Take it back.</Banner> : null}
        {error ? <Banner tone="danger">{error}</Banner> : null}
      </Screen>
    );
  }

  return (
    <Screen
      header={{ title: 'Claim a gift card' }}
      footer={
        <Button
          title="Open gift"
          icon="gift"
          disabled={!text.trim()}
          onPress={() => {
            const p = parseLink(text, LINK_HOSTS);
            if (p?.kind === 'gift') return open(p);
            setError('That is not a NOID gift link. It should start with https://noidusa.com/g#');
          }}
        />
      }
    >
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
        keyboardType="visible-password"
        style={{ minHeight: 80, textAlignVertical: 'top' }}
        right={
          <View style={{ alignSelf: 'flex-start', paddingTop: 4 }}>
            <IconButton
              icon="paste"
              label="Paste gift link"
              size={40}
              onPress={async () => {
                const t = (await Clipboard.getStringAsync()).trim();
                if (!t) setError('Nothing to paste. Copy the gift link first.');
                else setText(t);
              }}
            />
            <IconButton icon="scan" label="Scan gift QR code" size={40} onPress={() => go('/scan')} />
          </View>
        }
      />
      {error ? <Banner tone="danger">{error}</Banner> : null}
    </Screen>
  );
}
