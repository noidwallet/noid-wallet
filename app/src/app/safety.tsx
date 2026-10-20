import { useCallback, useState } from 'react';
import { Linking, Text, View } from 'react-native';
import Constants from 'expo-constants';
import { router, useLocalSearchParams, type Href } from 'expo-router';

import { Icon, type IconName } from '@/components/Icon';
import { Avatar, Button, ListRow, Screen } from '@/components/ui';
import { LINK_BASE } from '@/lib/config';
import { goBack, useHardwareBack } from '@/lib/nav';
import { useWallet } from '@/state/wallet';
import { colors, space, type } from '@/theme';

const SLIDES: { icon: IconName; tone: 'warn' | 'danger' | 'info'; title: string; body: string }[] = [
  {
    icon: 'key',
    tone: 'warn',
    title: 'Your secret is your money',
    body:
      'Anyone with your 64-character secret can take all your NOID. NOID will never ask for it: not in a chat, a call, a form or a website. Only ever type it into NOID’s own Restore screen.',
  },
  {
    icon: 'shield',
    tone: 'danger',
    title: 'Nobody from NOID will message you',
    body:
      'There are no NOID support agents, “recovery experts” or “wallet upgrades”. Anyone who messages you first offering help is trying to steal from you, even if they use the NOID name or logo.',
  },
  {
    icon: 'warning',
    tone: 'info',
    title: 'Screenshots aren’t proof',
    body:
      'A payment screenshot or a credit “alert” can be faked in seconds. Only trust a payment once it shows in your own NOID Activity, then hand over the goods.',
  },
];

/** Official places to find NOID. Extra links (X, Telegram…) come from app.json `extra.officialLinks`. */
function officialLinks(): { label: string; url: string }[] {
  const extra = Constants.expoConfig?.extra?.officialLinks as { label?: string; url?: string }[] | undefined;
  const fromConfig = (extra ?? []).filter((l): l is { label: string; url: string } => !!l?.label && /^https:\/\//.test(l?.url ?? ''));
  return fromConfig.length ? fromConfig : [{ label: 'Website', url: LINK_BASE }];
}

/** Where the first-run flow may continue to after the safety slides. */
const NEXT: Record<string, Href> = { create: '/create', restore: '/restore', photo: '/photo' };

/**
 * Three short safety slides, shown once before creating or restoring a wallet,
 * and any time from Settings → Stay safe.
 */
export default function Safety() {
  const { next } = useLocalSearchParams<{ next?: string }>();
  const w = useWallet();
  const [step, setStep] = useState(0);
  const slide = SLIDES[step]!;
  const last = step === SLIDES.length - 1;
  const firstRun = !!next && next in NEXT;

  useHardwareBack(
    useCallback(() => {
      if (step === 0) return false;
      setStep((s) => s - 1);
      return true;
    }, [step]),
  );

  async function finish() {
    await w.updateSettings({ safetySeen: true });
    if (firstRun) router.replace(NEXT[next!]!);
    else goBack('/settings');
  }

  return (
    <Screen
      header={{ title: 'Stay safe', back: step > 0 ? () => setStep(step - 1) : true }}
      footer={
        <>
          <Button title={last ? (firstRun ? 'I understand, continue' : 'Done') : 'Next'} onPress={last ? finish : () => setStep(step + 1)} />
          {!last ? <Button title="Skip" kind="tertiary" onPress={() => setStep(SLIDES.length - 1)} /> : null}
        </>
      }
    >
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', gap: space.xl, paddingVertical: space.xl }}>
        <Avatar icon={slide.icon} tone={slide.tone} size={88} />
        <Text style={[type.h1, { textAlign: 'center', alignSelf: 'stretch' }]} accessibilityRole="header">
          {slide.title}
        </Text>
        <Text style={[type.body, { textAlign: 'center', color: colors.textSecondary }]}>{slide.body}</Text>
        <View style={{ flexDirection: 'row', gap: space.sm }} accessibilityLabel={`Step ${step + 1} of ${SLIDES.length}`}>
          {SLIDES.map((s, i) => (
            <View
              key={s.title}
              style={{ width: i === step ? 22 : 8, height: 8, borderRadius: 4, backgroundColor: i === step ? colors.accent : colors.lineStrong }}
            />
          ))}
        </View>
      </View>
      {last ? (
        <View style={{ gap: space.xs }}>
          <Text style={[type.caption, { paddingHorizontal: space.xs }]}>Official links</Text>
          {officialLinks().map((l) => (
            <ListRow
              key={l.url}
              leading={<Avatar icon="link" tone="success" />}
              title={l.label}
              subtitle={l.url.replace(/^https:\/\//, '')}
              trailing={<Icon name="chevron" size={18} color={colors.faint} />}
              onPress={() => void Linking.openURL(l.url)}
            />
          ))}
          <Text style={[type.bodySm, { paddingHorizontal: space.xs }]}>Anything else using the NOID name isn’t us.</Text>
        </View>
      ) : null}
    </Screen>
  );
}
