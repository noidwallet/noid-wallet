import { useCallback, useEffect, useRef, useState } from 'react';
import { useFocusEffect, useLocalSearchParams } from 'expo-router';
import { usePreventScreenCapture } from 'expo-screen-capture';
import { ActivityIndicator, Share, Text, View } from 'react-native';
import QRCode from 'react-native-qrcode-svg';

import { GiftCard, RevealGiftCard } from '@/components/GiftCard';
import { LogoMark } from '@/components/Logo';
import { Banner, Body, Button, Card, IconAction, KeyValue, Pill, Screen, SuccessMark } from '@/components/ui';
import { copySensitive } from '@/lib/clip';
import { formatNoid, shortAddress } from '@/lib/amount';
import { LINK_BASE } from '@/lib/config';
import { core } from '@/lib/core';
import { GIFT_BADGE, GIFT_STATUS, GIFT_TONE, giftState, sweepFeeTooHigh, type GiftState } from '@/lib/gifts';
import { giftLink, type GiftTheme } from '@/lib/links';
import { onRelock } from '@/lib/lockEvents';
import { goBack, goHome } from '@/lib/nav';
import { executeSweep, FeeChanged, planSweep, SubmitUnknown } from '@/lib/send';
import { removeSharedFiles, shareViewAsImage } from '@/lib/shareImage';
import { storage } from '@/lib/storage';
import { useWallet } from '@/state/wallet';

import { colors, fonts, radius, space, type } from '@/theme';

