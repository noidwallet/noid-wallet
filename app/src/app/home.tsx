import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import { useCallback, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import { Pressable, RefreshControl, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Svg, { Defs, LinearGradient, RadialGradient, Rect, Stop } from 'react-native-svg';

import { Icon } from '@/components/Icon';
import { HistoryRow, makeFiatOf, makeNameOf, PendingRow } from '@/components/TxRow';
import { Banner, Button, EmptyState, IconAction, IconButton, Link, Skeleton, toast } from '@/components/ui';
import { formatNoid, shortAddress } from '@/lib/amount';
import { LINK_HOSTS } from '@/lib/config';
import { inbox } from '@/lib/inbox';
import { parseLink } from '@/lib/links';
import { useCopied } from '@/lib/clip';
import { ago, go, goHandoff, useNow } from '@/lib/nav';
import { fiat } from '@/lib/safety';
import { nextRoute, scanResult } from '@/lib/scan';
import { useWallet } from '@/state/wallet';
import { colors, fonts, radius, space, type } from '@/theme';

/** Suggest merging once a wallet holds this many separate coins. */
const MERGE_HINT_AT = 20;
const ACTIVITY_ON_HOME = 10;

export default function Home() {
  const w = useWallet();
  const { meta, balance, utxos, pending, history, status, error, refreshing, refresh, lockState, settings, price, lastUpdated } = w;
  const [showAllBanners, setShowAllBanners] = useState(false);
  const [cardSize, setCardSize] = useState({ width: 0, height: 0 });
  const now = useNow();
  const copied = useCopied();

  // A gift or payment link (or a code scanned from here) takes the user straight to it.
  const handleInbox = useCallback(() => {
    if (nextRoute.take() === '/backup') {
      goHandoff('/backup');
      return;
    }
    const scanned = scanResult.take();
    if (scanned) {
      const p = parseLink(scanned, LINK_HOSTS);
      if (p) inbox.set(p);
      else toast('That is not a NOID code', 'danger');
    }
    const link = inbox.peek();
    if (!link) return;
    if (link.kind === 'gift') goHandoff('/claim');
    else goHandoff('/send');
  }, []);
  // Only while home is on screen: a link never jumps over a send in progress.
  useFocusEffect(
    useCallback(() => {
      handleInbox();
      return inbox.subscribe(handleInbox);
    }, [handleInbox]),
  );

  if (!meta) return null;
  const toggleHidden = () => {
    void Haptics.selectionAsync();
    void w.updateSettings({ hideBalance: !settings.hideBalance });
  };
  const nameOf = makeNameOf(w.contacts);
  const fiatOf = makeFiatOf(price, settings.currency);
  const hidden = !!settings.hideBalance;

  // Only count a pending transaction while its coins are still in the live
  // set: once a block spends them, `balance` already reflects it.
  const live = new Map(utxos.map((u) => [u.slotIndex, u.value]));
  const inFlight = pending.filter((p) => p.inputSlots.length > 0 && p.inputSlots.every((s) => live.has(s)));
  const pendingOut = inFlight.reduce(
    (s, p) => s + (p.kind === 'send' || p.kind === 'gift' ? p.amount + (p.walletFee ?? 0) : 0) + p.fee,
    0,
  );
  // Gift claims coming in (their coins are not ours yet, so not in `balance`).
  const claimIn = pending.filter((p) => p.kind === 'claim' && !p.confirmedAt).reduce((s, p) => s + p.amount, 0);
  const lockedSlots = new Set(pending.flatMap((p) => p.inputSlots));
  const lockedValue = utxos.filter((u) => lockedSlots.has(u.slotIndex)).reduce((s, u) => s + u.value, 0);
  const ready = balance - lockedValue;
  const shownBalance = Math.max(0, balance - pendingOut);
  const hasServer = !!settings.apiUrl;
  const online = hasServer && !!status && !error;
  const loaded = lastUpdated !== null || online;
  const value = loaded ? fiat(shownBalance, price, settings.currency ?? 'none') : null;

  // First contact after opening the app: not offline, just not answered yet.
  const connecting = hasServer && !status && !error;
  const statusText = !hasServer
    ? 'No server'
    : connecting
      ? 'Connecting…'
      : !online
        ? lastUpdated
          ? `Offline · ${ago(lastUpdated, now)}`
          : 'Offline'
        : status?.synced
          ? 'Online'
          : 'Syncing';
  const statusColor = connecting ? colors.textSecondary : !online ? colors.danger : status?.synced ? colors.accent : colors.warn;

  // Most serious first; at most two unless the user asks for more.
  const banners: { key: string; node: React.ReactNode }[] = [];
  if (lockState === 'no-screen-lock') {
    banners.push({
      key: 'lock',
      node: (
        <Banner tone="danger">
          This phone has no screen lock, so anyone holding it can open your wallet. Set a PIN, pattern or fingerprint.
        </Banner>
      ),
    });
  }
  if (!hasServer) {
    banners.push({
      key: 'server',
      node: (
        <Banner tone="warn" icon="server" onPress={() => go('/server')}>
          NOID isn’t connected to a wallet server yet. Tap to add one.
        </Banner>
      ),
    });
  } else if (error) {
    banners.push({
      key: 'server',
      node: (
        <Banner tone="danger" icon="server" onPress={() => go('/server')}>
          {lastUpdated ? 'Showing your last known balance. ' : ''}Can’t reach your wallet server. Tap to check it.
        </Banner>
      ),
    });
  }
  if (!meta.backedUp) {
    banners.push({
      key: 'backup',
      node: (
        <Banner tone="warn" icon="key" onPress={() => go('/backup')}>
          Back up your secret, or you could lose this wallet. Tap to do it now.
        </Banner>
      ),
    });
  }
  if (utxos.length >= MERGE_HINT_AT && pending.length === 0) {
    banners.push({
      key: 'merge',
      node: (
        <Banner tone="info" icon="merge" onPress={() => go('/consolidate')}>
          Your balance is in {utxos.length} small pieces. Combine them to make sends cheaper and faster.
        </Banner>
      ),
    });
  }
  const shownBanners = showAllBanners ? banners : banners.slice(0, 2);

  const activity = [
    ...pending.filter((p) => !history.some((h) => h.txid === p.txid)).map((p) => ({
      key: `p-${p.txid}`,
      node: <PendingRow item={p} nameOf={nameOf} fiatOf={fiatOf} hidden={hidden} />,
    })),
    ...history.map((h) => ({
      key: h.txid,
      node: <HistoryRow item={h} nameOf={nameOf} fiatOf={fiatOf} hidden={hidden} />,
    })),
  ];

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }} edges={['top']}>
      <ScrollView
        contentContainerStyle={{
          paddingHorizontal: space.gutter,
          paddingBottom: space.xxl,
          gap: space.xl,
        }}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={() => void refresh({ manual: true })} tintColor={colors.accent} />
        }
      >
        {/* Header: wordmark, connection status, settings */}
        <View
          style={{
            height: 56,
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: space.md,
            }}
          >
            <Text
              style={{
                color: colors.accent,
                fontFamily: fonts.monoBold,
                fontSize: 18,
                letterSpacing: 2,
              }}
            >
              NOID
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Connection: ${statusText}`}
              hitSlop={10}
              onPress={() => go('/server')}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 6,
                backgroundColor: colors.s1,
                borderRadius: radius.pill,
                paddingHorizontal: 10,
                paddingVertical: 5,
              }}
            >
              <View
                style={{
                  width: 7,
                  height: 7,
                  borderRadius: 4,
                  backgroundColor: statusColor,
                }}
              />
              <Text
                style={{
                  color: colors.textSecondary,
                  fontFamily: fonts.mono,
                  fontSize: 12,
                }}
                numberOfLines={1}
                maxFontSizeMultiplier={1.3}
              >
                {statusText}
              </Text>
            </Pressable>
          </View>
          <IconButton icon="settings" label="Settings" onPress={() => go('/settings')} />
        </View>

        {/* Balance card */}
        <View
          style={{
            borderRadius: radius.xl,
            overflow: 'hidden',
            borderWidth: 1,
            borderColor: colors.lineStrong,
            // Same as the gradient's darker end, so the card never shows a gap.
            backgroundColor: '#0B1814',
          }}
          onLayout={(e) => {
            const { width, height } = e.nativeEvent.layout;
            if (width !== cardSize.width || height !== cardSize.height) setCardSize({ width, height });
          }}
        >
          {/* Drawn at the card's measured size: a "100%" SVG doesn't resize when the card grows. */}
          <Svg
            key={`${cardSize.width}x${cardSize.height}`}
            style={{ position: 'absolute', top: 0, left: 0 }}
            width={cardSize.width || '100%'}
            height={cardSize.height || '100%'}
            preserveAspectRatio="none"
          >
            <Defs>
              <LinearGradient id="hero" x1="0" y1="0" x2="1" y2="1">
                <Stop offset="0" stopColor="#0F2A22" />
                <Stop offset="1" stopColor="#08120F" />
              </LinearGradient>
              <RadialGradient id="glow" cx="90%" cy="0%" r="70%">
                <Stop offset="0" stopColor={colors.accent} stopOpacity={0.22} />
                <Stop offset="1" stopColor={colors.accent} stopOpacity={0} />
              </RadialGradient>
            </Defs>
            <Rect width="100%" height="100%" fill="url(#hero)" />
            <Rect width="100%" height="100%" fill="url(#glow)" />
          </Svg>
          <View style={{ padding: space.xl, gap: space.md }}>
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'space-between',
              }}
            >
              <Text style={type.caption}>Total balance</Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={hidden ? 'Show balance' : 'Hide balance'}
                hitSlop={12}
                onPress={toggleHidden}
              >
                <Icon name={hidden ? 'eyeOff' : 'eye'} size={20} color={colors.textSecondary} />
              </Pressable>
            </View>
            {loaded ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={hidden ? 'Balance hidden. Tap to show' : `${formatNoid(shownBalance)} NOID. Tap to hide`}
                onPress={toggleHidden}
                style={{
                  flexDirection: 'row',
                  alignItems: 'baseline',
                  gap: space.sm,
                }}
              >
                <Text adjustsFontSizeToFit numberOfLines={1} style={[type.display, { flexShrink: 1 }]}>
                  {hidden ? '••••••' : formatNoid(shownBalance)}
                </Text>
                <Text
                  style={{
                    color: colors.accent,
                    fontFamily: fonts.monoBold,
                    fontSize: 16,
                  }}
                >
                  NOID
                </Text>
              </Pressable>
            ) : (
              <Skeleton width={180} height={44} />
            )}
            {value && !hidden ? (
              <Text
                style={{
                  color: colors.textSecondary,
                  fontFamily: fonts.ui,
                  fontSize: 15,
                }}
              >
                {value}
              </Text>
            ) : null}
            {pendingOut > 0 && !hidden ? (
              <View
                style={{
                  alignSelf: 'flex-start',
                  backgroundColor: colors.warnTint,
                  borderRadius: radius.pill,
                  paddingHorizontal: 10,
                  paddingVertical: 4,
                }}
              >
                <Text
                  style={{
                    color: colors.warn,
                    fontFamily: fonts.uiBold,
                    fontSize: 12,
                  }}
                >
                  −{formatNoid(pendingOut)} pending
                  {ready > 0 ? ` · ${formatNoid(ready)} ready` : ''}
                </Text>
              </View>
            ) : null}
            {claimIn > 0 && !hidden ? (
              <Text
                style={{
                  color: colors.accent,
                  fontFamily: fonts.ui,
                  fontSize: 14,
                }}
              >
                +{formatNoid(claimIn)} from a gift arriving with the next block
              </Text>
            ) : null}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={copied.isCopied() ? 'Address copied' : 'Copy your address'}
              hitSlop={8}
              onPress={async () => {
                await Clipboard.setStringAsync(meta.address);
                void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                copied.mark();
                toast('Address copied');
              }}
              style={({ pressed }) => ({
                alignSelf: 'flex-start',
                flexDirection: 'row',
                alignItems: 'center',
                gap: space.sm,
                backgroundColor: 'rgba(0,0,0,0.25)',
                borderRadius: radius.pill,
                paddingHorizontal: space.md,
                paddingVertical: 7,
                marginTop: space.xs,
                opacity: pressed ? 0.7 : 1,
              })}
            >
              <Text
                style={{
                  color: colors.textSecondary,
                  fontFamily: fonts.mono,
                  fontSize: 13,
                }}
              >
                {shortAddress(meta.address, 8)}
              </Text>
              <Icon name={copied.isCopied() ? 'check' : 'copy'} size={16} color={copied.isCopied() ? colors.accent : colors.textSecondary} />
            </Pressable>
          </View>
        </View>

        {/* Main actions */}
        <View
          style={{
            flexDirection: 'row',
            justifyContent: 'space-between',
            paddingHorizontal: space.xs,
          }}
        >
          <IconAction icon="send" label="Send" onPress={() => go('/send')} highlight />
          <IconAction icon="receive" label="Receive" onPress={() => go('/receive')} />
          <IconAction icon="scan" label="Scan" onPress={() => go('/scan')} />
          <IconAction icon="gift" label="Gift" onPress={() => go('/gifts')} />
        </View>

        {banners.length > 0 ? (
          <View style={{ gap: space.sm }}>
            {shownBanners.map((b) => (
              <View key={b.key}>{b.node}</View>
            ))}
            {banners.length > 2 && !showAllBanners ? (
              <Link title={`+${banners.length - 2} more`} onPress={() => setShowAllBanners(true)} />
            ) : null}
          </View>
        ) : null}

        {/* Activity */}
        <View style={{ gap: space.xs }}>
          <View
            style={{
              flexDirection: 'row',
              justifyContent: 'space-between',
              alignItems: 'center',
            }}
          >
            <Text style={type.h2}>Activity</Text>
            {activity.length > ACTIVITY_ON_HOME ? <Link title="See all" onPress={() => go('/activity')} /> : null}
          </View>
          {!loaded ? (
            <View style={{ gap: space.md, paddingTop: space.sm }}>
              {[0, 1, 2].map((i) => (
                <View
                  key={i}
                  style={{
                    flexDirection: 'row',
                    gap: space.md,
                    alignItems: 'center',
                  }}
                >
                  <Skeleton width={40} height={40} style={{ borderRadius: 20 }} />
                  <View style={{ flex: 1, gap: 6 }}>
                    <Skeleton width="60%" height={14} />
                    <Skeleton width="35%" height={12} />
                  </View>
                </View>
              ))}
            </View>
          ) : activity.length === 0 ? (
            <EmptyState
              icon="receive"
              title="No activity yet"
              body="Share your address to receive your first NOID."
              action={<Button title="Receive NOID" kind="secondary" icon="receive" onPress={() => go('/receive')} />}
            />
          ) : (
            activity.slice(0, ACTIVITY_ON_HOME).map((a) => <View key={a.key}>{a.node}</View>)
          )}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}
