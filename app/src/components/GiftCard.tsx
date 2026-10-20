import { useWindowDimensions, View } from 'react-native';
import Svg, { Circle, Defs, G, Line, LinearGradient, Path, RadialGradient, Rect, Stop, Text as SvgText } from 'react-native-svg';

import type { GiftTheme } from '@/lib/links';

// Four original card designs drawn in SVG, so they look sharp at any size and
// can be captured as an image for sharing.

const W = 340;
const H = 214;

const PALETTES: Record<GiftTheme, { from: string; to: string; ink: string; sub: string; accent: string; label: string }> = {
  vault: { from: '#0B1F1A', to: '#04100C', ink: '#E9FFF7', sub: '#8FD9C0', accent: '#3FD1A0', label: 'Vault' },
  celebrate: { from: '#2A1250', to: '#120726', ink: '#FFF6E8', sub: '#D8C2FF', accent: '#FFC94D', label: 'Celebrate' },
  thanks: { from: '#3B1D0B', to: '#1A0C04', ink: '#FFF3E6', sub: '#F5C9A0', accent: '#FF9A5C', label: 'Thank you' },
  birthday: { from: '#0E2148', to: '#07122A', ink: '#F3F7FF', sub: '#B9CCF5', accent: '#FF7AA8', label: 'Birthday' },
};

export const THEME_LABEL: Record<GiftTheme, string> = Object.fromEntries(
  Object.entries(PALETTES).map(([k, v]) => [k, v.label]),
) as Record<GiftTheme, string>;

function Art({ theme, accent, sub }: { theme: GiftTheme; accent: string; sub: string }) {
  switch (theme) {
    case 'vault':
      // Concentric dial of a vault door with tick marks.
      return (
        <G opacity={0.9}>
          <Circle cx={272} cy={74} r={58} stroke={accent} strokeOpacity={0.35} strokeWidth={2} fill="none" />
          <Circle cx={272} cy={74} r={42} stroke={accent} strokeOpacity={0.55} strokeWidth={6} fill="none" />
          <Circle cx={272} cy={74} r={14} fill={accent} fillOpacity={0.9} />
          {Array.from({ length: 24 }, (_, i) => {
            const a = (i / 24) * Math.PI * 2;
            const r1 = 60;
            const r2 = i % 3 === 0 ? 70 : 66;
            return (
              <Line
                key={i}
                x1={272 + Math.cos(a) * r1}
                y1={74 + Math.sin(a) * r1}
                x2={272 + Math.cos(a) * r2}
                y2={74 + Math.sin(a) * r2}
                stroke={accent}
                strokeOpacity={0.5}
                strokeWidth={2}
              />
            );
          })}
          <Path d="M272 60 L272 46 M272 88 L272 102 M258 74 L244 74 M286 74 L300 74" stroke="#04100C" strokeWidth={4} />
        </G>
      );
    case 'celebrate':
      // Burst of confetti pieces and sparkles.
      return (
        <G>
          {[
            [220, 30, 0], [250, 58, 30], [292, 26, 60], [312, 70, 15], [236, 96, 75], [278, 112, 40],
            [318, 120, 85], [204, 70, 50], [300, 160, 20], [256, 150, 65],
          ].map(([x, y, r], i) => (
            <Rect
              key={i}
              x={x}
              y={y}
              width={14}
              height={6}
              rx={2}
              fill={i % 3 === 0 ? accent : i % 3 === 1 ? '#7EE7C9' : '#FF8FB1'}
              transform={`rotate(${r} ${x! + 7} ${y! + 3})`}
            />
          ))}
          {[
            [270, 80, 9], [228, 132, 6], [312, 40, 6],
          ].map(([x, y, s], i) => (
            <Path
              key={`s${i}`}
              d={`M${x} ${y! - s!} L${x! + s! / 3} ${y! - s! / 3} L${x! + s!} ${y} L${x! + s! / 3} ${y! + s! / 3} L${x} ${y! + s!} L${x! - s! / 3} ${y! + s! / 3} L${x! - s!} ${y} L${x! - s! / 3} ${y! - s! / 3} Z`}
              fill={sub}
            />
          ))}
        </G>
      );
    case 'thanks':
      // Two overlapping hearts drawn as outlines.
      return (
        <G>
          <Path
            d="M268 120 C 220 86, 236 40, 268 62 C 300 40, 316 86, 268 120 Z"
            fill={accent}
            fillOpacity={0.85}
          />
          <Path
            d="M300 96 C 270 74, 280 46, 300 60 C 320 46, 330 74, 300 96 Z"
            stroke={sub}
            strokeWidth={3}
            fill="none"
          />
          <Circle cx={226} cy={46} r={4} fill={sub} />
          <Circle cx={318} cy={128} r={3} fill={sub} />
        </G>
      );
    case 'birthday':
      // Balloons on strings.
      return (
        <G>
          {[
            [246, 64, accent],
            [284, 46, '#7EE7C9'],
            [314, 76, '#FFC94D'],
          ].map(([x, y, c], i) => (
            <G key={i}>
              <Path d={`M${x} ${(y as number) + 26} Q ${(x as number) - 6} ${(y as number) + 60}, ${(x as number) + 4} ${(y as number) + 96}`} stroke={sub} strokeWidth={1.5} fill="none" />
              <Path
                d={`M${x} ${(y as number) - 24} C ${(x as number) + 22} ${(y as number) - 24}, ${(x as number) + 22} ${(y as number) + 18}, ${x} ${(y as number) + 26} C ${(x as number) - 22} ${(y as number) + 18}, ${(x as number) - 22} ${(y as number) - 24}, ${x} ${(y as number) - 24} Z`}
                fill={c as string}
              />
              <Path d={`M${(x as number) - 7} ${(y as number) - 10} Q ${(x as number) - 4} ${(y as number) - 18}, ${(x as number) + 3} ${(y as number) - 18}`} stroke="#FFFFFF" strokeOpacity={0.6} strokeWidth={3} fill="none" />
            </G>
          ))}
        </G>
      );
  }
}

