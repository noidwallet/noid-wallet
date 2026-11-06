import { Image, Pressable, Text, View } from 'react-native';

import { Avatar, ListRow, initialsOf, toneFor } from '@/components/ui';
import type { Api } from '@/lib/api';
import type { FiatOf } from '@/components/TxRow';
import { nftName, posesAsNoid, tokenName, tokenWorth, usePicture, type Nft, type Token } from '@/lib/assets';
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

/**
 * A token, laid out like the NOID row above it: amount, then its value in the
 * chosen currency (when its market gives one). The ticker is already in the
 * subtitle. No chevron, so the amounts line up; the whole row opens the token.
 */
export function TokenRow({ api, token, hidden, fiatOf }: { api: Api; token: Token; hidden?: boolean; fiatOf?: FiatOf }) {
  const symbol = token.manifest?.symbol;
  const worth = tokenWorth(token);
  return (
    <ListRow
      leading={<TokenIcon api={api} token={token} />}
      title={tokenName(token)}
      subtitle={`${posesAsNoid(token) ? 'Not the NOID coin · ' : ''}${symbol ? `${symbol} · ` : ''}${shortId(token.assetId)}`}
      value={hidden ? '••••' : formatUnits(token.units, { maxDecimals: 4 })}
      valueSub={hidden || worth === null || !fiatOf ? null : fiatOf(worth)}
      onPress={() => go({ pathname: '/token/[id]', params: { id: token.assetId } })}
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
