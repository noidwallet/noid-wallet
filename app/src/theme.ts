// NOID design tokens. Dark, green-tinted neutrals with one mint accent.
// Surfaces step up in lightness instead of using shadows (shadows look muddy
// on near-black on Android). Amounts and addresses use a monospace face.
export const colors = {
  bg: '#060B0A',
  s1: '#0D1513',
  s2: '#131D1A',
  s3: '#1A2622',
  line: '#1C2925',
  lineStrong: '#2A3B36',
  highlight: 'rgba(255,255,255,0.06)',

  text: '#E6EFEC',
  textSecondary: '#9AABA5',
  // 4.5:1 on bg, so placeholders and small labels stay readable.
  faint: '#768882',

  accent: '#3FD1A0',
  accentPressed: '#35B98C',
  accentInk: '#04140F',
  accentTint: 'rgba(63,209,160,0.12)',
  warn: '#F2B45A',
  warnTint: 'rgba(242,180,90,0.12)',
  danger: '#FF7A6E',
  dangerTint: 'rgba(255,122,110,0.12)',
  neutralTint: 'rgba(154,171,165,0.10)',

  // Older names kept so every screen keeps working.
  surface: '#0D1513',
  surfaceRaised: '#131D1A',
  muted: '#9AABA5',
  ok: '#3FD1A0',
};

export const fonts = {
  mono: 'JetBrainsMono_500Medium',
  monoBold: 'JetBrainsMono_700Bold',
};

/** Type scale: system font for UI text, mono only for numbers and addresses. */
export const type = {
  display: { fontFamily: fonts.monoBold, fontSize: 40, lineHeight: 46, letterSpacing: -1, color: colors.text },
  h1: { fontSize: 28, lineHeight: 34, fontWeight: '700' as const, letterSpacing: -0.4, color: colors.text },
  h2: { fontSize: 20, lineHeight: 26, fontWeight: '700' as const, color: colors.text },
  title: { fontSize: 17, lineHeight: 22, fontWeight: '600' as const, color: colors.text },
  body: { fontSize: 16, lineHeight: 24, color: colors.text },
  bodySm: { fontSize: 14, lineHeight: 20, color: colors.textSecondary },
  caption: { fontSize: 12, lineHeight: 16, fontWeight: '600' as const, letterSpacing: 0.8, textTransform: 'uppercase' as const, color: colors.textSecondary },
  mono: { fontFamily: fonts.mono, fontSize: 15, lineHeight: 22, color: colors.text },
  monoSm: { fontFamily: fonts.mono, fontSize: 13, lineHeight: 18, color: colors.textSecondary },
};

export const space = { xs: 4, sm: 8, md: 12, lg: 16, gutter: 20, xl: 24, xxl: 32, xxxl: 40 };
export const radius = { sm: 10, md: 14, lg: 20, xl: 28, pill: 999 };

export type Tone = 'info' | 'success' | 'warn' | 'danger' | 'neutral';

export const tones: Record<Tone, { fg: string; bg: string }> = {
  info: { fg: colors.accent, bg: colors.accentTint },
  success: { fg: colors.accent, bg: colors.accentTint },
  warn: { fg: colors.warn, bg: colors.warnTint },
  danger: { fg: colors.danger, bg: colors.dangerTint },
  neutral: { fg: colors.textSecondary, bg: colors.neutralTint },
};