export function GiftCard({
  theme,
  amount,
  from,
  width,
}: {
  theme: GiftTheme;
  /** Already formatted, e.g. "2.5" */
  amount: string;
  from?: string;
  width?: number;
}) {
  const { width: screen } = useWindowDimensions();
  const w = Math.min(width ?? screen - 32, 420);
  const p = PALETTES[theme];
  const amountSize = amount.length > 9 ? 30 : amount.length > 6 ? 36 : 42;
  return (
    <View style={{ width: w, aspectRatio: W / H, alignSelf: 'center' }}>
      <Svg width="100%" height="100%" viewBox={`0 0 ${W} ${H}`}>
        <Defs>
          <LinearGradient id={`bg-${theme}`} x1="0" y1="0" x2="1" y2="1">
            <Stop offset="0" stopColor={p.from} />
            <Stop offset="1" stopColor={p.to} />
          </LinearGradient>
          <RadialGradient id={`glow-${theme}`} cx="80%" cy="30%" r="60%">
            <Stop offset="0" stopColor={p.accent} stopOpacity={0.28} />
            <Stop offset="1" stopColor={p.accent} stopOpacity={0} />
          </RadialGradient>
        </Defs>
        <Rect x={0} y={0} width={W} height={H} rx={20} fill={`url(#bg-${theme})`} />
        <Rect x={0} y={0} width={W} height={H} rx={20} fill={`url(#glow-${theme})`} />
        <Rect x={1} y={1} width={W - 2} height={H - 2} rx={19} fill="none" stroke={p.ink} strokeOpacity={0.12} />
        <Art theme={theme} accent={p.accent} sub={p.sub} />
        <SvgText x={22} y={36} fill={p.ink} fontSize={16} fontWeight="800" letterSpacing={2}>
          NOID
        </SvgText>
        <SvgText x={22} y={54} fill={p.sub} fontSize={10} fontWeight="600" letterSpacing={2.4}>
          GIFT CARD
        </SvgText>
        <SvgText x={22} y={166} fill={p.ink} fontSize={amountSize} fontWeight="800" letterSpacing={-0.5}>
          {amount}
        </SvgText>
        <SvgText x={22} y={190} fill={p.accent} fontSize={13} fontWeight="700" letterSpacing={2}>
          NOID
        </SvgText>
        {from ? (
          <SvgText x={W - 22} y={190} fill={p.sub} fontSize={12} fontWeight="600" textAnchor="end">
            {`from ${from}`}
          </SvgText>
        ) : null}
      </Svg>
    </View>
  );
}
