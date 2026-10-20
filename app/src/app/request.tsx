import { useCallback, useState } from 'react';
import { Share, Text, View } from 'react-native';
import QRCode from 'react-native-qrcode-svg';

import { Banner, Body, Button, Field, IconAction, Screen } from '@/components/ui';
import { formatNoid, parseNoid } from '@/lib/amount';
import { copyText } from '@/lib/clip';
import { LINK_BASE } from '@/lib/config';
import { MAX_NOTE, payLink } from '@/lib/links';
import { useHardwareBack } from '@/lib/nav';
import { fiat } from '@/lib/safety';
import { useWallet } from '@/state/wallet';
import { colors, radius, space, type } from '@/theme';

export default function Request() {
  const w = useWallet();
  const [amountText, setAmountText] = useState('');
  const [note, setNote] = useState('');
  const [made, setMade] = useState(false);
  // Android back from the finished request returns to editing it, like the header arrow.
  useHardwareBack(
    useCallback(() => {
      if (!made) return false;
      setMade(false);
      return true;
    }, [made]),
  );
  if (!w.meta) return null;
  const meta = w.meta;
  const amount = amountText ? parseNoid(amountText) : null;
  const amountOk = !amountText || !!amount;
  const amountStr = amount ? formatNoid(amount).replace(/,/g, '') : undefined;
  const cleanNote = note.trim();
  const link = payLink(LINK_BASE, { address: meta.address, amount: amountStr, note: cleanNote });
  const value = amount ? fiat(amount, w.price, w.settings.currency ?? 'none') : null;

  if (made) {
    const text = `Please send me ${amountStr ? `${amountStr} NOID` : 'NOID'}${cleanNote ? ` for ${cleanNote}` : ''}. Pay with the NOID wallet: ${link}`;
    const share = () => Share.share({ message: text }).catch(() => {});
    return (
      <Screen
        scroll
        header={{ title: 'Payment request', back: () => setMade(false) }}
        footer={<Button title="Share request" icon="share" onPress={share} />}
      >
        <View
          style={{
            alignItems: 'center',
            gap: space.md,
            padding: space.xl,
            backgroundColor: colors.s1,
            borderRadius: radius.xl,
            borderWidth: 1,
            borderColor: colors.line,
          }}
        >
          <Text style={[type.caption, { textTransform: 'uppercase', letterSpacing: 1 }]}>Pay me with NOID</Text>
          <View style={{ padding: space.lg, backgroundColor: '#fff', borderRadius: radius.lg }}>
            <QRCode value={link} size={208} backgroundColor="#fff" color="#000" />
          </View>
          {amountStr ? (
            <Text style={type.display} accessibilityLabel={`${amountStr} NOID`}>
              {amountStr} <Text style={[type.h2, { color: colors.textSecondary }]}>NOID</Text>
            </Text>
          ) : (
            <Text style={type.h2}>Any amount</Text>
          )}
          {value ? <Text style={type.bodySm}>{value}</Text> : null}
          {cleanNote ? <Body style={{ textAlign: 'center' }}>“{cleanNote}”</Body> : null}
        </View>
        <View style={{ flexDirection: 'row', justifyContent: 'center', gap: space.xxl }}>
          <IconAction icon="copy" label="Copy link" onPress={() => void copyText(link, 'Request link')} />
          <IconAction icon="share" label="Share" onPress={share} />
          <IconAction icon="request" label="Edit" onPress={() => setMade(false)} />
        </View>
        <Body muted style={{ textAlign: 'center' }}>
          The payer scans this with NOID or opens the link. Their wallet fills in your address and amount, and they confirm.
        </Body>
      </Screen>
    );
  }

  return (
    <Screen
      scroll
      header={{ title: 'Request NOID' }}
      footer={<Button title="Create request" disabled={!amountOk} onPress={() => setMade(true)} />}
    >
      <Body muted>Ask for an exact amount. You get a QR code and a link to send on WhatsApp, Telegram or anywhere.</Body>
      <Field
        label="Amount (optional)"
        mono
        big
        value={amountText}
        onChangeText={setAmountText}
        keyboardType="decimal-pad"
        placeholder="0.0"
        right={<Text style={[type.title, { color: colors.textSecondary }]}>NOID</Text>}
        hint={value}
        error={amountOk ? null : 'Use a positive number with at most 6 decimal places.'}
      />
      <Field
        label="What it’s for (optional)"
        value={note}
        onChangeText={setNote}
        maxLength={MAX_NOTE}
        placeholder="Jollof and drinks"
        autoCapitalize="sentences"
      />
      <Banner tone="info">The note travels inside the link, so anyone who sees the link can read it.</Banner>
    </Screen>
  );
}
