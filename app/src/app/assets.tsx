import { useEffect, useState } from 'react';
import { RefreshControl, ScrollView, Text, View, useWindowDimensions } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { NftTile, TokenRow } from '@/components/AssetRows';
import { Banner, EmptyState, ScreenHeader, Skeleton } from '@/components/ui';
import { assets, shownAssets, useAssets } from '@/lib/assets';
import { useWallet } from '@/state/wallet';
import { colors, space, type } from '@/theme';

export default function AssetsScreen() {
  const { api, meta, settings } = useWallet();
  const s = useAssets();
  const [pulling, setPulling] = useState(false);
  const { width } = useWindowDimensions();
  const tile = Math.floor((width - space.gutter * 2 - space.md * 2) / 3);
  const shown = shownAssets(s);
  const hidden = !!settings.hideBalance;

  useEffect(() => {
    if (meta) void assets.refresh(api, meta.address);
  }, [api, meta]);

  const reload = async () => {
    if (!meta) return;
    setPulling(true);
    await assets.refresh(api, meta.address, { force: true });
    setPulling(false);
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }} edges={['top', 'bottom']}>
      <ScreenHeader title="Tokens and NFTs" />
      <ScrollView
        contentContainerStyle={{ paddingHorizontal: space.gutter, paddingBottom: space.xxl, gap: space.lg }}
        refreshControl={<RefreshControl refreshing={pulling} onRefresh={() => void reload()} tintColor={colors.accent} />}
      >
        {s.kind === 'unsupported' ? (
          <Banner tone="neutral">Your wallet server doesn’t show tokens yet. Your tokens are safe at your address either way.</Banner>
        ) : null}
        {s.kind === 'error' ? <Banner tone="warn">{s.message}</Banner> : null}

        {!shown && (s.kind === 'idle' || s.kind === 'error') ? (
          s.kind === 'idle' ? (
            <View style={{ gap: space.md }}>
              <Skeleton width="100%" height={56} />
              <Skeleton width="100%" height={56} />
            </View>
          ) : null
        ) : null}

        {shown && shown.tokens.length === 0 && shown.nfts.length === 0 ? (
          <EmptyState
            icon="receive"
            title="No tokens yet"
            body="Tokens and NFTs sent to your NOID address will show here."
          />
        ) : null}

        {shown && shown.tokens.length > 0 ? (
          <View style={{ gap: space.xs }}>
            <Text style={type.h2}>Tokens</Text>
            {shown.tokens.map((t) => (
              <TokenRow key={t.assetId} api={api} token={t} hidden={hidden} />
            ))}
          </View>
        ) : null}

        {shown && shown.nfts.length > 0 ? (
          <View style={{ gap: space.md }}>
            <Text style={type.h2}>NFTs</Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.md }}>
              {shown.nfts.map((n) => (
                <NftTile key={`${n.collection}-${n.serial}`} api={api} nft={n} size={tile} />
              ))}
            </View>
          </View>
        ) : null}

        {shown && (shown.collections > 0 || shown.other > 0) ? (
          <Banner tone="neutral">
            {[
              shown.collections > 0 ? `${shown.collections} NFT collection${shown.collections === 1 ? '' : 's'} you created` : null,
              shown.other > 0 ? `${shown.other} open trade or pool record${shown.other === 1 ? '' : 's'}` : null,
            ]
              .filter(Boolean)
              .join(' and ')}{' '}
            can be managed in the official Parano1d wallet with your NOID secret.
          </Banner>
        ) : null}
        {shown && !shown.complete ? (
          <Banner tone="neutral">This address holds more records than NOID can show at once. Some may be missing here.</Banner>
        ) : null}

        {shown && (shown.tokens.length > 0 || shown.nfts.length > 0) ? (
          <Text style={type.bodySm}>
            Sending and trading tokens from NOID is coming in an update. Until then, they stay safe at your address, and you can use them
            in the official Parano1d wallet by restoring your NOID secret there.
          </Text>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}
