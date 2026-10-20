import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import {
  AccessibilityInfo,
  ActivityIndicator,
  Animated,
  Easing,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type TextInputProps,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Icon, type IconName } from '@/components/Icon';
import { goBack } from '@/lib/nav';
import { colors, fonts, radius, space, tones, type, type Tone } from '@/theme';

// ---------------------------------------------------------------- motion

let reduceMotion = false;
void AccessibilityInfo.isReduceMotionEnabled().then((v) => (reduceMotion = v), () => {});
AccessibilityInfo.addEventListener('reduceMotionChanged', (v) => (reduceMotion = v));

/** Spring a value towards `to` (instant when the user turned motion off). */
function spring(v: Animated.Value, to: number) {
  if (reduceMotion) v.setValue(to);
  else Animated.spring(v, { toValue: to, useNativeDriver: true, speed: 40, bounciness: 4 }).start();
}

/** Pressable that shrinks slightly while pressed. */
function PressScale({
  children,
  style,
  disabled,
  onPress,
  ...a11y
}: {
  children: ReactNode;
  style?: ViewStyle | ViewStyle[];
  disabled?: boolean;
  onPress?: () => void;
  accessibilityRole?: 'button' | 'radio' | 'checkbox';
  accessibilityLabel?: string;
  accessibilityHint?: string;
  accessibilityState?: object;
  hitSlop?: number;
}) {
  const scale = useState(() => new Animated.Value(1))[0];
  return (
    <Pressable
      {...a11y}
      disabled={disabled}
      onPress={onPress}
      onPressIn={() => spring(scale, 0.97)}
      onPressOut={() => spring(scale, 1)}
    >
      <Animated.View style={[style, { transform: [{ scale }] }]}>{children}</Animated.View>
    </Pressable>
  );
}

// ---------------------------------------------------------------- layout

export interface HeaderProps {
  title?: string;
  /** Show a back arrow (default true). Pass a function to override what it does. */
  back?: boolean | (() => void);
  right?: ReactNode;
}

export function ScreenHeader({ title, back = true, right }: HeaderProps) {
  return (
    <View style={styles.header}>
      <View style={{ width: 44 }}>
        {back ? (
          <IconButton
            icon="back"
            label="Back"
            onPress={() => (typeof back === 'function' ? back() : goBack())}
          />
        ) : null}
      </View>
      <Text style={[type.title, { flex: 1, textAlign: 'center' }]} numberOfLines={1} accessibilityRole="header">
        {title ?? ''}
      </Text>
      <View style={{ width: 44, alignItems: 'flex-end' }}>{right}</View>
    </View>
  );
}

