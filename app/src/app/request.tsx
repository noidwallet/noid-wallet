import { useState } from 'react';
import * as Clipboard from 'expo-clipboard';
import { Share, Text, View } from 'react-native';
import QRCode from 'react-native-qrcode-svg';

import { Body, Button, Field, Notice, Screen, Title } from '@/components/ui';
import { formatNoid, parseNoid } from '@/lib/amount';
import { LINK_BASE } from '@/lib/config';
import { MAX_NOTE, payLink } from '@/lib/links';
import { goBack } from '@/lib/nav';
import { fiat } from '@/lib/safety';
import { useWallet } from '@/state/wallet';
import { colors, fonts, radius, space } from '@/theme';

export default function Request() {
  const w = useWallet();
  const [amountText, setAmountText] = useState('');
  const [note, setNote] = useState('');
  const [made, setMade] = useState(false);
  const [copied, setCopied] = useState(false);
  if (!w.meta) return null;
  const meta = w.meta;
  const amount = amountText ? parseNoid(amountText) : null;
  const amountOk = !amountText || !!amount;
  const amountStr = amount ? formatNoid(amount).replace(/,/g, '') : undefined;
  const link = payLink(LINK_BASE, { address: meta.address, amount: amountStr, note });
  const value = amount ? fiat(amount, w.price, w.settings.currency ?? 'none') : null;

  if (made) {
    const text = `Please send me ${amountStr ? `${amountStr} NOID` : 'NOID'}${note.trim() ? ` for ${note.trim()}` : ''}. Pay with the NOID wallet: ${link}`;
    return (
      <Screen>
        <Title>Payment request</Title>
        <View style={{ alignItems: 'center', gap: space.sm }}>
          <View style={{ padding: space.lg, backgroundColor: '#fff', borderRadius: radius.lg }}>
            <QRCode value={link} size={220} backgroundColor="#fff" color="#000" />
          </View>
          {amountStr ? (
            <Text style={{ color: colors.text, fontFamily: fonts.monoBold, fontSize: 26 }}>{amountStr} NOID</Text>
          ) : null}
          {value ? <Text style={{ color: colors.muted }}>{value}</Text> : null}
          {note.trim() ? <Body style={{ textAlign: 'center' }}>{note.trim()}</Body> : null}
        </View>
        <Body muted style={{ fontSize: 14, textAlign: 'center' }}>
          The payer scans this with NOID, or opens the link. Their wallet fills in your address and amount.
        </Body>
        <View style={{ flex: 1 }} />
        <Button title="Share request" onPress={() => Share.share({ message: text }).catch(() => {})} />
        <Button
          title={copied ? 'Copied' : 'Copy link'}
          kind="secondary"
          onPress={async () => {
            await Clipboard.setStringAsync(link);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
        />
        <Button title="Change request" kind="ghost" onPress={() => setMade(false)} />
      </Screen>
    );
  }

  return (
    <Screen>
      <Title>Request NOID</Title>
      <Body muted>Ask for an exact amount. You get a QR code and a link to send on WhatsApp, Telegram or anywhere.</Body>
      <Field
        label="Amount (NOID, optional)"
        mono
        value={amountText}
        onChangeText={setAmountText}
        keyboardType="decimal-pad"
        placeholder="0.0"
        error={amountOk ? null : 'Use a positive number with at most 6 decimal places.'}
      />
      {value ? <Text style={{ color: colors.muted, fontSize: 14, marginTop: -space.sm }}>{value}</Text> : null}
      <Field label="What it is for (optional)" value={note} onChangeText={setNote} maxLength={MAX_NOTE} placeholder="Jollof and drinks" autoCapitalize="sentences" />
      <Notice>The note travels in the link, so anyone who sees the link can read it.</Notice>
      <View style={{ flex: 1 }} />
      <Button title="Create request" disabled={!amountOk} onPress={() => setMade(true)} />
      <Button title="Back" kind="ghost" onPress={() => goBack()} />
    </Screen>
  );
}
