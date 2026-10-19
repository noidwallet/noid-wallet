import { router } from 'expo-router';
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import { useState } from 'react';
import { Pressable, RefreshControl, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Button, Notice } from '@/components/ui';
import { HistoryRow, PendingRow } from '@/components/TxRow';
import { formatNoid, shortAddress } from '@/lib/amount';
import { useWallet } from '@/state/wallet';
import { colors, fonts, radius, space } from '@/theme';

/** Suggest merging once a wallet holds this many separate coins. */
const MERGE_HINT_AT = 20;

export default function Home() {
  const { meta, balance, utxos, pending, history, status, error, refreshing, refresh, lockState } = useWallet();
  const [copied, setCopied] = useState(false);
  if (!meta) return null;

  const pendingOut = pending.reduce((s, p) => s + (p.kind === 'send' ? p.amount : 0) + p.fee, 0);
  const lockedSlots = new Set(pending.flatMap((p) => p.inputSlots));
  const available = utxos.filter((u) => !lockedSlots.has(u.slotIndex)).reduce((s, u) => s + u.value, 0);
  const online = !!status && !error;

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
              {!online ? 'offline' : status?.synced ? `block ${status.height.toLocaleString()}` : `syncing · ${status?.syncStage}`}
            </Text>
          </View>
          <Pressable accessibilityRole="button" onPress={() => router.push('/settings')} hitSlop={12}>
            <Text style={{ color: colors.muted, fontSize: 15 }}>Settings</Text>
          </Pressable>
        </View>

        <View style={{ gap: space.sm }}>
          <Text style={{ color: colors.muted, fontSize: 13, letterSpacing: 0.8, textTransform: 'uppercase' }}>Balance</Text>
          <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: space.sm }}>
            <Text adjustsFontSizeToFit numberOfLines={1} style={{ color: colors.text, fontFamily: fonts.monoBold, fontSize: 44, flexShrink: 1 }}>
              {formatNoid(balance, { maxDecimals: 4 })}
            </Text>
            <Text style={{ color: colors.accent, fontFamily: fonts.monoBold, fontSize: 18 }}>NOID</Text>
          </View>
          {pendingOut > 0 ? (
            <Text style={{ color: colors.muted, fontSize: 14 }}>
              {formatNoid(available)} available · {formatNoid(pendingOut)} on its way out
            </Text>
          ) : null}
          <Pressable
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
            <Button title="Send" onPress={() => router.push('/send')} disabled={!online || available === 0} />
          </View>
          <View style={{ flex: 1 }}>
            <Button title="Receive" kind="secondary" onPress={() => router.push('/receive')} />
          </View>
        </View>

        {lockState === 'no-screen-lock' ? (
          <Notice tone="danger">
            This phone has no screen lock, so anyone holding it can open your wallet. Set a PIN, pattern or fingerprint in
            your phone’s settings.
          </Notice>
        ) : null}
        {!meta.backedUp ? (
          <Pressable onPress={() => router.push('/backup')}>
            <Notice tone="warn">You have not confirmed a backup of your secret yet. Tap to back it up now.</Notice>
          </Pressable>
        ) : null}
        {error ? <Notice tone="danger">{error}</Notice> : null}
        {utxos.length >= MERGE_HINT_AT && pending.length === 0 ? (
          <Pressable onPress={() => router.push('/consolidate')}>
            <Notice>
              Your balance is spread over {utxos.length} coins. Merging them makes future sends cheaper and faster. Tap
              to merge.
            </Notice>
          </Pressable>
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
