import { Image, Pressable, Text, View } from 'react-native';

import { Avatar, ListRow, initialsOf, toneFor } from '@/components/ui';
import type { Api } from '@/lib/api';
import { nftName, posesAsNoid, tokenName, usePicture, type Nft, type Token } from '@/lib/assets';
import { formatUnits, nftKey, shortId } from '@/lib/tokenMath';
import { go } from '@/lib/nav';
import { colors, fonts, radius, space } from '@/theme';

export function TokenIcon({ api, token, size = 40 }: { api: Api; token: Token; size?: number }) {
  const uri = usePicture(api, token.manifest?.image);
  if (uri) {
    return (
      <Image
        source={{ uri }}
        resizeMethod="resize"
        accessibilityIgnoresInvertColors
        style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: colors.s2 }}
      />
    );
  }
  const label = token.manifest?.symbol ?? tokenName(token);
  return <Avatar initials={initialsOf(label)} tone={toneFor(token.assetId)} size={size} />;
}

export function TokenRow({ api, token, hidden }: { api: Api; token: Token; hidden?: boolean }) {
  const symbol = token.manifest?.symbol;
  return (
    <ListRow
      leading={<TokenIcon api={api} token={token} />}
      title={tokenName(token)}
      subtitle={`${posesAsNoid(token) ? 'Not the NOID coin · ' : ''}${symbol ? `${symbol} · ` : ''}${shortId(token.assetId)}`}
      value={hidden ? '••••' : formatUnits(token.units, { maxDecimals: 4 })}
      valueSub={symbol && !hidden ? symbol : null}
      onPress={() => go({ pathname: '/token/[id]', params: { id: token.assetId } })}
      chevron
    />
  );
}

export function NftTile({ api, nft, size }: { api: Api; nft: Nft; size: number }) {
  const uri = usePicture(api, nft.manifest?.image);
  const name = nftName(nft);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={name}
      onPress={() => go({ pathname: '/nft/[id]', params: { id: nftKey(nft.collection, nft.serial) } })}
      style={({ pressed }) => ({ width: size, gap: space.xs, opacity: pressed ? 0.7 : 1 })}
    >
      <View
        style={{
          width: size,
          height: size,
          borderRadius: radius.md,
          overflow: 'hidden',
          backgroundColor: colors.s1,
          borderWidth: 1,
          borderColor: colors.line,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {uri ? (
          <Image source={{ uri }} resizeMethod="resize" resizeMode="cover" accessibilityIgnoresInvertColors style={{ width: size, height: size }} />
        ) : (
          <Text style={{ color: colors.faint, fontFamily: fonts.monoBold, fontSize: 13 }}>#{nft.serial}</Text>
        )}
      </View>
      <Text numberOfLines={1} style={{ color: colors.textSecondary, fontFamily: fonts.ui, fontSize: 13 }}>
        {name}
      </Text>
    </Pressable>
  );
}
