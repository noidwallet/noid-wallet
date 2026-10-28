import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import { useLocalSearchParams } from 'expo-router';
import { Image, Text, View, useWindowDimensions } from 'react-native';

import { Banner, Card, IconButton, KeyValue, Link, Pill, Screen, toast } from '@/components/ui';
import { nftName, shownAssets, useAssets, usePicture } from '@/lib/assets';
import { useCopied } from '@/lib/clip';
import { openProjectWebsite } from '@/lib/openWebsite';
import { formatUnits, nftKey } from '@/lib/tokenMath';
import { useWallet } from '@/state/wallet';
import { colors, fonts, radius, space, type } from '@/theme';

export default function NftDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { api, meta } = useWallet();
  const copied = useCopied();
  const { width } = useWindowDimensions();
  const shown = shownAssets(useAssets(), meta?.address);
  const nft = shown?.nfts.find((n) => nftKey(n.collection, n.serial) === id);
  const uri = usePicture(api, nft?.manifest?.image);

  if (!nft) {
    return (
      <Screen header={{ title: 'NFT' }}>
        <Banner tone="neutral">This NFT is no longer at your address.</Banner>
      </Screen>
    );
  }
  const m = nft.manifest;
  const side = width - space.gutter * 2;
  const ratio = m?.image ? m.image.height / m.image.width : 1;

  return (
    <Screen header={{ title: 'NFT' }}>
      <View
        style={{
          width: side,
          height: Math.min(side * ratio, side * 1.5),
          borderRadius: radius.lg,
          overflow: 'hidden',
          backgroundColor: colors.s1,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {uri ? (
          <Image source={{ uri }} resizeMode="contain" accessibilityIgnoresInvertColors style={{ width: '100%', height: '100%' }} />
        ) : (
          <Text style={{ color: colors.faint, fontFamily: fonts.monoBold, fontSize: 18 }}>#{nft.serial}</Text>
        )}
      </View>

      <View style={{ gap: space.xs }}>
        <Text style={type.h2}>{nftName(nft)}</Text>
        {nft.listing ? <Pill text={`Listed for ${formatUnits(nft.listing.askMicronoid)} NOID`} tone="info" /> : null}
        {nft.locked ? <Pill text="Locked for now" tone="warn" /> : null}
      </View>

      {m?.description || m?.website ? (
        <Card>
          {m.description ? <Text style={type.body}>{m.description}</Text> : null}
          {m.website ? <Link title={m.website.replace(/^https:\/\//, '')} onPress={() => openProjectWebsite(m.website!)} /> : null}
        </Card>
      ) : null}

      <Card>
        <KeyValue label="Number" value={`#${nft.serial}`} />
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
          <Text style={type.caption}>Collection ID</Text>
          <IconButton
            icon={copied.isCopied('id') ? 'check' : 'copy'}
            label={copied.isCopied('id') ? 'Collection ID copied' : 'Copy collection ID'}
            size={36}
            onPress={async () => {
              copied.mark('id');
              await Clipboard.setStringAsync(nft.collection);
              void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
              toast('Collection ID copied');
            }}
          />
        </View>
        <Text selectable style={[type.monoSm, { lineHeight: 20 }]}>
          {nft.collection}
        </Text>
      </Card>

      <Banner tone="neutral">
        Sending and selling NFTs from NOID is coming in an update. This NFT is safe at your address, and you can use it now in the official
        Parano1d wallet by restoring your NOID secret there.
      </Banner>
      <Banner tone="warn">Anyone can copy a picture. Only the collection ID and number identify an NFT.</Banner>
    </Screen>
  );
}
