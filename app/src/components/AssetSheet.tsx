// "What to send": a bottom sheet over the Send form (no new screen). Lists
// NOID, then your tokens, then your NFTs. Picking one closes the sheet.
import { Image, Modal, Pressable, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { TokenIcon } from '@/components/AssetRows';
import { Icon } from '@/components/Icon';
import { NoidMark } from '@/components/SendPickers';
import { Avatar, ListRow } from '@/components/ui';
import { formatNoid } from '@/lib/amount';
import type { Api } from '@/lib/api';
import { nftName, posesAsNoid, shownAssets, tokenName, useAssets, usePicture, type Nft } from '@/lib/assets';
import { formatUnits, nftKey, shortId } from '@/lib/tokenMath';
import { useWallet } from '@/state/wallet';
import { colors, fonts, radius, space, type } from '@/theme';

/** "noid", "token:<asset id>" or "nft:<nft key>". */
export type AssetChoice = string;

export function NftThumb({ api, nft, size = 40 }: { api: Api; nft: Nft; size?: number }) {
  const uri = usePicture(api, nft.manifest?.image);
  if (uri) {
    return (
      <Image
        source={{ uri }}
        resizeMethod="resize"
        resizeMode="cover"
        accessibilityIgnoresInvertColors
        style={{ width: size, height: size, borderRadius: radius.sm, backgroundColor: colors.s2 }}
      />
    );
  }
  return <Avatar initials={`#${nft.serial}`.slice(0, 3)} size={size} />;
}

export function AssetSheet({
  visible,
  current,
  onPick,
  onClose,
}: {
  visible: boolean;
  current: AssetChoice;
  onPick: (choice: AssetChoice) => void;
  onClose: () => void;
}) {
  const w = useWallet();
  const insets = useSafeAreaInsets();
  const shown = shownAssets(useAssets(), w.meta?.address);
  const hidden = !!w.settings.hideBalance;
  const supported = !!w.status?.features?.nativeSend;
  const tokens = supported ? (shown?.tokens ?? []) : [];
  const nfts = supported ? (shown?.nfts ?? []) : [];
  const choose = (c: AssetChoice) => {
    onPick(c);
    onClose();
  };
  const tick = (c: AssetChoice) => (c === current ? <Icon name="check" size={18} color={colors.accent} /> : undefined);

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <Pressable accessibilityLabel="Close" onPress={onClose} style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.55)' }} />
      <View
        style={{
          maxHeight: '75%',
          backgroundColor: colors.s1,
          borderTopLeftRadius: radius.xl,
          borderTopRightRadius: radius.xl,
          borderTopWidth: 1,
          borderColor: colors.line,
          paddingBottom: insets.bottom + space.md,
        }}
      >
        <View style={{ alignItems: 'center', paddingTop: space.sm }}>
          <View style={{ width: 40, height: 4, borderRadius: 2, backgroundColor: colors.line }} />
        </View>
        <Text style={[type.title, { paddingHorizontal: space.gutter, paddingVertical: space.md }]}>What to send</Text>
        <ScrollView contentContainerStyle={{ paddingHorizontal: space.sm, gap: space.xs }}>
          <ListRow
            leading={<NoidMark />}
            title="NOID"
            subtitle="The Parano1d coin"
            value={hidden ? '••••' : formatNoid(w.balance, { maxDecimals: 4 })}
            onPress={() => choose('noid')}
            trailing={tick('noid')}
          />
          {tokens.length > 0 ? <Text style={[type.caption, { paddingHorizontal: space.md, paddingTop: space.sm }]}>Tokens</Text> : null}
          {tokens.map((t) => (
            <ListRow
              key={t.assetId}
              leading={<TokenIcon api={w.api} token={t} />}
              title={tokenName(t)}
              subtitle={`${posesAsNoid(t) ? 'Not the NOID coin · ' : ''}${t.manifest?.symbol ? `${t.manifest.symbol} · ` : ''}${shortId(t.assetId)}`}
              value={hidden ? '••••' : formatUnits(t.units, { maxDecimals: 4 })}
              onPress={() => choose(`token:${t.assetId}`)}
              trailing={tick(`token:${t.assetId}`)}
            />
          ))}
          {nfts.length > 0 ? <Text style={[type.caption, { paddingHorizontal: space.md, paddingTop: space.sm }]}>NFTs</Text> : null}
          {nfts.map((n) => {
            const key = nftKey(n.collection, n.serial);
            return (
              <ListRow
                key={key}
                leading={<NftThumb api={w.api} nft={n} />}
                title={nftName(n)}
                subtitle={n.listing ? 'Listed for sale' : n.locked ? 'Locked for now' : `#${n.serial} · ${shortId(n.collection)}`}
                onPress={() => choose(`nft:${key}`)}
                trailing={tick(`nft:${key}`)}
              />
            );
          })}
          {!supported ? (
            <Text style={[type.bodySm, { padding: space.md }]}>Your wallet server can’t prepare token and NFT transfers yet, so only NOID can be sent.</Text>
          ) : null}
          <View style={{ height: space.sm }} />
        </ScrollView>
        <Pressable accessibilityRole="button" onPress={onClose} style={{ alignItems: 'center', paddingTop: space.sm }} hitSlop={8}>
          <Text style={{ color: colors.textSecondary, fontFamily: fonts.uiSemi }}>Cancel</Text>
        </Pressable>
      </View>
    </Modal>
  );
}
