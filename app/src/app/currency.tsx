import { useState } from 'react';
import { Text, View } from 'react-native';

import { Icon } from '@/components/Icon';
import { Avatar, Body, Field, ListRow, Screen } from '@/components/ui';
import { CURRENCIES, POPULAR, perNoid, type CurrencyInfo } from '@/lib/currencies';
import { goBack } from '@/lib/nav';
import { useWallet } from '@/state/wallet';
import { colors, space, type } from '@/theme';

/** Pick the currency NOID shows values in (or none). */
export default function CurrencyPicker() {
  const w = useWallet();
  const [query, setQuery] = useState('');
  const current = (w.settings.currency ?? 'none').toUpperCase();

  async function choose(code: string) {
    await w.updateSettings({ currency: code === 'NONE' ? 'none' : code.toLowerCase() });
    goBack('/settings');
  }

  const q = query.trim().toLowerCase();
  const matches = (c: CurrencyInfo) => !q || c.code.toLowerCase().includes(q) || c.name.toLowerCase().includes(q);
  const popular = CURRENCIES.filter((c) => POPULAR.includes(c.code) && matches(c));
  const rest = CURRENCIES.filter((c) => !POPULAR.includes(c.code) && matches(c)).sort((a, b) => a.name.localeCompare(b.name));

  // Rates come with the price; a currency without one shows no value yet.
  const missing = (c: CurrencyInfo) => !!w.price && perNoid(w.price, c.code) === null;

  const row = (c: CurrencyInfo) => (
    <ListRow
      key={c.code}
      leading={<Avatar initials={c.symbol.trim().slice(0, 3)} tone={current === c.code ? 'success' : 'neutral'} />}
      title={c.name}
      subtitle={missing(c) ? `${c.code} · no rate from your server yet` : c.code}
      onPress={() => void choose(c.code)}
      accessibilityLabel={`${c.name}${current === c.code ? ', selected' : ''}`}
      trailing={current === c.code ? <Icon name="check" size={20} color={colors.accent} /> : undefined}
    />
  );

  return (
    <Screen scroll header={{ title: 'Show values in' }}>
      <Body muted>NOID always moves as NOID. This only changes the value shown next to amounts, at today’s price.</Body>
      <Field
        label="Search"
        value={query}
        onChangeText={setQuery}
        placeholder="Naira, euro, KES…"
        autoCapitalize="none"
        autoCorrect={false}
      />
      {!q ? (
        <ListRow
          leading={<Avatar icon="close" tone={current === 'NONE' ? 'success' : 'neutral'} />}
          title="NOID only"
          subtitle="Don’t show a currency value"
          onPress={() => void choose('NONE')}
          trailing={current === 'NONE' ? <Icon name="check" size={20} color={colors.accent} /> : undefined}
        />
      ) : null}
      {popular.length ? (
        <View>
          <Text style={[type.caption, { paddingHorizontal: space.xs, paddingBottom: space.xs }]}>Popular</Text>
          {popular.map(row)}
        </View>
      ) : null}
      {rest.length ? (
        <View>
          <Text style={[type.caption, { paddingHorizontal: space.xs, paddingBottom: space.xs }]}>All currencies</Text>
          {rest.map(row)}
        </View>
      ) : null}
      {!popular.length && !rest.length ? <Body muted>No currency matches “{query.trim()}”.</Body> : null}
    </Screen>
  );
}
