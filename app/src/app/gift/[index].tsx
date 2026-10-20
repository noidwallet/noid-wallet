import { useCallback, useEffect, useRef, useState } from 'react';
import { useFocusEffect, useLocalSearchParams } from 'expo-router';
import * as Clipboard from 'expo-clipboard';
import * as Sharing from 'expo-sharing';
import { ActivityIndicator, Share, Text, View } from 'react-native';
import QRCode from 'react-native-qrcode-svg';
import { captureRef } from 'react-native-view-shot';

import { GiftCard } from '@/components/GiftCard';
import { Body, Button, Card, KeyValue, Notice, Screen, Title } from '@/components/ui';
import { formatNoid, shortAddress } from '@/lib/amount';
import { LINK_BASE } from '@/lib/config';
import { core } from '@/lib/core';
import { giftState, type GiftState } from '@/lib/gifts';
import { giftLink, type GiftTheme } from '@/lib/links';
import { goBack, goHome } from '@/lib/nav';
import { executeSweep, FeeChanged, planSweep, SubmitUnknown } from '@/lib/send';
import { storage } from '@/lib/storage';
import { useWallet } from '@/state/wallet';
import { colors, radius, space } from '@/theme';

const STATE_TEXT: Record<GiftState, { text: string; color: string }> = {
  draft: { text: 'Not sent: the gift was never funded', color: colors.muted },
  waiting: { text: 'Funding… waiting for the next block', color: colors.warn },
  funded: { text: 'Ready to claim', color: colors.accent },
  claimed: { text: 'Claimed', color: colors.accent },
  takenBack: { text: 'Taken back to your wallet', color: colors.muted },
};

export default function GiftDetail() {
  const params = useLocalSearchParams<{ index: string; fresh?: string }>();
  const index = Number(params.index);
  const w = useWallet();
  const gift = w.gifts.find((g) => g.index === index);
  const [link, setLink] = useState<string | null>(null);
  const [state, setState] = useState<GiftState | null>(null);
  const [showQr, setShowQr] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [takingBack, setTakingBack] = useState(false);
  const shot = useRef<View>(null);

  // The gift's secret is derived again from your wallet secret, never stored.
  useEffect(() => {
    if (!gift) return;
    let alive = true;
    (async () => {
      const secret = await storage.readSecret();
      const g = await core.giftKey(secret, gift.index);
      if (!alive) return;
      if (g.address !== gift.address) {
        setError('This gift does not belong to this wallet.');
        return;
      }
      setLink(
        giftLink(LINK_BASE, {
          secretHex: g.giftSecretHex,
          amount: formatNoid(gift.amount).replace(/,/g, ''),
          message: gift.message,
          theme: gift.theme as GiftTheme,
          from: gift.from,
        }),
      );
    })().catch((e: Error) => setError(e.message));
    return () => {
      alive = false;
    };
  }, [gift]);

  const check = useCallback(() => {
    if (!gift) return;
    giftState(w.api, gift)
      .then((s) => {
        setState(s);
        if ((s === 'claimed' || s === 'takenBack') && gift.status !== s) w.saveGift({ ...gift, status: s });
        if (s === 'funded' && gift.status === 'draft') w.saveGift({ ...gift, status: 'funded' });
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
  const open = state === 'funded' || state === 'waiting' || (state === null && g.status === 'funded');

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
    if (!(await w.confirmUser('Take this gift back'))) return;
    setTakingBack(true);
    try {
      const secret = await storage.readSecret();
      const key = await core.giftKey(secret, g.index);
      const { plan } = await planSweep(w.api, g.address, w.pending);
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
      void w.refresh();
      check();
    } catch (e) {
      if (e instanceof SubmitUnknown) {
        w.saveGift({ ...g, takeBackTxid: e.txid });
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

  const status = STATE_TEXT[state ?? (g.status === 'draft' ? 'draft' : 'waiting')];

  return (
    <Screen>
      <Title>{params.fresh ? 'Your gift card is ready' : 'Gift card'}</Title>
      {/* Captured as the shareable image: card, message and claim QR. */}
      <View ref={shot} collapsable={false} style={{ backgroundColor: colors.bg, gap: space.md, paddingVertical: space.sm }}>
        <GiftCard theme={g.theme as GiftTheme} amount={amount} from={g.from || undefined} />
        {g.message ? <Body style={{ fontStyle: 'italic', textAlign: 'center' }}>“{g.message}”</Body> : null}
        {showQr && link ? (
          <View style={{ alignItems: 'center', gap: space.sm }}>
            <View style={{ padding: space.md, backgroundColor: '#fff', borderRadius: radius.lg }}>
              <QRCode value={link} size={200} backgroundColor="#fff" color="#000" />
            </View>
            <Text style={{ color: colors.muted, fontSize: 13 }}>Scan with the NOID wallet to claim</Text>
          </View>
        ) : null}
      </View>

      <Text style={{ color: status.color, fontSize: 16, fontWeight: '600' }}>{status.text}</Text>

      {open && link ? (
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
              <Button title={showQr ? 'Hide QR' : 'Show QR'} kind="secondary" onPress={() => setShowQr((v) => !v)} />
            </View>
          </View>
          <Button title="Share as image" kind="secondary" onPress={shareImage} />
          <Notice tone="warn">The link and QR code are the gift. Anyone who gets them can claim it.</Notice>
        </>
      ) : !link && !error ? (
        <ActivityIndicator color={colors.accent} />
      ) : null}

      <Card>
        <KeyValue label="Amount" value={`${amount} NOID`} />
        <KeyValue label="Gift address" value={shortAddress(g.address)} />
        <KeyValue label="Created" value={new Date(g.createdAt).toLocaleDateString()} mono={false} />
      </Card>

      {error ? <Notice tone="danger">{error}</Notice> : null}

      {state === 'funded' ? (
        <Button title="Take it back" kind="danger" busy={takingBack} onPress={takeBack} />
      ) : null}
      {state === 'claimed' || state === 'takenBack' || state === 'draft' ? (
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
      <Button title={params.fresh ? 'Done' : 'Back'} kind="ghost" onPress={() => (params.fresh ? goHome() : goBack('/gifts'))} />
    </Screen>
  );
}