export function Screen({
  children,
  scroll = true,
  style,
  header,
  footer,
}: {
  children: ReactNode;
  scroll?: boolean;
  style?: ViewStyle;
  /** Back arrow and title at the top; replaces bottom Back/Cancel buttons. */
  header?: HeaderProps;
  /** Main action(s), kept at the bottom and above the keyboard. */
  footer?: ReactNode;
}) {
  const inner = <View style={[styles.inner, header ? { paddingTop: space.sm } : null, style]}>{children}</View>;
  return (
    <SafeAreaView style={styles.screen} edges={['top', 'bottom']}>
      {/* Keeps fields and the main button above the keyboard (Android draws edge to edge). */}
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
        {header ? <ScreenHeader {...header} /> : null}
        {scroll ? (
          <ScrollView contentContainerStyle={{ flexGrow: 1 }} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag">
            {inner}
          </ScrollView>
        ) : (
          inner
        )}
        {footer ? <View style={styles.footer}>{footer}</View> : null}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

// ---------------------------------------------------------------- text

export function Title({ children, style }: { children: ReactNode; style?: TextStyle }) {
  return (
    <Text style={[type.h1, style]} accessibilityRole="header">
      {children}
    </Text>
  );
}

export function Body({ children, muted, style }: { children: ReactNode; muted?: boolean; style?: TextStyle }) {
  return <Text style={[type.body, muted && { color: colors.textSecondary }, style]}>{children}</Text>;
}

export function Label({ children }: { children: ReactNode }) {
  return <Text style={type.caption}>{children}</Text>;
}

export function Mono({ children, style, selectable }: { children: ReactNode; style?: TextStyle; selectable?: boolean }) {
  return (
    <Text selectable={selectable} style={[type.mono, style]}>
      {children}
    </Text>
  );
}

// ---------------------------------------------------------------- buttons

type ButtonKind = 'primary' | 'secondary' | 'tertiary' | 'danger' | 'ghost';

export function Button({
  title,
  onPress,
  kind = 'primary',
  disabled,
  busy,
  icon,
}: {
  title: string;
  /** May return a promise: the button then ignores taps and shows a spinner until it settles. */
  onPress: () => void | Promise<unknown>;
  kind?: ButtonKind;
  disabled?: boolean;
  busy?: boolean;
  icon?: IconName;
}) {
  const [running, setRunning] = useState(false);
  const inFlight = useRef(false);
  const spinning = !!busy || running;
  const off = !!disabled || spinning;
  const k = kind === 'ghost' ? 'tertiary' : kind;
  const look = {
    primary: { bg: disabled ? colors.s3 : colors.accent, fg: disabled ? colors.faint : colors.accentInk },
    secondary: { bg: colors.s2, fg: disabled ? colors.faint : colors.text },
    tertiary: { bg: 'transparent', fg: disabled ? colors.faint : colors.accent },
    danger: { bg: colors.dangerTint, fg: disabled ? colors.faint : colors.danger },
  }[k];

  function handlePress() {
    // A double tap must never run an action twice (two sends, two prompts).
    if (inFlight.current || off) return;
    const result = onPress();
    if (result && typeof (result as Promise<unknown>).then === 'function') {
      inFlight.current = true;
      setRunning(true);
      (result as Promise<unknown>)
        .catch(() => {})
        .finally(() => {
          inFlight.current = false;
          setRunning(false);
        });
    }
  }

  return (
    <PressScale
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityState={{ disabled: off, busy: spinning }}
      onPress={handlePress}
      disabled={off}
      style={[styles.button, { backgroundColor: look.bg, minHeight: k === 'tertiary' ? 44 : 56 }]}
    >
      {spinning ? (
        <ActivityIndicator color={look.fg} />
      ) : (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
          {icon ? <Icon name={icon} size={20} color={look.fg} /> : null}
          <Text style={[styles.buttonText, { color: look.fg }]}>{title}</Text>
        </View>
      )}
    </PressScale>
  );
}

/** 44px round icon button (header back, settings, inline field actions). */
export function IconButton({
  icon,
  label,
  onPress,
  tone,
  size = 44,
}: {
  icon: IconName;
  label: string;
  onPress: () => void;
  tone?: 'plain' | 'filled';
  size?: number;
}) {
  return (
    <PressScale
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      hitSlop={6}
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: tone === 'filled' ? colors.s2 : 'transparent',
      }}
    >
      <Icon name={icon} size={22} color={colors.text} />
    </PressScale>
  );
}

/** Round icon with a label underneath (Home actions, Receive actions). */
export function IconAction({ icon, label, onPress, highlight }: { icon: IconName; label: string; onPress: () => void; highlight?: boolean }) {
  return (
    <PressScale accessibilityRole="button" accessibilityLabel={label} onPress={onPress} style={{ alignItems: 'center', gap: space.sm, minWidth: 64 }}>
      <View
        style={{
          width: 56,
          height: 56,
          borderRadius: 28,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: highlight ? colors.accent : colors.s2,
        }}
      >
        <Icon name={icon} size={24} color={highlight ? colors.accentInk : colors.text} />
      </View>
      <Text style={{ color: colors.text, fontSize: 13, fontFamily: fonts.uiSemi }}>{label}</Text>
    </PressScale>
  );
}

