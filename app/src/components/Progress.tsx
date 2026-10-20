import { ActivityIndicator, Text, View } from 'react-native';

import { Icon } from '@/components/Icon';
import type { Stage } from '@/lib/send';
import { colors, space, type } from '@/theme';

const STEPS: { stage: Stage; label: string }[] = [
  { stage: 'preparing', label: 'Preparing' },
  { stage: 'forging', label: 'Signing your payment' },
  { stage: 'submitting', label: 'Sending to the network' },
];

const ORDER: Record<Stage, number> = { preparing: 0, retrying: 0, forging: 1, submitting: 2 };

/**
 * Three-step checklist for a send, gift or claim. Securing the payment (the
 * proof) can take up to a minute on slower phones, so progress must be visible.
 */
export function SendProgress({ stage, title }: { stage: Stage; title: string }) {
  const current = ORDER[stage];
  return (
    <View style={{ flex: 1, justifyContent: 'center', gap: space.xl }}>
      <Text style={[type.h1, { textAlign: 'center' }]}>{title}</Text>
      <View style={{ gap: space.lg, alignSelf: 'center', minWidth: 260 }}>
        {STEPS.map((s, i) => {
          const done = i < current;
          const active = i === current;
          return (
            <View key={s.stage} style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }} accessibilityLiveRegion={active ? 'polite' : 'none'}>
              <View
                style={{
                  width: 28,
                  height: 28,
                  borderRadius: 14,
                  alignItems: 'center',
                  justifyContent: 'center',
                  backgroundColor: done ? colors.accentTint : colors.s2,
                }}
              >
                {done ? (
                  <Icon name="check" size={16} color={colors.accent} />
                ) : active ? (
                  <ActivityIndicator size="small" color={colors.accent} />
                ) : null}
              </View>
              <Text style={[type.body, { color: done || active ? colors.text : colors.faint }]}>
                {s.label}
                {active && stage === 'retrying' ? ' (new block, trying again)' : ''}
              </Text>
            </View>
          );
        })}
      </View>
      <Text style={[type.bodySm, { textAlign: 'center' }]}>Keep the app open until this finishes. It can take up to a minute.</Text>
    </View>
  );
}