export default function GiftDetail() {
  // The gift link is money: keep it out of screenshots and the app switcher.
  usePreventScreenCapture('gift-detail');
  const params = useLocalSearchParams<{ index: string; fresh?: string }>();
  const index = Number(params.index);
  const w = useWallet();
  const gift = w.gifts.find((g) => g.index === index);
  const [link, setLink] = useState<string | null>(null);
  const [checkFailed, setCheckFailed] = useState(false);
  const [state, setState] = useState<GiftState | null>(null);
  const [showDetails, setShowDetails] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [takingBack, setTakingBack] = useState(false);
  const shot = useRef<View>(null);
  // Re-locked from the background: the link is like cash, so hide it again.
  useEffect(() => onRelock(() => setLink(null)), []);
  // Shared card images hold the claim QR: they are removed a few minutes after
  // sharing and, at the latest, when this screen closes (see lib/shareImage).
  useEffect(() => removeSharedFiles, []);
  const [shotSize, setShotSize] = useState({ width: 0, height: 0 });
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
        setCheckFailed(false);
      })
      .catch(() => setCheckFailed(true));
  }, [gift, w]);

  useFocusEffect(check);
  useEffect(() => {
    const t = setInterval(check, 15_000);
    return () => clearInterval(t);
  }, [check]);

  if (!gift) {
    return (
      <Screen header={{ title: 'Gift card', back: () => goBack('/gifts') }}>
        <Banner tone="neutral">This gift card is not on this phone.</Banner>
      </Screen>
    );
  }
  const g = gift;
  const amount = formatNoid(g.amount);
  const shareText = link
    ? `I sent you a NOID gift card: ${amount} NOID${g.message ? ` — “${g.message}”` : ''}. Open this link to claim it with the NOID wallet: ${link}`
    : '';
  // Until the chain answers, show what this phone last knew (never guess "sending").
  const shown: GiftState = state ?? g.status;
  const canShare = shown === 'funded' || shown === 'waiting';

  async function shareImage() {
    try {
      await shareViewAsImage(shot, { size: shotSize, dialogTitle: 'Share gift card' });
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
  const Card_ = fresh ? RevealGiftCard : GiftCard;

  return (
    <Screen
      header={{ title: fresh ? '' : 'Gift card', back: () => (fresh ? goHome() : goBack('/gifts')) }}
      footer={
        fresh ? (
          <>
            <Button title="Done" onPress={goHome} />
            {shown === 'funded' ? <Button title="Take it back" kind="tertiary" busy={takingBack} onPress={takeBack} /> : null}
          </>
        ) : shown === 'funded' ? (
          <Button title="Take it back" kind="danger" busy={takingBack} onPress={takeBack} />
        ) : shown === 'claimed' || shown === 'takenBack' || shown === 'draft' ? (
          <Button
            title="Remove from list"
            kind="tertiary"
            onPress={() => {
              // Hidden, not deleted: a gift number must never be used twice.
              w.saveGift({ ...g, hidden: true });
              goBack('/gifts');
            }}
          />
        ) : undefined
      }
    >
      {fresh ? (
        <View style={{ alignItems: 'center', gap: space.sm }}>
          <SuccessMark />
          <Text style={[type.h1, { textAlign: 'center' }]}>Your gift card is ready</Text>
          <Body muted style={{ textAlign: 'center' }}>Share it with the person it’s for. They claim it into their own NOID wallet.</Body>
        </View>
      ) : (
        <Pill text={GIFT_BADGE[shown]} tone={GIFT_TONE[shown]} />
      )}
      {/* Captured as the shareable image: branded frame, card, message and the claim QR. */}
      <View
        ref={shot}
        collapsable={false}
        onLayout={(e) => {
          const { width, height } = e.nativeEvent.layout;
          if (width !== shotSize.width || height !== shotSize.height) setShotSize({ width, height });
        }}
        style={{
          backgroundColor: '#0B1814',
          borderRadius: radius.xl,
          borderWidth: 1,
          borderColor: colors.lineStrong,
          padding: space.lg,
          gap: space.md,
        }}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
            <LogoMark size={22} glow={false} />
            <Text style={{ color: colors.accent, fontFamily: fonts.monoBold, fontSize: 14, letterSpacing: 2 }}>NOID</Text>
          </View>
          <View style={{ backgroundColor: colors.accentTint, borderRadius: radius.pill, paddingHorizontal: space.md, paddingVertical: 4 }}>
            <Text style={{ color: colors.accent, fontFamily: fonts.uiBold, fontSize: 11, letterSpacing: 1.2 }}>GIFT CARD</Text>
          </View>
        </View>
        <Card_ theme={g.theme as GiftTheme} amount={amount} from={g.from || undefined} />
        {g.message ? <Body style={{ textAlign: 'center' }}>“{g.message}”</Body> : null}
        {link && canShare ? (
          <View style={{ alignItems: 'center', gap: space.sm }}>
            <View style={{ padding: space.md, backgroundColor: '#fff', borderRadius: radius.lg }}>
              <QRCode value={link} size={180} backgroundColor="#fff" color="#000" />
            </View>
            <Text style={{ color: colors.textSecondary, fontFamily: fonts.ui, fontSize: 13, textAlign: 'center' }}>
              Scan with the NOID wallet to claim · {LINK_BASE.replace(/^https?:\/\//, '')}
            </Text>
          </View>
        ) : null}
      </View>

      {!fresh ? (
        <Text style={{ color: status.color, fontFamily: fonts.uiSemi, fontSize: 15, textAlign: 'center' }} accessibilityLiveRegion="polite">
          {status.text}
        </Text>
      ) : null}

      {canShare && link ? (
        <>
          <View style={{ flexDirection: 'row', justifyContent: 'space-evenly' }}>
            <IconAction icon="share" label="Share link" highlight onPress={() => Share.share({ message: shareText }).catch(() => {})} />
            <IconAction icon="copy" label="Copy link" onPress={() => void copySensitive(link, 'Gift link')} />
            <IconAction icon="image" label="Share image" onPress={() => void shareImage()} />
          </View>
          <Banner tone="warn">The link, the QR code and the card image are the gift. Anyone who gets them can claim it.</Banner>
        </>
      ) : canShare && !link ? (
        <Button title="Show gift link and QR" kind="secondary" icon="shield" onPress={reveal} />
      ) : null}
      {state === null && !error && !checkFailed ? <ActivityIndicator color={colors.accent} /> : null}
      {checkFailed && state === null ? (
        <Banner tone="neutral">Can’t check this gift right now. It updates by itself once you’re back online.</Banner>
      ) : null}

      {showDetails ? (
        <Card>
          <KeyValue label="Amount" value={`${amount} NOID`} />
          <KeyValue label="Gift address" value={shortAddress(g.address)} />
          <KeyValue label="Created" value={new Date(g.createdAt).toLocaleDateString()} mono={false} />
        </Card>
      ) : (
        <Button title="Show details" kind="tertiary" onPress={() => setShowDetails(true)} />
      )}

      {error ? <Banner tone="danger">{error}</Banner> : null}
    </Screen>
  );
}