/** A text link with a comfortable tap area. */
export function Link({ title, onPress, disabled }: { title: string; onPress: () => void; disabled?: boolean }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: !!disabled }}
      onPress={disabled ? undefined : onPress}
      hitSlop={12}
      style={({ pressed }) => ({ alignSelf: 'flex-start', paddingVertical: 4, opacity: disabled ? 0.4 : pressed ? 0.6 : 1 })}
    >
      <Text style={{ color: colors.accent, fontSize: 15, fontFamily: fonts.uiSemi }}>{title}</Text>
    </Pressable>
  );
}

// ---------------------------------------------------------------- surfaces

export function Card({ children, style }: { children: ReactNode; style?: ViewStyle }) {
  return <View style={[styles.card, style]}>{children}</View>;
}

const BANNER_ICON: Record<Tone, IconName> = { info: 'shield', success: 'check', warn: 'warning', danger: 'warning', neutral: 'shield' };

/** Tinted message with an icon. Tappable when `onPress` is given. */
export function Banner({
  children,
  tone = 'neutral',
  onPress,
  icon,
}: {
  children: ReactNode;
  tone?: Tone;
  onPress?: () => void;
  icon?: IconName;
}) {
  const t = tones[tone];
  const content = (
    <View style={[styles.banner, { backgroundColor: t.bg }]} accessibilityLiveRegion={tone === 'danger' || tone === 'warn' ? 'polite' : 'none'}>
      <Icon name={icon ?? BANNER_ICON[tone]} size={18} color={t.fg} />
      <Text style={[type.bodySm, { color: tone === 'neutral' ? colors.text : t.fg, flex: 1 }]}>{children}</Text>
      {onPress ? <Icon name="chevron" size={18} color={t.fg} /> : null}
    </View>
  );
  if (!onPress) return content;
  return (
    <PressScale accessibilityRole="button" onPress={onPress}>
      {content}
    </PressScale>
  );
}

/** Older name: `info` reads as neutral guidance. */
export function Notice({ children, tone = 'info' }: { children: ReactNode; tone?: 'info' | 'warn' | 'danger' }) {
  return <Banner tone={tone === 'info' ? 'neutral' : tone}>{children}</Banner>;
}

export function ActionNotice({ children, tone, onPress }: { children: ReactNode; tone?: 'info' | 'warn' | 'danger'; onPress: () => void }) {
  return (
    <Banner tone={!tone || tone === 'info' ? 'info' : tone} onPress={onPress}>
      {children}
    </Banner>
  );
}

export function Pill({ text, tone = 'neutral' }: { text: string; tone?: Tone }) {
  const t = tones[tone];
  return (
    <View style={{ alignSelf: 'flex-start', backgroundColor: t.bg, borderRadius: radius.pill, paddingHorizontal: 10, paddingVertical: 4 }}>
      <Text style={{ color: t.fg, fontSize: 12, fontFamily: fonts.uiBold }}>{text}</Text>
    </View>
  );
}

// ---------------------------------------------------------------- inputs

export function Field(
  props: TextInputProps & {
    label?: string;
    error?: string | null;
    mono?: boolean;
    big?: boolean;
    right?: ReactNode;
    hint?: string | null;
    ref?: React.Ref<TextInput>;
  },
) {
  const { label, error, mono, big, right, hint, style, ...rest } = props;
  return (
    <View style={{ gap: space.sm }}>
      {label ? <Label>{label}</Label> : null}
      <View style={[styles.inputWrap, error ? { borderColor: colors.danger } : null]}>
        <TextInput
          accessibilityLabel={label}
          placeholderTextColor={colors.faint}
          autoCorrect={false}
          autoCapitalize="none"
          {...rest}
          style={[
            styles.input,
            mono && { fontFamily: fonts.mono, fontSize: 15 },
            big && { fontFamily: fonts.monoBold, fontSize: 32, paddingVertical: 12 },
            style,
          ]}
        />
        {right ? <View style={{ flexDirection: 'row', alignItems: 'center', paddingRight: space.xs }}>{right}</View> : null}
      </View>
      {error ? (
        <Text style={styles.error} accessibilityLiveRegion="polite">
          {error}
        </Text>
      ) : hint ? (
        <Text style={type.bodySm}>{hint}</Text>
      ) : null}
    </View>
  );
}

