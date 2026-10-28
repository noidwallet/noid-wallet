import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import { useLocalSearchParams } from 'expo-router';
import { Text, View } from 'react-native';

import { TokenIcon } from '@/components/AssetRows';
import { Banner, Card, IconButton, KeyValue, Link, Pill, Screen, toast } from '@/components/ui';
import { formatNoid, shortAddress } from '@/lib/amount';
import { posesAsNoid, shownAssets, tokenName, useAssets } from '@/lib/assets';
import { useCopied } from '@/lib/clip';
import { openProjectWebsite, websiteHost } from '@/lib/openWebsite';
import { formatUnits, noidValue, unitPrice } from '@/lib/tokenMath';
import { useWallet } from '@/state/wallet';
import { colors, fonts, space, type } from '@/theme';

export default function TokenDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { api, settings, meta } = useWallet();
  const copied = useCopied();
  const shown = shownAssets(useAssets(), meta?.address);
  const token = shown?.tokens.find((t) => t.assetId === id);
  const hidden = !!settings.hideBalance;

  if (!token) {
    return (
      <Screen header={{ title: 'Token' }}>
        <Banner tone="neutral">This token is no longer at your address.</Banner>
      </Screen>
    );
  }

  const m = token.manifest;
  const info = token.info?.known ? token.info : null;
  const worth = info ? noidValue(token.units, info.priceNumerator, info.priceDenominator) : null;
  const price = info ? unitPrice(info.priceNumerator, info.priceDenominator) : null;
  const locked = BigInt(token.lockedUnits);
  const reserved = BigInt(token.reservedUnits);
  const symbol = m?.symbol ?? '';

  return (
    <Screen header={{ title: m?.symbol ?? 'Token' }}>
      <View style={{ alignItems: 'center', gap: space.sm, paddingVertical: space.md }}>
        <TokenIcon api={api} token={token} size={64} />
        <Text style={[type.title, { textAlign: 'center' }]}>{tokenName(token)}</Text>
        <Text adjustsFontSizeToFit numberOfLines={1} maxFontSizeMultiplier={1.3} style={type.display}>
          {hidden ? '••••••' : formatUnits(token.units)}
        </Text>
        {symbol ? <Text style={{ color: colors.accent, fontFamily: fonts.monoBold }}>{symbol}</Text> : null}
        {worth !== null && !hidden ? (
          <Text style={[type.bodySm, { textAlign: 'center' }]}>
            About {formatNoid(worth, { maxDecimals: 4 })} NOID at the {info?.phase === 'dex' ? 'DEX' : 'launchpad'} price your wallet server reports
          </Text>
        ) : null}
        {posesAsNoid(token) ? <Pill text="Not the NOID coin" tone="danger" /> : null}
        {locked > 0n ? <Pill text={hidden ? 'Some locked for now' : `${formatUnits(locked)} locked for now`} tone="warn" /> : null}
        {reserved > 0n ? <Pill text={hidden ? 'Some in a pending transaction' : `${formatUnits(reserved)} in a pending transaction`} tone="warn" /> : null}
      </View>

      <Banner tone="neutral">
        Sending this token from NOID is coming in an update. It’s safe at your address, and you can use it now in the official Parano1d wallet by
        restoring your NOID secret there.
      </Banner>

      {m?.description || m?.website ? (
        <Card>
          {m.description ? <Text style={type.body}>{m.description}</Text> : null}
          {m.website && websiteHost(m.website) ? (
            <Link title={`Website: ${websiteHost(m.website)}`} onPress={() => openProjectWebsite(m.website!)} />
          ) : null}
        </Card>
      ) : null}

      <Card>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
          <Text style={type.caption}>Token ID</Text>
          <IconButton
            icon={copied.isCopied('id') ? 'check' : 'copy'}
            label={copied.isCopied('id') ? 'Token ID copied' : 'Copy token ID'}
            size={36}
            onPress={async () => {
              copied.mark('id');
              await Clipboard.setStringAsync(token.assetId);
              void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
              toast('Token ID copied');
            }}
          />
        </View>
        <Text selectable style={[type.monoSm, { lineHeight: 20 }]}>
          {token.assetId}
        </Text>
      </Card>

      {info ? (
        <Card>
          <KeyValue label="Market" value={info.phase === 'dex' ? 'DEX' : 'Launchpad'} mono={false} />
          {price ? <KeyValue label="Price" value={`${price} NOID`} /> : null}
          <KeyValue label="Supply" value={formatUnits(info.outstanding, { maxDecimals: 0 })} />
          <KeyValue label="Created by" value={shortAddress(info.issuer, 8)} />
          {token.issuedHere ? <KeyValue label="Creator" value="You" mono={false} /> : null}
        </Card>
      ) : null}

      <Banner tone="warn">
        Anyone can create a token with any name, ticker or picture. Only the token ID tells two tokens apart.
      </Banner>
    </Screen>
  );
}
