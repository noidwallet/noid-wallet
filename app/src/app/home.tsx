import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import { useCallback, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import { Pressable, RefreshControl, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ActionNotice, Button, Notice } from '@/components/ui';
import { HistoryRow, PendingRow } from '@/components/TxRow';
import { formatNoid, shortAddress } from '@/lib/amount';
import { inbox } from '@/lib/inbox';
import { nextRoute } from '@/lib/scan';
import { ago, go, useNow } from '@/lib/nav';
import { fiat } from '@/lib/safety';
import { useWallet } from '@/state/wallet';
import { colors, fonts, radius, space } from '@/theme';

/** Suggest merging once a wallet holds this many separate coins. */
const MERGE_HINT_AT = 20;

export default function Home() {
  const { meta, balance, utxos, pending, history, status, error, refreshing, refresh, lockState, settings, price, lastUpdated } =
    useWallet();
  const [copied, setCopied] = useState(false);
  const now = useNow();

  // A gift or payment link opened the app: take the user straight to it.
  const handleInbox = useCallback(() => {
    const route = nextRoute.take();
    if (route === '/backup') {
      go('/backup');
      return;
    }
    const link = inbox.peek();
    if (!link) return;
    if (link.kind === 'gift') go('/claim');
    else go('/send');
  }, []);
  // Only while home is on screen: a link never jumps over a send in progress.
  useFocusEffect(
    useCallback(() => {
      handleInbox();
      return inbox.subscribe(handleInbox);
    }, [handleInbox]),
  );

  if (!meta) return null;

  // Only count a pending transaction while its coins are still in the live
  // set: once a block spends them, `balance` already reflects it.
  const live = new Map(utxos.map((u) => [u.slotIndex, u.value]));
  const inFlight = pending.filter((p) => p.inputSlots.length > 0 && p.inputSlots.every((s) => live.has(s)));
  const pendingOut = inFlight.reduce((s, p) => s + (p.kind === 'send' || p.kind === 'gift' ? p.amount : 0) + p.fee, 0);
  // Gift claims coming in (their coins are not ours yet, so not in `balance`).
  const claimIn = pending.filter((p) => p.kind === 'claim').reduce((s, p) => s + p.amount, 0);
  const balanceValue = fiat(Math.max(0, balance - pendingOut), price, settings.currency ?? 'none');
  const lockedSlots = new Set(pending.flatMap((p) => p.inputSlots));
  const lockedValue = utxos.filter((u) => lockedSlots.has(u.slotIndex)).reduce((s, u) => s + u.value, 0);
  const available = balance - lockedValue;
  // What the user will hold once pending sends confirm; change comes back then.
  const shownBalance = Math.max(0, balance - pendingOut);
  const changeIn = Math.max(0, lockedValue - pendingOut);
  const hasServer = !!settings.apiUrl;
  const online = hasServer && !!status && !error;
  const sendBlocker = !hasServer
    ? 'Add a wallet server to send.'
    : !online
      ? 'Sending needs a connection to your wallet server.'
      : available === 0 && pendingOut > 0
        ? 'Your coins are in a pending transaction. Send again once it confirms.'
        : available === 0
          ? 'Receive some NOID first, then you can send.'
          : null;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }} edges={['top']}>
      <ScrollView
        contentContainerStyle={{ padding: space.lg, gap: space.xl }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={colors.accent} />}
      >
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
            <View
              style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: online ? (status?.synced ? colors.ok : colors.warn) : colors.danger }}
            />
            <Text style={{ color: colors.muted, fontFamily: fonts.mono, fontSize: 12 }}>
              {!hasServer
                ? 'no server'
                : !online
                  ? lastUpdated
                    ? `offline · updated ${ago(lastUpdated, now)}`
                    : 'offline'
                  : status?.synced
                    ? `block ${status.height.toLocaleString()}`
                    : `syncing · ${status?.syncStage}`}
            </Text>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Settings"
            onPress={() => go('/settings')}
            hitSlop={12}
            style={({ pressed }) => ({ paddingVertical: 6, paddingHorizontal: space.sm, opacity: pressed ? 0.6 : 1 })}
          >
            <Text style={{ color: colors.text, fontSize: 15, fontWeight: '600' }}>Settings</Text>
          </Pressable>
        </View>

        <View style={{ gap: space.sm }}>
          <Text style={{ color: colors.muted, fontSize: 13, letterSpacing: 0.8, textTransform: 'uppercase' }}>Balance</Text>
          <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: space.sm }}>
            <Text adjustsFontSizeToFit numberOfLines={1} style={{ color: colors.text, fontFamily: fonts.monoBold, fontSize: 44, flexShrink: 1 }}>
              {lastUpdated === null && !online ? '—' : formatNoid(shownBalance, { maxDecimals: 4 })}
            </Text>
            <Text style={{ color: colors.accent, fontFamily: fonts.monoBold, fontSize: 18 }}>NOID</Text>
          </View>
          {balanceValue ? <Text style={{ color: colors.muted, fontSize: 15 }}>{balanceValue}</Text> : null}
          {claimIn > 0 ? (
            <Text style={{ color: colors.accent, fontSize: 14 }}>+{formatNoid(claimIn)} from a gift arriving with the next block</Text>
          ) : null}
          {pendingOut > 0 ? (
            <Text style={{ color: colors.muted, fontSize: 14 }}>
              {formatNoid(pendingOut)} on its way out
              {changeIn > 0 ? ` · ${formatNoid(changeIn)} change returns with the next block` : ''}
              {available > 0 ? ` · ${formatNoid(available)} ready to send` : ''}
            </Text>
          ) : null}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Copy your address"
            onPress={async () => {
              await Clipboard.setStringAsync(meta.address);
              void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }}
            style={{
              alignSelf: 'flex-start',
              backgroundColor: colors.surface,
              borderColor: colors.line,
              borderWidth: 1,
              borderRadius: radius.sm,
              paddingHorizontal: space.md,
              paddingVertical: 6,
              marginTop: space.xs,
            }}
          >
            <Text style={{ color: colors.muted, fontFamily: fonts.mono, fontSize: 13 }}>
              {copied ? 'Address copied' : shortAddress(meta.address, 8)}
            </Text>
          </Pressable>
        </View>

        <View style={{ flexDirection: 'row', gap: space.md }}>
          <View style={{ flex: 1 }}>
            <Button title="Send" onPress={() => go('/send')} disabled={!!sendBlocker} />
          </View>
          <View style={{ flex: 1 }}>
            <Button title="Receive" kind="secondary" onPress={() => go('/receive')} />
          </View>
        </View>
        {sendBlocker && hasServer && online ? (
          <Text style={{ color: colors.muted, fontSize: 14, marginTop: -space.md }}>{sendBlocker}</Text>
        ) : null}

        <View style={{ flexDirection: 'row', gap: space.sm }}>
          <Tile title="Gift card" hint="Send NOID as a link" onPress={() => go('/gifts')} highlight />
          <Tile title="Request" hint="Ask for an amount" onPress={() => go('/request')} />
          <Tile title="Contacts" hint="People you pay" onPress={() => go('/contacts')} />
        </View>

        {lockState === 'no-screen-lock' ? (
          <Notice tone="danger">
            This phone has no screen lock, so anyone holding it can open your wallet. Set a PIN, pattern or fingerprint in
            your phone’s settings.
          </Notice>
        ) : null}
        {!meta.backedUp ? (
          <ActionNotice tone="warn" onPress={() => go('/backup')}>
            You have not confirmed a backup of your secret yet. Tap to back it up now.
          </ActionNotice>
        ) : null}
        {!hasServer ? (
          <ActionNotice tone="warn" onPress={() => go('/server')}>
            NOID isn’t connected to a wallet server yet, so your balance can’t load. Tap to add one.
          </ActionNotice>
        ) : error ? (
          <ActionNotice tone="danger" onPress={() => go('/server')}>
            {lastUpdated ? 'Showing your last known balance. ' : ''}Cannot reach your wallet server. Tap to check it.
          </ActionNotice>
        ) : null}
        {utxos.length >= MERGE_HINT_AT && pending.length === 0 ? (
          <ActionNotice onPress={() => go('/consolidate')}>
            Your balance is spread over {utxos.length} coins. Merging them makes future sends cheaper and faster. Tap to
            merge.
          </ActionNotice>
        ) : null}

        <View>
          <Text style={{ color: colors.text, fontSize: 18, fontWeight: '700', marginBottom: space.xs }}>Activity</Text>
          {pending.map((p) => (
            <PendingRow key={p.txid} item={p} />
          ))}
          {history.map((h) => (
            <HistoryRow key={h.txid} item={h} />
          ))}
          {pending.length === 0 && history.length === 0 ? (
            <Text style={{ color: colors.muted, fontSize: 15, paddingVertical: space.lg }}>
              No activity yet. Share your address from Receive to get your first NOID.
            </Text>
          ) : null}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

function Tile({ title, hint, onPress, highlight }: { title: string; hint: string; onPress: () => void; highlight?: boolean }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${title}. ${hint}`}
      onPress={onPress}
      style={({ pressed }) => ({
        flex: 1,
        minHeight: 72,
        padding: space.md,
        borderRadius: radius.md,
        borderWidth: 1,
        borderColor: highlight ? colors.accent : colors.line,
        backgroundColor: colors.surface,
        justifyContent: 'space-between',
        opacity: pressed ? 0.7 : 1,
      })}
    >
      <Text style={{ color: highlight ? colors.accent : colors.text, fontSize: 15, fontWeight: '700' }}>{title}</Text>
      <Text style={{ color: colors.muted, fontSize: 12 }}>{hint}</Text>
    </Pressable>
  );
}
