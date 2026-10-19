import { Text, View } from 'react-native';
import { colors, fonts, radius, space } from '@/theme';

/** Shows the 64-character secret in 8 numbered groups so it is easy to copy by hand. */
export function SecretView({ secretHex }: { secretHex: string }) {
  const groups = secretHex.match(/.{1,8}/g) ?? [];
  return (
    <View
      style={{
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: space.sm,
        backgroundColor: colors.surface,
        borderColor: colors.line,
        borderWidth: 1,
        borderRadius: radius.lg,
        padding: space.md,
      }}
    >
      {groups.map((g, i) => (
        <View key={i} style={{ width: '47%', flexDirection: 'row', gap: space.sm, alignItems: 'baseline' }}>
          <Text style={{ color: colors.faint, fontFamily: fonts.mono, fontSize: 12, width: 18 }}>{i + 1}</Text>
          <Text selectable={false} style={{ color: colors.text, fontFamily: fonts.monoBold, fontSize: 18, letterSpacing: 1 }}>
            {g}
          </Text>
        </View>
      ))}
    </View>
  );
}
