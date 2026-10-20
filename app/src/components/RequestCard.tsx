import { forwardRef, useState } from 'react';
import { Text, View } from 'react-native';
import QRCode from 'react-native-qrcode-svg';
import Svg, { Circle, Defs, LinearGradient, RadialGradient, Rect, Stop } from 'react-native-svg';

import { LogoMark } from '@/components/Logo';
import { LINK_BASE } from '@/lib/config';
import { groupAddress } from '@/lib/safety';
import { colors, fonts, radius, space, type } from '@/theme';

const SITE = LINK_BASE.replace(/^https?:\/\//, '');

/**
 * The payment request as a branded card: what the payer sees on screen and in
 * the image shared to WhatsApp, Telegram, Discord or X. Everything on it is
 * public (address, amount, note); the QR holds the same request link.
 */
export const RequestCard = forwardRef<
  View,
  {
    link: string;
    address: string;
    amount?: string;
    value?: string | null;
    note?: string;
    onSize?: (size: { width: number; height: number }) => void;
  }
>(function RequestCard({ link, address, amount, value, note, onSize }, ref) {
  const [size, setSize] = useState({ width: 0, height: 0 });
  const grouped = groupAddress(address);
  const shortAddr = grouped.length > 26 ? `${grouped.slice(0, 14)} … ${grouped.slice(-9)}` : grouped;

  return (
    <View
      ref={ref}
      collapsable={false}
      onLayout={(e) => {
        const { width, height } = e.nativeEvent.layout;
        if (width !== size.width || height !== size.height) {
          setSize({ width, height });
          onSize?.({ width, height });
        }
      }}
      style={{
        borderRadius: radius.xl,
        overflow: 'hidden',
        borderWidth: 1,
        borderColor: colors.lineStrong,
        backgroundColor: '#0B1814',
      }}
    >
      {/* Drawn at the card's measured size so it always fills it (see the home balance card). */}
      <Svg
        key={`${size.width}x${size.height}`}
        style={{ position: 'absolute', top: 0, left: 0 }}
        width={size.width || '100%'}
        height={size.height || '100%'}
      >
        <Defs>
          <LinearGradient id="reqBg" x1="0" y1="0" x2="1" y2="1">
            <Stop offset="0" stopColor="#103027" />
            <Stop offset="0.55" stopColor="#0A1A15" />
            <Stop offset="1" stopColor="#060E0B" />
          </LinearGradient>
          <RadialGradient id="reqGlowA" cx="88%" cy="4%" r="65%">
            <Stop offset="0" stopColor={colors.accent} stopOpacity={0.28} />
            <Stop offset="1" stopColor={colors.accent} stopOpacity={0} />
          </RadialGradient>
          <RadialGradient id="reqGlowB" cx="6%" cy="100%" r="55%">
            <Stop offset="0" stopColor="#2A8CFF" stopOpacity={0.12} />
            <Stop offset="1" stopColor="#2A8CFF" stopOpacity={0} />
          </RadialGradient>
        </Defs>
        <Rect width="100%" height="100%" fill="url(#reqBg)" />
        <Rect width="100%" height="100%" fill="url(#reqGlowA)" />
        <Rect width="100%" height="100%" fill="url(#reqGlowB)" />
        {/* Faint rings behind the header, echoing the logo's vault. */}
        {size.width ? (
          <>
            <Circle cx={size.width - 34} cy={34} r={70} stroke={colors.accent} strokeOpacity={0.08} strokeWidth={1.5} fill="none" />
            <Circle cx={size.width - 34} cy={34} r={110} stroke={colors.accent} strokeOpacity={0.05} strokeWidth={1.5} fill="none" />
          </>
        ) : null}
      </Svg>

      <View style={{ padding: space.xl, gap: space.lg }}>
        {/* Header: brand + what this is */}
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
            <LogoMark size={26} glow={false} />
            <Text style={{ color: colors.accent, fontFamily: fonts.monoBold, fontSize: 16, letterSpacing: 2 }}>NOID</Text>
          </View>
          <View style={{ backgroundColor: colors.accentTint, borderRadius: radius.pill, paddingHorizontal: space.md, paddingVertical: 5 }}>
            <Text style={{ color: colors.accent, fontFamily: fonts.uiBold, fontSize: 11, letterSpacing: 1.2 }}>PAYMENT REQUEST</Text>
          </View>
        </View>

        {/* Amount */}
        <View style={{ gap: 2 }}>
          {amount ? (
            <Text adjustsFontSizeToFit numberOfLines={1} maxFontSizeMultiplier={1.3} style={type.display} accessibilityLabel={`${amount} NOID`}>
              {amount}{' '}
              <Text style={{ color: colors.accent, fontFamily: fonts.monoBold, fontSize: 18 }}>NOID</Text>
            </Text>
          ) : (
            <Text style={type.h1}>Any amount</Text>
          )}
          {value ? <Text style={[type.body, { color: colors.textSecondary }]}>{value}</Text> : null}
          {note ? (
            <Text style={[type.body, { color: colors.text, marginTop: space.xs }]} numberOfLines={3}>
              “{note}”
            </Text>
          ) : null}
        </View>

        {/* QR: the same request link, readable by NOID's scanner */}
        <View style={{ alignItems: 'center' }}>
          <View style={{ padding: 14, backgroundColor: '#fff', borderRadius: radius.lg }}>
            <QRCode value={link} size={196} backgroundColor="#fff" color="#000" ecl="M" />
          </View>
        </View>

        {/* Who gets paid, and how */}
        <View style={{ gap: 4 }}>
          <Text style={[type.caption, { color: colors.faint }]}>Pay to</Text>
          <Text style={[type.monoSm, { color: colors.textSecondary }]} numberOfLines={1}>
            {shortAddr}
          </Text>
        </View>
        <View style={{ height: 1, backgroundColor: colors.line }} />
        <Text style={[type.bodySm, { textAlign: 'center', color: colors.faint, fontSize: 12 }]}>
          Scan with the NOID wallet · {SITE}
        </Text>
      </View>
    </View>
  );
});
