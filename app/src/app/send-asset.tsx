// Choose what to send: NOID, a token or an NFT. Hands the choice back to the
// send screen (lib/scan.ts assetPick), which switches form if needed.
import { Text, View } from 'react-native';

import { NoidMark } from '@/components/SendPickers';
import { TokenIcon } from '@/components/AssetRows';
import { Avatar, Banner, Card, ListRow, Screen } from '@/components/ui';
import { formatNoid } from '@/lib/amount';
import { nftName, posesAsNoid, shownAssets, tokenName, useAssets } from '@/lib/assets';
import { goBack } from '@/lib/nav';
import { assetPick } from '@/lib/scan';
import { formatUnits, nftKey, shortId } from '@/lib/tokenMath';
import { useWallet } from '@/state/wallet';
import { type } from '@/theme';

export default function SendAsset() {
  const w = useWallet();
  const shown = shownAssets(useAssets(), w.meta?.address);
  const hidden = !!w.settings.hideBalance;
  const supported = !!w.status?.features?.nativeSend;
  const pick = (v: string) => {
    assetPick.set(v);
    goBack('/send');
  };
  const tokens = shown?.tokens ?? [];
  const nfts = shown?.nfts ?? [];

  return (
    <Screen header={{ title: 'What to send' }}>
      <Card style={{ padding: 0 }}>
        <ListRow
          leading={<NoidMark />}
          title="NOID"
          subtitle="The Parano1d coin"
          value={hidden ? '••••' : formatNoid(w.balance ?? 0, { maxDecimals: 4 })}
          onPress={() => pick('noid')}
          chevron
        />
      </Card>
      {!supported ? (
        <Banner tone="neutral">Your wallet server can’t prepare token and NFT transfers yet, so only NOID can be sent.</Banner>
      ) : (
        <>
          {tokens.length > 0 ? (
            <View style={{ gap: 8 }}>
              <Text style={type.caption}>Tokens</Text>
              <Card style={{ padding: 0 }}>
                {tokens.map((t) => (
                  <ListRow
                    key={t.assetId}
                    leading={<TokenIcon api={w.api} token={t} />}
                    title={tokenName(t)}
                    subtitle={`${posesAsNoid(t) ? 'Not the NOID coin · ' : ''}${t.manifest?.symbol ? `${t.manifest.symbol} · ` : ''}${shortId(t.assetId)}`}
                    value={hidden ? '••••' : formatUnits(t.units, { maxDecimals: 4 })}
                    onPress={() => pick(`token:${t.assetId}`)}
                    chevron
                  />
                ))}
              </Card>
            </View>
          ) : null}
          {nfts.length > 0 ? (
            <View style={{ gap: 8 }}>
              <Text style={type.caption}>NFTs</Text>
              <Card style={{ padding: 0 }}>
                {nfts.map((n) => (
                  <ListRow
                    key={nftKey(n.collection, n.serial)}
                    leading={<Avatar initials={`#${n.serial}`.slice(0, 3)} />}
                    title={nftName(n)}
                    subtitle={n.listing ? 'Listed for sale' : n.locked ? 'Locked for now' : `#${n.serial} · ${shortId(n.collection)}`}
                    onPress={() => pick(`nft:${nftKey(n.collection, n.serial)}`)}
                    chevron
                  />
                ))}
              </Card>
            </View>
          ) : null}
          {tokens.length === 0 && nfts.length === 0 ? <Banner tone="neutral">You have no tokens or NFTs at this address yet.</Banner> : null}
        </>
      )}
    </Screen>
  );
}