export function KeyValue({ label, value, mono = true }: { label: string; value: ReactNode; mono?: boolean }) {
  return (
    <View style={styles.kv}>
      <Text style={styles.kvLabel}>{label}</Text>
      {typeof value === 'string' ? <Text style={[styles.kvValue, mono && { fontFamily: fonts.mono }]}>{value}</Text> : value}
    </View>
  );
}

// ---------------------------------------------------------------- lists

export function Avatar({ icon, initials, tone = 'neutral', size = 40 }: { icon?: IconName; initials?: string; tone?: Tone; size?: number }) {
  const t = tones[tone];
  return (
    <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: t.bg, alignItems: 'center', justifyContent: 'center' }}>
      {icon ? <Icon name={icon} size={size / 2} color={t.fg} /> : <Text style={{ color: t.fg, fontFamily: fonts.uiBold, fontSize: size / 2.6 }}>{initials}</Text>}
    </View>
  );
}

export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '?') + (parts[1]?.[0] ?? '')).toUpperCase();
}

/** Stable colour for a name, so a contact always has the same avatar. */
export function toneFor(name: string): Tone {
  const all: Tone[] = ['info', 'warn', 'neutral', 'danger'];
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return all[h % all.length]!;
}

export function ListRow({
  leading,
  title,
  subtitle,
  value,
  valueColor,
  onPress,
  chevron,
  accessibilityLabel,
}: {
  leading?: ReactNode;
  title: string;
  subtitle?: string;
  value?: string;
  valueColor?: string;
  onPress?: () => void;
  chevron?: boolean;
  accessibilityLabel?: string;
}) {
  return (
    <Pressable
      accessibilityRole={onPress ? 'button' : undefined}
      accessibilityLabel={accessibilityLabel ?? [title, subtitle, value].filter(Boolean).join(', ')}
      disabled={!onPress}
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && onPress ? { backgroundColor: colors.s2 } : null]}
    >
      {leading}
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={[type.title, { fontSize: 16 }]} numberOfLines={1}>
          {title}
        </Text>
        {subtitle ? (
          <Text style={[type.bodySm, { fontSize: 13 }]} numberOfLines={1}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      {value ? <Text style={[type.mono, { color: valueColor ?? colors.text }]}>{value}</Text> : null}
      {chevron ? <Icon name="chevron" size={18} color={colors.faint} /> : null}
    </Pressable>
  );
}

export function EmptyState({ icon, title, body, action }: { icon: IconName; title: string; body: string; action?: ReactNode }) {
  return (
    <View style={{ alignItems: 'center', gap: space.md, paddingVertical: space.xxl }}>
      <Avatar icon={icon} tone="info" size={64} />
      <Text style={[type.h2, { textAlign: 'center' }]}>{title}</Text>
      <Text style={[type.bodySm, { textAlign: 'center', maxWidth: 300 }]}>{body}</Text>
      {action}
    </View>
  );
}

