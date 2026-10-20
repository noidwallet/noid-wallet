import { useRef, useState, type ReactNode } from 'react';
import {
  ActivityIndicator,
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

import { colors, fonts, radius, space } from '@/theme';

export function Screen({ children, scroll = true, style }: { children: ReactNode; scroll?: boolean; style?: ViewStyle }) {
  const inner = <View style={[styles.inner, style]}>{children}</View>;
  return (
    <SafeAreaView style={styles.screen} edges={['top', 'bottom']}>
      {scroll ? (
        <ScrollView contentContainerStyle={{ flexGrow: 1 }} keyboardShouldPersistTaps="handled">
          {inner}
        </ScrollView>
      ) : (
        inner
      )}
    </SafeAreaView>
  );
}

export function Title({ children, style }: { children: ReactNode; style?: TextStyle }) {
  return <Text style={[styles.title, style]}>{children}</Text>;
}

export function Body({ children, muted, style }: { children: ReactNode; muted?: boolean; style?: TextStyle }) {
  return <Text style={[styles.body, muted && { color: colors.muted }, style]}>{children}</Text>;
}

export function Label({ children }: { children: ReactNode }) {
  return <Text style={styles.label}>{children}</Text>;
}

export function Mono({ children, style, selectable }: { children: ReactNode; style?: TextStyle; selectable?: boolean }) {
  return (
    <Text selectable={selectable} style={[styles.mono, style]}>
      {children}
    </Text>
  );
}

type ButtonKind = 'primary' | 'secondary' | 'danger' | 'ghost';

export function Button({
  title,
  onPress,
  kind = 'primary',
  disabled,
  busy,
}: {
  title: string;
  /** May return a promise: the button then ignores taps and shows a spinner until it settles. */
  onPress: () => void | Promise<unknown>;
  kind?: ButtonKind;
  disabled?: boolean;
  busy?: boolean;
}) {
  const palette: Record<ButtonKind, { bg: string; fg: string; border: string }> = {
    primary: { bg: colors.accent, fg: colors.accentInk, border: colors.accent },
    secondary: { bg: colors.surfaceRaised, fg: colors.text, border: colors.line },
    danger: { bg: 'transparent', fg: colors.danger, border: colors.danger },
    ghost: { bg: 'transparent', fg: colors.muted, border: 'transparent' },
  };
  const [running, setRunning] = useState(false);
  const inFlight = useRef(false);
  const p = palette[kind];
  const spinning = !!busy || running;
  const off = !!disabled || spinning;

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
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityState={{ disabled: off, busy: spinning }}
      onPress={handlePress}
      disabled={off}
      style={({ pressed }) => [
        styles.button,
        { backgroundColor: p.bg, borderColor: p.border, opacity: disabled ? 0.45 : pressed ? 0.8 : 1 },
      ]}
    >
      {spinning ? <ActivityIndicator color={p.fg} /> : <Text style={[styles.buttonText, { color: p.fg }]}>{title}</Text>}
    </Pressable>
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
      <Text style={{ color: colors.accent, fontSize: 15, fontWeight: '600' }}>{title}</Text>
    </Pressable>
  );
}

/** A notice the user can tap to act on (fix a server, back up a secret). */
export function ActionNotice({ children, tone, onPress }: { children: ReactNode; tone?: 'info' | 'warn' | 'danger'; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}>
      <Notice tone={tone}>{children}</Notice>
    </Pressable>
  );
}

export function Card({ children, style }: { children: ReactNode; style?: ViewStyle }) {
  return <View style={[styles.card, style]}>{children}</View>;
}

export function Field(props: TextInputProps & { label?: string; error?: string | null; mono?: boolean }) {
  const { label, error, mono, style, ...rest } = props;
  return (
    <View style={{ gap: space.xs }}>
      {label ? <Label>{label}</Label> : null}
      <TextInput
        placeholderTextColor={colors.faint}
        autoCorrect={false}
        autoCapitalize="none"
        {...rest}
        style={[styles.input, mono && { fontFamily: fonts.mono, fontSize: 14 }, error ? { borderColor: colors.danger } : null, style]}
      />
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </View>
  );
}

export function Notice({ children, tone = 'info' }: { children: ReactNode; tone?: 'info' | 'warn' | 'danger' }) {
  const color = tone === 'warn' ? colors.warn : tone === 'danger' ? colors.danger : colors.muted;
  return (
    <View style={[styles.notice, { borderColor: color }]}>
      <Text style={[styles.body, { color, fontSize: 14 }]}>{children}</Text>
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

export const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  inner: { flex: 1, paddingHorizontal: space.lg, paddingVertical: space.lg, gap: space.lg },
  title: { color: colors.text, fontSize: 26, fontWeight: '700', letterSpacing: -0.3 },
  body: { color: colors.text, fontSize: 16, lineHeight: 23 },
  label: { color: colors.muted, fontSize: 12, fontWeight: '600', letterSpacing: 0.8, textTransform: 'uppercase' },
  mono: { color: colors.text, fontFamily: fonts.mono, fontSize: 14 },
  button: {
    minHeight: 52,
    borderRadius: radius.md,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: space.lg,
  },
  buttonText: { fontSize: 16, fontWeight: '700' },
  card: { backgroundColor: colors.surface, borderColor: colors.line, borderWidth: 1, borderRadius: radius.lg, padding: space.lg, gap: space.md },
  input: {
    backgroundColor: colors.surface,
    borderColor: colors.line,
    borderWidth: 1,
    borderRadius: radius.md,
    color: colors.text,
    fontSize: 17,
    paddingHorizontal: space.md,
    paddingVertical: 14,
  },
  error: { color: colors.danger, fontSize: 13 },
  notice: { borderLeftWidth: 3, paddingLeft: space.md, paddingVertical: space.xs },
  kv: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: space.md, paddingVertical: 6 },
  kvLabel: { color: colors.muted, fontSize: 15 },
  kvValue: { color: colors.text, fontSize: 15, flexShrink: 1, textAlign: 'right' },
});
