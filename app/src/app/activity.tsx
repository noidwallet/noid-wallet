import { FlatList, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { HistoryRow, makeNameOf, PendingRow } from '@/components/TxRow';
import { EmptyState, ScreenHeader } from '@/components/ui';
import { useWallet } from '@/state/wallet';
import { colors, space } from '@/theme';

/** Full activity list (virtualized, so long histories stay smooth). */
export default function Activity() {
  const w = useWallet();
  const nameOf = makeNameOf(w.contacts);
  const items = [
    ...w.pending.map((p) => ({ key: `p-${p.txid}`, pending: p })),
    ...w.history.map((h) => ({ key: h.txid, history: h })),
  ];
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }} edges={['top', 'bottom']}>
      <ScreenHeader title="Activity" />
      <FlatList
        data={items}
        keyExtractor={(i) => i.key}
        contentContainerStyle={{ paddingHorizontal: space.gutter, paddingBottom: space.xxl }}
        renderItem={({ item }) => (
          <View>
            {'pending' in item && item.pending ? <PendingRow item={item.pending} nameOf={nameOf} /> : null}
            {'history' in item && item.history ? <HistoryRow item={item.history} nameOf={nameOf} /> : null}
          </View>
        )}
        ListEmptyComponent={<EmptyState icon="clock" title="No activity yet" body="Payments you send and receive show up here." />}
      />
    </SafeAreaView>
  );
}
