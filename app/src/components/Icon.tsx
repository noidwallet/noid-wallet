import Svg, { Circle, Path, Rect } from 'react-native-svg';

import { colors } from '@/theme';

// A small, original line-icon set drawn on a 24x24 grid (2px strokes, round
// caps), so the app needs no icon font and every icon matches.

export type IconName =
  | 'back'
  | 'close'
  | 'send'
  | 'receive'
  | 'gift'
  | 'request'
  | 'contacts'
  | 'settings'
  | 'copy'
  | 'scan'
  | 'check'
  | 'chevron'
  | 'share'
  | 'clock'
  | 'shield'
  | 'merge'
  | 'mined'
  | 'paste'
  | 'plus'
  | 'warning'
  | 'server'
  | 'bell'
  | 'key'
  | 'image'
  | 'torch'
  | 'eye'
  | 'eyeOff';

const PATHS: Record<IconName, (c: string) => React.ReactNode> = {
  back: (c) => <Path d="M15 5l-7 7 7 7" stroke={c} />,
  close: (c) => <Path d="M6 6l12 12M18 6L6 18" stroke={c} />,
  send: (c) => <Path d="M7 17L17 7M9 7h8v8" stroke={c} />,
  receive: (c) => <Path d="M17 7L7 17M15 17H7V9" stroke={c} />,
  gift: (c) => (
    <>
      <Rect x={4} y={10} width={16} height={10} rx={2} stroke={c} />
      <Path d="M3 10h18M12 10v10M12 10c-1.5-3-5-4-5.5-1.5S9 10 12 10zM12 10c1.5-3 5-4 5.5-1.5S15 10 12 10z" stroke={c} />
    </>
  ),
  request: (c) => (
    <>
      <Rect x={4} y={4} width={7} height={7} rx={1.5} stroke={c} />
      <Rect x={13} y={4} width={7} height={7} rx={1.5} stroke={c} />
      <Rect x={4} y={13} width={7} height={7} rx={1.5} stroke={c} />
      <Path d="M14 14h2v2M20 14v6h-6M17 19h.01" stroke={c} />
    </>
  ),
  contacts: (c) => (
    <>
      <Circle cx={9} cy={8} r={3.5} stroke={c} />
      <Path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6M16 4.5a3.5 3.5 0 010 7M21 20c0-2.6-1.6-4.8-4-5.6" stroke={c} />
    </>
  ),
  settings: (c) => (
    <>
      <Circle cx={12} cy={12} r={3} stroke={c} />
      <Path
        d="M12 2.5v3M12 18.5v3M21.5 12h-3M5.5 12h-3M18.7 5.3l-2.1 2.1M7.4 16.6l-2.1 2.1M18.7 18.7l-2.1-2.1M7.4 7.4L5.3 5.3"
        stroke={c}
      />
    </>
  ),
  copy: (c) => (
    <>
      <Rect x={8} y={8} width={12} height={12} rx={2} stroke={c} />
      <Path d="M16 8V6a2 2 0 00-2-2H6a2 2 0 00-2 2v8a2 2 0 002 2h2" stroke={c} />
    </>
  ),
  scan: (c) => <Path d="M4 8V5a1 1 0 011-1h3M16 4h3a1 1 0 011 1v3M20 16v3a1 1 0 01-1 1h-3M8 20H5a1 1 0 01-1-1v-3M4 12h16" stroke={c} />,
  check: (c) => <Path d="M5 12.5l4.5 4.5L19 7.5" stroke={c} />,
  chevron: (c) => <Path d="M9 5l7 7-7 7" stroke={c} />,
  share: (c) => <Path d="M12 15V4M8 8l4-4 4 4M5 13v5a2 2 0 002 2h10a2 2 0 002-2v-5" stroke={c} />,
  clock: (c) => (
    <>
      <Circle cx={12} cy={12} r={8.5} stroke={c} />
      <Path d="M12 7.5V12l3 2" stroke={c} />
    </>
  ),
  shield: (c) => <Path d="M12 3l7 3v5.5c0 4.3-3 7.8-7 9.5-4-1.7-7-5.2-7-9.5V6l7-3zM9 12l2 2 4-4" stroke={c} />,
  merge: (c) => <Path d="M6 4v4a4 4 0 004 4h4a4 4 0 014 4v4M18 4v4a4 4 0 01-4 4M6 20v-4" stroke={c} />,
  mined: (c) => <Path d="M5 19l8-8M14 4l6 6-3 1-4-4 1-3zM13 11l-2-2" stroke={c} />,
  paste: (c) => (
    <>
      <Rect x={5} y={5} width={14} height={16} rx={2} stroke={c} />
      <Path d="M9 3h6v4H9zM9 12h6M9 16h4" stroke={c} />
    </>
  ),
  plus: (c) => <Path d="M12 5v14M5 12h14" stroke={c} />,
  warning: (c) => <Path d="M12 4l9 16H3L12 4zM12 10v4M12 17h.01" stroke={c} />,
  server: (c) => (
    <>
      <Rect x={4} y={4} width={16} height={7} rx={2} stroke={c} />
      <Rect x={4} y={13} width={16} height={7} rx={2} stroke={c} />
      <Path d="M8 7.5h.01M8 16.5h.01" stroke={c} />
    </>
  ),
  bell: (c) => <Path d="M6 16V11a6 6 0 1112 0v5l1.5 2h-15L6 16zM10 20.5a2 2 0 004 0" stroke={c} />,
  key: (c) => (
    <>
      <Circle cx={8} cy={14} r={4} stroke={c} />
      <Path d="M11 11l8-8M16 6l2 2M14 8l2 2" stroke={c} />
    </>
  ),
  image: (c) => (
    <>
      <Rect x={3} y={5} width={18} height={14} rx={2} stroke={c} />
      <Circle cx={9} cy={10} r={1.5} stroke={c} />
      <Path d="M21 16l-5-5-8 8" stroke={c} />
    </>
  ),
  torch: (c) => <Path d="M13 3L5 13h6l-1 8 8-10h-6l1-8z" stroke={c} />,
  eye: (c) => (
    <>
      <Path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" stroke={c} />
      <Circle cx={12} cy={12} r={3} stroke={c} />
    </>
  ),
  eyeOff: (c) => (
    <Path
      d="M4 4l16 16M10.6 6.1c.5-.1.9-.1 1.4-.1 6 0 9.5 6 9.5 6a17 17 0 01-2.6 3.4M6.6 7.6C4 9.3 2.5 12 2.5 12s3.5 6.5 9.5 6.5c1.6 0 3-.4 4.2-1M9.9 9.9a3 3 0 004.2 4.2"
      stroke={c}
    />
  ),
};

export function Icon({ name, size = 22, color = colors.text }: { name: IconName; size?: number; color?: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      {PATHS[name](color)}
    </Svg>
  );
}
