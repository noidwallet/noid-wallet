import { useState } from 'react';
import { ActivityIndicator, FlatList, RefreshControl, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { HistoryRow, makeFiatOf, makeNameOf, PendingRow } from '@/components/TxRow';
import { EmptyState, ScreenHeader } from '@/components/ui';
import type { HistoryItem } from '@/lib/api';
import { useWallet } from '@/state/wallet';
import { colors, space, type } from '@/theme';

/** Full activity list (virtualized, so long histories stay smooth), loading older pages as you scroll. */
export default function Activity() {
  const w = useWallet();
  const nameOf = makeNameOf(w.contacts);
  const fiatOf = makeFiatOf(w.price, w.settings.currency);
  const hidden = !!w.settings.hideBalance;
  const [older, setOlder] = useState<HistoryItem[]>([]);
  const [loadingMore, setLoadingMore] = useState(false);
  const [reachedEnd, setReachedEnd] = useState(false);
  const [moreFailed, setMoreFailed] = useState(false);

  // The wallet keeps the newest page; older pages are fetched here on demand.
  const seen = new Set(w.history.map((h) => h.txid));
  const all = [...w.history, ...older.filter((h) => !seen.has(h.txid))];
  const items = [
    // A just-confirmed payment shows once: as soon as history has it, that row wins.
    ...w.pending.filter((p) => !seen.has(p.txid)).map((p) => ({ key: `p-${p.txid}`, pending: p })),
    ...all.map((h) => ({ key: h.txid, history: h })),
  ];

  async function loadMore() {
    const last = all[all.length - 1];
    if (!w.meta || !last || loadingMore || reachedEnd || all.length < 30) return;
    setLoadingMore(true);
    setMoreFailed(false);
    try {
      const page = await w.api.history(w.meta.address, `${last.height}:${last.txid}`);
      setOlder((prev) => [...prev, ...page.items]);
      if (!page.nextBefore || page.items.length === 0) setReachedEnd(true);
    } catch {
      setMoreFailed(true);
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }} edges={['top', 'bottom']}>
      <ScreenHeader title="Activity" />
      <FlatList
        data={items}
        keyExtractor={(i) => i.key}
        contentContainerStyle={{ paddingHorizontal: space.gutter, paddingBottom: space.xxl }}
        refreshControl={
          <RefreshControl
            refreshing={w.refreshing}
            onRefresh={() => {
              setOlder([]);
              setReachedEnd(false);
              void w.refresh({ manual: true });
            }}
            tintColor={colors.accent}
          />
        }
        onEndReached={() => void loadMore()}
        onEndReachedThreshold={0.4}
        renderItem={({ item }) => (
          <View>
            {'pending' in item && item.pending ? <PendingRow item={item.pending} nameOf={nameOf} fiatOf={fiatOf} hidden={hidden} /> : null}
            {'history' in item && item.history ? <HistoryRow item={item.history} nameOf={nameOf} fiatOf={fiatOf} hidden={hidden} /> : null}
          </View>
        )}
        ListFooterComponent={
          loadingMore ? (
            <ActivityIndicator color={colors.accent} style={{ paddingVertical: space.lg }} />
          ) : moreFailed ? (
            <Text style={[type.bodySm, { textAlign: 'center', paddingVertical: space.lg }]} onPress={() => void loadMore()}>
              Couldn’t load older activity. Tap to try again.
            </Text>
          ) : null
        }
        ListEmptyComponent={<EmptyState icon="clock" title="No activity yet" body="Payments you send and receive show up here." />}
      />
    </SafeAreaView>
  );
}
