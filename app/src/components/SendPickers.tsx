// Shared by the NOID and token/NFT send screens: the "what to send" row and
// the strip of people you paid or saved.
import { Pressable, ScrollView, Text, View } from 'react-native';

import { Icon } from '@/components/Icon';
import { LogoMark } from '@/components/Logo';
import { Avatar, initialsOf, toneFor } from '@/components/ui';
import { shortAddress } from '@/lib/amount';
import { colors, fonts, radius, space, type } from '@/theme';

/** Contacts first, then addresses you sent to before (at most 8). */
export function recentRecipients(contacts: { name: string; address: string }[], sentTo: string[]): { address: string; name: string }[] {
  return [
    ...contacts.map((c) => ({ address: c.address, name: c.name })),
    ...sentTo.filter((a) => !contacts.some((c) => c.address === a)).map((a) => ({ address: a, name: shortAddress(a, 4) })),
  ].slice(0, 8);
}

export function RecentRecipients({ recents, onPick }: { recents: { address: string; name: string }[]; onPick: (address: string) => void }) {
  if (recents.length === 0) return null;
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0 }} contentContainerStyle={{ gap: space.sm, alignItems: 'center' }}>
      {recents.map((r) => (
        <Pressable
          key={r.address}
          accessibilityRole="button"
          accessibilityLabel={`Send to ${r.name}`}
          onPress={() => onPick(r.address)}
          style={({ pressed }) => ({
            flexDirection: 'row',
            alignItems: 'center',
            gap: space.sm,
            backgroundColor: pressed ? colors.s3 : colors.s2,
            borderRadius: radius.pill,
            paddingLeft: 6,
            paddingRight: space.md,
            paddingVertical: 6,
          })}
        >
          <Avatar initials={initialsOf(r.name)} tone={toneFor(r.name)} size={28} />
          <Text style={{ color: colors.text, fontFamily: fonts.uiSemi }} numberOfLines={1}>
            {r.name}
          </Text>
        </Pressable>
      ))}
    </ScrollView>
  );
}

/** "Sending: NOID ›": tap to choose NOID, a token or an NFT. */
export function AssetSelector({ leading, title, subtitle, onPress }: { leading: React.ReactNode; title: string; subtitle?: string; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Sending ${title}. Change what to send`}
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: space.md,
        padding: space.md,
        borderRadius: radius.lg,
        borderWidth: 1,
        borderColor: colors.line,
        backgroundColor: pressed ? colors.s2 : colors.s1,
      })}
    >
      {leading}
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={type.caption}>Sending</Text>
        <Text style={[type.title, { fontSize: 16 }]} numberOfLines={1}>
          {title}
        </Text>
        {subtitle ? (
          <Text style={[type.bodySm, { fontSize: 13 }]} numberOfLines={1}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      <Text style={{ color: colors.accent, fontFamily: fonts.uiSemi }}>Change</Text>
      <Icon name="chevron" size={18} color={colors.faint} />
    </Pressable>
  );
}

/** The NOID coin's mark in lists. */
export function NoidMark({ size = 40 }: { size?: number }) {
  return (
    <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: colors.accentTint, alignItems: 'center', justifyContent: 'center' }}>
      <LogoMark size={size * 0.7} glow={false} />
    </View>
  );
}
