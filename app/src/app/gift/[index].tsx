import { useCallback, useEffect, useRef, useState } from 'react';
import { useFocusEffect, useLocalSearchParams } from 'expo-router';
import * as Clipboard from 'expo-clipboard';
import { usePreventScreenCapture } from 'expo-screen-capture';
import * as Sharing from 'expo-sharing';
import { ActivityIndicator, Share, Text, View } from 'react-native';
import QRCode from 'react-native-qrcode-svg';
import { captureRef } from 'react-native-view-shot';

import { GiftCard } from '@/components/GiftCard';
import { Body, Button, Card, KeyValue, Notice, Screen, Title } from '@/components/ui';
import { formatNoid, shortAddress } from '@/lib/amount';
import { LINK_BASE } from '@/lib/config';
import { core } from '@/lib/core';
import { GIFT_STATUS, giftState, sweepFeeTooHigh, type GiftState } from '@/lib/gifts';
import { giftLink, type GiftTheme } from '@/lib/links';
import { goBack, goHome } from '@/lib/nav';
import { executeSweep, FeeChanged, planSweep, SubmitUnknown } from '@/lib/send';
import { storage } from '@/lib/storage';
import { useWallet } from '@/state/wallet';
import { colors, radius, space } from '@/theme';

export default function GiftDetail() {
  // The gift link is money: keep it out of screenshots and the app switcher.
  usePreventScreenCapture();
  const params = useLocalSearchParams<{ index: string; fresh?: string }>();
  const index = Number(params.index);
  const w = useWallet();
  const gift = w.gifts.find((g) => g.index === index);
  const [link, setLink] = useState<string | null>(null);
  const [state, setState] = useState<GiftState | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [takingBack, setTakingBack] = useState(false);
  const shot = useRef<View>(null);
  const fresh = !!params.fresh;

  // The gift's secret is derived again from your wallet secret, never stored.
  const deriveLink = useCallback(async (): Promise<string> => {
    if (!gift) throw new Error('This gift card is not on this phone.');
    const secret = await storage.readSecret();
    const g = await core.giftKey(secret, gift.index);
    if (g.address !== gift.address) throw new Error('This gift does not belong to this wallet.');
    return giftLink(LINK_BASE, {
      secretHex: g.giftSecretHex,
      amount: formatNoid(gift.amount).replace(/,/g, ''),
      message: gift.message,
      theme: gift.theme as GiftTheme,
      from: gift.from,
    });
  }, [gift]);

  async function reveal() {
    setError(null);
    if (!(await w.confirmUser('Show the gift link'))) return;
    try {
      setLink(await deriveLink());
    } catch (e) {
      setError((e as Error).message);
    }
  }

  // Right after creating it the user just confirmed with their phone lock.
  useEffect(() => {
    if (fresh) deriveLink().then(setLink, (e: Error) => setError(e.message));
  }, [fresh, deriveLink]);

  const check = useCallback(() => {
    if (!gift) return;
    giftState(w.api, gift)
      .then((s) => {
        setState(s);
        // Only record a finished state when the server's node is in sync.
        if (w.status?.synced && (s === 'claimed' || s === 'takenBack') && gift.status !== s) w.saveGift({ ...gift, status: s });
        if (s === 'funded' && gift.status !== 'funded') w.saveGift({ ...gift, status: 'funded' });
      })
      .catch(() => {});
  }, [gift, w]);

  useFocusEffect(check);
  useEffect(() => {
    const t = setInterval(check, 15_000);
    return () => clearInterval(t);
  }, [check]);

  if (!gift) {
    return (
      <Screen>
        <Title>Gift card</Title>
        <Notice>This gift card is not on this phone.</Notice>
        <Button title="Back" kind="ghost" onPress={() => goBack('/gifts')} />
      </Screen>
    );
  }
  const g = gift;
  const amount = formatNoid(g.amount);
  const shareText = link
    ? `I sent you a NOID gift card: ${amount} NOID${g.message ? ` — “${g.message}”` : ''}. Open this link to claim it with the NOID wallet: ${link}`
    : '';
  const shown: GiftState = state ?? (g.status === 'draft' ? 'draft' : 'waiting');
  const canShare = shown === 'funded' || shown === 'waiting';

  async function shareImage() {
    if (!shot.current) return;
    try {
      const uri = await captureRef(shot, { format: 'png', quality: 1, result: 'tmpfile' });
      await Sharing.shareAsync(uri, { mimeType: 'image/png', dialogTitle: 'Share gift card' });
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function takeBack() {
    if (!w.meta) return;
    setError(null);
    setTakingBack(true);
    try {
      const secret = await storage.readSecret();
      const key = await core.giftKey(secret, g.index);
      const { plan } = await planSweep(w.api, g.address, w.pending);
      if (sweepFeeTooHigh(plan.fee, plan.inputCount)) {
        throw new Error(`The network fee looks wrong (${formatNoid(plan.fee)} NOID). Check your wallet server in Settings.`);
      }
      if (!(await w.confirmUser(`Take back ${formatNoid(plan.amount)} NOID (fee ${formatNoid(plan.fee)})`))) return;
      const { pending } = await executeSweep({
        api: w.api,
        secretHex: key.giftSecretHex,
        keyIndex: 0,
        address: g.address,
        pending: w.pending,
        record: w.recordPending,
        discard: w.discardPending,
        to: w.meta.address,
        reviewedFee: plan.fee,
        kind: 'claim',
      });
      w.saveGift({ ...g, takeBackTxid: pending.txid });
      setState('takingBack');
      void w.refresh();
    } catch (e) {
      if (e instanceof SubmitUnknown) {
        w.saveGift({ ...g, takeBackTxid: e.txid });
        setState('takingBack');
        setError(e.message);
      } else if (e instanceof FeeChanged) {
        setError('The network fee changed. Try again.');
      } else {
        setError((e as Error).message);
      }
    } finally {
      setTakingBack(false);
    }
  }

  const status = GIFT_STATUS[shown];

  return (
    <Screen>
      <Title>{fresh ? 'Your gift card is ready' : 'Gift card'}</Title>
      {/* Captured as the shareable image: card, message and the claim QR. */}
      <View ref={shot} collapsable={false} style={{ backgroundColor: colors.bg, gap: space.md, paddingVertical: space.sm }}>
        <GiftCard theme={g.theme as GiftTheme} amount={amount} from={g.from || undefined} />
        {g.message ? <Body style={{ fontStyle: 'italic', textAlign: 'center' }}>“{g.message}”</Body> : null}
        {link && canShare ? (
          <View style={{ alignItems: 'center', gap: space.sm }}>
            <View style={{ padding: space.md, backgroundColor: '#fff', borderRadius: radius.lg }}>
              <QRCode value={link} size={180} backgroundColor="#fff" color="#000" />
            </View>
            <Text style={{ color: colors.muted, fontSize: 13 }}>Scan with the NOID wallet to claim</Text>
          </View>
        ) : null}
      </View>

      <Text style={{ color: status.color, fontSize: 16, fontWeight: '600' }} accessibilityLiveRegion="polite">
        {status.text}
      </Text>

      {canShare && link ? (
        <>
          <Button title="Share gift link" onPress={() => Share.share({ message: shareText }).catch(() => {})} />
          <View style={{ flexDirection: 'row', gap: space.md }}>
            <View style={{ flex: 1 }}>
              <Button
                title={copied ? 'Copied' : 'Copy link'}
                kind="secondary"
                onPress={async () => {
                  await Clipboard.setStringAsync(link);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                }}
              />
            </View>
            <View style={{ flex: 1 }}>
              <Button title="Share card with QR" kind="secondary" onPress={shareImage} />
            </View>
          </View>
          <Notice tone="warn">The link, the QR code and the card image are the gift. Anyone who gets them can claim it.</Notice>
        </>
      ) : canShare && !link ? (
        <Button title="Show gift link and QR" kind="secondary" onPress={reveal} />
      ) : null}
      {state === null && !error ? <ActivityIndicator color={colors.accent} /> : null}

      <Card>
        <KeyValue label="Amount" value={`${amount} NOID`} />
        <KeyValue label="Gift address" value={shortAddress(g.address)} />
        <KeyValue label="Created" value={new Date(g.createdAt).toLocaleDateString()} mono={false} />
      </Card>

      {error ? <Notice tone="danger">{error}</Notice> : null}

      {shown === 'funded' ? <Button title="Take it back" kind="danger" busy={takingBack} onPress={takeBack} /> : null}
      {shown === 'claimed' || shown === 'takenBack' || shown === 'draft' ? (
        <Button
          title="Remove from list"
          kind="ghost"
          onPress={() => {
            // Hidden, not deleted: a gift number must never be used twice.
            w.saveGift({ ...g, hidden: true });
            goBack('/gifts');
          }}
        />
      ) : null}
      <Button title={fresh ? 'Done' : 'Back'} kind="ghost" onPress={() => (fresh ? goHome() : goBack('/gifts'))} />
    </Screen>
  );
}
