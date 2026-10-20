import Svg, { Circle, Defs, Path, RadialGradient, Stop } from 'react-native-svg';

import { colors } from '@/theme';

/** Original NOID mark: a mint hexagon (a vault) with a solid core, optionally on a soft glow. */
export function LogoMark({ size = 96, glow = true, color = colors.accent }: { size?: number; glow?: boolean; color?: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 96 96">
      {glow ? (
        <>
          <Defs>
            <RadialGradient id="logoGlow" cx="50%" cy="50%" r="50%">
              <Stop offset="0" stopColor={color} stopOpacity={0.35} />
              <Stop offset="1" stopColor={color} stopOpacity={0} />
            </RadialGradient>
          </Defs>
          <Circle cx={48} cy={48} r={48} fill="url(#logoGlow)" />
        </>
      ) : null}
      <Path d="M48 20l24 14v28L48 76 24 62V34z" stroke={color} strokeWidth={glow ? 5 : 7} strokeLinejoin="round" fill="none" />
      <Circle cx={48} cy={48} r={glow ? 8 : 10} fill={color} />
    </Svg>
  );
}