export function Skeleton({ width, height, style }: { width: number | `${number}%`; height: number; style?: ViewStyle }) {
  const pulse = useState(() => new Animated.Value(0.45))[0];
  useEffect(() => {
    if (reduceMotion) return;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 0.85, duration: 900, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0.45, duration: 900, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [pulse]);
  return <Animated.View style={[{ width, height, borderRadius: radius.sm, backgroundColor: colors.s2, opacity: pulse }, style]} />;
}

/** Check mark that springs in, for success screens. */
export function SuccessMark({ tone = 'success' }: { tone?: Tone }) {
  const scale = useState(() => new Animated.Value(reduceMotion ? 1 : 0.6))[0];
  useEffect(() => {
    spring(scale, 1);
  }, [scale]);
  const t = tones[tone];
  return (
    <Animated.View
      style={{ width: 72, height: 72, borderRadius: 36, backgroundColor: t.bg, alignItems: 'center', justifyContent: 'center', transform: [{ scale }] }}
    >
      <Icon name={tone === 'warn' ? 'clock' : 'check'} size={36} color={t.fg} />
    </Animated.View>
  );
}

// ---------------------------------------------------------------- toast

let toastText: string | null = null;
let toastTimer: ReturnType<typeof setTimeout> | null = null;
const toastListeners = new Set<() => void>();

/** Short confirmation at the bottom of the screen ("Address copied"). */
export function toast(text: string) {
  toastText = text;
  toastListeners.forEach((l) => l());
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastText = null;
    toastListeners.forEach((l) => l());
  }, 1800);
}

export function ToastHost() {
  const text = useSyncExternalStore(
    (l) => {
      toastListeners.add(l);
      return () => {
        toastListeners.delete(l);
      };
    },
    () => toastText,
  );
  if (!text) return null;
  return (
    <View pointerEvents="none" style={styles.toastWrap}>
      <View style={styles.toast} accessibilityLiveRegion="polite">
        <Icon name="check" size={18} color={colors.accent} />
        <Text style={{ color: colors.text, fontFamily: fonts.uiSemi }}>{text}</Text>
      </View>
    </View>
  );
}

// ---------------------------------------------------------------- styles

export const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  header: { height: 56, flexDirection: 'row', alignItems: 'center', paddingHorizontal: space.sm },
  inner: { flex: 1, paddingHorizontal: space.gutter, paddingVertical: space.lg, gap: space.lg },
  footer: { paddingHorizontal: space.gutter, paddingTop: space.sm, paddingBottom: space.md, gap: space.sm, backgroundColor: colors.bg },
  title: type.h1,
  body: type.body,
  label: type.caption,
  mono: type.mono,
  button: {
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: space.lg,
  },
  buttonText: { fontSize: 16, fontFamily: fonts.uiBold },
  card: {
    backgroundColor: colors.s1,
    borderRadius: radius.lg,
    padding: space.lg,
    gap: space.md,
    borderWidth: 1,
    borderColor: colors.line,
    borderTopColor: colors.lineStrong,
  },
  banner: { flexDirection: 'row', alignItems: 'center', gap: space.md, borderRadius: radius.md, paddingHorizontal: space.md, paddingVertical: space.md },
  inputWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.s1,
    borderColor: colors.line,
    borderWidth: 1,
    borderRadius: radius.md,
  },
  input: {
    flex: 1,
    color: colors.text,
    fontFamily: fonts.ui,
    fontSize: 17,
    paddingHorizontal: space.md,
    paddingVertical: 14,
  },
  error: { color: colors.danger, fontFamily: fonts.ui, fontSize: 13 },
  kv: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: space.md, paddingVertical: 6 },
  kvLabel: { color: colors.textSecondary, fontFamily: fonts.ui, fontSize: 15 },
  kvValue: { color: colors.text, fontFamily: fonts.ui, fontSize: 15, flexShrink: 1, textAlign: 'right' },
  row: { minHeight: 64, flexDirection: 'row', alignItems: 'center', gap: space.md, paddingVertical: space.sm, paddingHorizontal: space.xs, borderRadius: radius.md },
  toastWrap: { position: 'absolute', left: 0, right: 0, bottom: 48, alignItems: 'center' },
  toast: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    backgroundColor: colors.s3,
    borderRadius: radius.pill,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
  },
});
