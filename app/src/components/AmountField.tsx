import { useState, type ReactNode } from 'react';
import { Pressable, Text, View } from 'react-native';

import { Icon } from '@/components/Icon';
import { Field } from '@/components/ui';
import { formatNoid, parseNoid } from '@/lib/amount';
import { currencyInfo, formatMoney, moneyInputText, parseMoney, perNoid, priceIsFresh, type PriceLike } from '@/lib/currencies';
import { useNow } from '@/lib/nav';
import { colors, fonts, radius, space } from '@/theme';

const TYPE_HINT = 'Type plain digits, like 5000 or 12.50 (no thousands separators).';

/**
 * Amount input that can be typed in NOID or in the chosen currency (₦, $, €…).
 * The NOID amount (`noidText`) is always the real value: in currency mode it is
 * worked out once from a recent price as you type, then stays fixed, so the
 * amount reviewed is exactly the amount sent.
 *
 * It never switches units by itself. If the price goes missing or stale while
 * in currency mode, the field freezes with a note until the user switches back
 * to NOID. Unusable currency input is reported through `onInvalidChange`, so
 * the screen can keep its button disabled.
 */
export function AmountField({
  label,
  noidText,
  onChangeNoid,
  onInvalidChange,
  price,
  currency,
  hint,
  error,
  extraRight,
  placeholder = '0',
}: {
  label: string;
  noidText: string;
  onChangeNoid: (noidText: string) => void;
  /** True while the currency text can't be turned into an amount. */
  onInvalidChange?: (invalid: boolean) => void;
  price: PriceLike | null;
  currency: string | undefined;
  /** Shown under the field in NOID mode (e.g. "≈ ₦1,840 · Available: 3.2 NOID"). */
  hint?: string | null;
  error?: string | null;
  /** E.g. a Max button, shown before the unit switch. */
  extraRight?: ReactNode;
  placeholder?: string;
}) {
  const now = useNow(30_000);
  const info = currencyInfo(currency);
  const per = perNoid(price, currency);
  const priceOk = !!info && per !== null && priceIsFresh(price, now);
  const [mode, setMode] = useState<'noid' | 'money'>('noid');
  // What the user typed in currency, and the NOID text it produced. If the NOID
  // amount changes elsewhere (Max, a scanned request), the currency text follows it.
  const [typed, setTyped] = useState<{ text: string; noid: string } | null>(null);
  const [typedError, setTypedError] = useState<string | null>(null);
  const inMoney = mode === 'money' && !!info;

  function setInvalid(message: string | null) {
    setTypedError(message);
    onInvalidChange?.(message !== null);
  }

  const micro = parseNoid(noidText);
  const moneyText =
    typed && typed.noid === noidText ? typed.text : micro !== null && per !== null && info ? moneyInputText((micro / 1e6) * per, info) : '';

  function onChangeMoney(t: string) {
    if (!info || per === null || !priceOk) return;
    if (t.trim() === '') {
      setInvalid(null);
      setTyped({ text: t, noid: '' });
      onChangeNoid('');
      return;
    }
    const v = parseMoney(t);
    if (v === null) {
      setInvalid(TYPE_HINT);
      setTyped({ text: t, noid: noidText });
      return;
    }
    const units = Math.round((v / per) * 1e6);
    if (!Number.isSafeInteger(units)) {
      setInvalid('That amount is too large.');
      setTyped({ text: t, noid: noidText });
      return;
    }
    setInvalid(null);
    const noid = formatNoid(units).replace(/,/g, '');
    setTyped({ text: t, noid });
    onChangeNoid(noid);
  }

  function switchUnits() {
    setTyped(null);
    setInvalid(null);
    setMode(inMoney ? 'noid' : 'money');
  }

  // The switch shows while a currency is chosen; it can always go back to NOID,
  // but only offers currency entry when there is a recent price.
  const canOffer = inMoney || priceOk;
  const unitSwitch =
    info && canOffer ? (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={inMoney ? 'Type the amount in NOID' : `Type the amount in ${info.name}`}
        hitSlop={8}
        onPress={switchUnits}
        style={({ pressed }) => ({
          flexDirection: 'row',
          alignItems: 'center',
          gap: 4,
          backgroundColor: pressed ? colors.s3 : colors.s2,
          borderRadius: radius.pill,
          paddingHorizontal: space.md,
          paddingVertical: 6,
          marginRight: space.sm,
        })}
      >
        <Text style={{ color: colors.text, fontFamily: fonts.uiBold }}>{inMoney ? info.code : 'NOID'}</Text>
        <Icon name="swap" size={14} color={colors.textSecondary} />
      </Pressable>
    ) : (
      <Text style={{ color: colors.textSecondary, fontFamily: fonts.uiBold, marginRight: space.md }}>NOID</Text>
    );

  const right = (
    <View style={{ flexDirection: 'row', alignItems: 'center' }}>
      {extraRight}
      {unitSwitch}
    </View>
  );

  if (inMoney && info) {
    const frozen = !priceOk;
    const shownNoid = frozen
      ? price?.typingOk === false
        ? 'The price moved sharply, so it can’t be trusted for typing amounts yet. Switch to NOID to type the amount.'
        : 'Can’t get a current price right now. Switch to NOID to type the amount.'
      : micro !== null && micro > 0
        ? `= ${formatNoid(micro)} NOID at today’s price`
        : 'The NOID amount is worked out at today’s price';
    return (
      <Field
        label={`${label} (${info.code})`}
        big
        value={moneyText}
        onChangeText={onChangeMoney}
        editable={!frozen}
        keyboardType="decimal-pad"
        placeholder={formatMoney(0, info).replace(/0(\.00)?$/, '0')}
        error={typedError ?? error ?? (frozen ? shownNoid : null)}
        hint={shownNoid}
        right={right}
      />
    );
  }
  return (
    <Field
      label={label}
      big
      value={noidText}
      onChangeText={onChangeNoid}
      keyboardType="decimal-pad"
      placeholder={placeholder}
      error={error ?? null}
      hint={hint}
      right={right}
    />
  );
}
