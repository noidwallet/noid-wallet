import { useCallback, useEffect, useRef, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import { Share, View } from 'react-native';

import { AmountField } from '@/components/AmountField';
import { RequestCard } from '@/components/RequestCard';
import { makeNameOf, when } from '@/components/TxRow';
import { Banner, Body, Button, Field, IconAction, Screen, toast } from '@/components/ui';
import { formatNoid, parseNoid } from '@/lib/amount';
import { copyText, useCopied } from '@/lib/clip';
import { LINK_BASE } from '@/lib/config';
import { MAX_NOTE, payLink } from '@/lib/links';
import { go, useHardwareBack } from '@/lib/nav';
import { matchRequestPayment } from '@/lib/requestMatch';
import { fiat } from '@/lib/safety';
import { removeSharedFiles, shareViewAsImage } from '@/lib/shareImage';
import { useWallet } from '@/state/wallet';
import { space } from '@/theme';

/** While a request is open, check for the payment more often than the usual 15 s. */
const WATCH_MS = 6_000;

export default function Request() {
  const w = useWallet();
  const copied = useCopied();
  const [amountText, setAmountText] = useState('');
  // Currency text that can't be turned into an amount (see AmountField).
  const [amountInvalid, setAmountInvalid] = useState(false);
  const [note, setNote] = useState('');
  // Set when the request is created: only payments in later blocks (and not
  // already in the history then) can mark it paid.
  const [made, setMade] = useState<{ known: string[]; height: number } | null>(null);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [cardSize, setCardSize] = useState({ width: 0, height: 0 });
  const [sharing, setSharing] = useState(false);
  const [shareError, setShareError] = useState<string | null>(null);
  const card = useRef<View>(null);

  // Android back from the finished request returns to editing it, like the header arrow.
  useHardwareBack(
    useCallback(() => {
      if (!made) return false;
      setMade(null);
      return true;
    }, [made]),
  );
  useEffect(() => removeSharedFiles, []);

  const amount = amountText ? parseNoid(amountText) : null;
  const status = made
    ? matchRequestPayment(w.history, {
        amount,
        afterHeight: made.height,
        knownTxids: new Set(made.known),
        // Taking back or claiming your own gift is not someone paying you.
        ignoreFrom: new Set(w.gifts.map((g) => g.address)),
      })
    : null;
  // Not while the wallet is re-locked: the lock screen covers this one.
  const watching = status?.status === 'waiting' && !w.paused;
  const paidTxid = status && status.status !== 'waiting' ? status.item.txid : null;
  const outcome = status && status.status !== 'waiting' ? `${status.status}:${status.item.txid}` : null;

  const refresh = w.refresh;
  useFocusEffect(
    useCallback(() => {
      if (!watching) return;
      const t = setInterval(() => void refresh(), WATCH_MS);
      return () => clearInterval(t);
    }, [watching, refresh]),
  );
  useEffect(() => {
    // A buzz you can feel without looking: success only for the right amount.
    if (!outcome) return;
    void Haptics.notificationAsync(
      outcome.startsWith('paid:') ? Haptics.NotificationFeedbackType.Success : Haptics.NotificationFeedbackType.Warning,
    );
  }, [outcome]);

  if (!w.meta) return null;
  const meta = w.meta;
  const amountOk = !amountText || !!amount;
  const amountStr = amount ? formatNoid(amount).replace(/,/g, '') : undefined;
  const cleanNote = note.trim();
  const link = payLink(LINK_BASE, { address: meta.address, amount: amountStr, note: cleanNote });
  const currency = w.settings.currency ?? 'none';
  const value = amount ? fiat(amount, w.price, currency) : null;

  if (made) {
    const text = `Please send me ${amountStr ? `${amountStr} NOID` : 'NOID'}${cleanNote ? ` for ${cleanNote}` : ''}. Pay with the NOID wallet: ${link}`;
    const shareLink = () => Share.share({ message: text }).catch(() => {});
    const nameOf = makeNameOf(w.contacts);

    async function shareImage() {
      setShareError(null);
      setSharing(true);
      try {
        // Most apps take an image plus a caption: the link goes on the clipboard for that.
        await Clipboard.setStringAsync(text);
        toast('Request text copied: paste it as the caption');
        await shareViewAsImage(card, { size: cardSize, dialogTitle: 'Share payment request' });
      } catch (e) {
        setShareError((e as Error).message);
      } finally {
        setSharing(false);
      }
    }

    return (
      <Screen
        scroll
        header={{ title: 'Payment request', back: () => setMade(null) }}
        footer={<Button title="Share as image" icon="image" busy={sharing} onPress={shareImage} />}
      >
        {status?.status === 'paid' ? (
          <Banner tone="success" icon="check">
            Paid ✓ {formatNoid(status.item.amount)} NOID
            {status.item.counterparty ? ` from ${nameOf(status.item.counterparty)}` : ''} · {when(status.item.time)}
          </Banner>
        ) : status?.status === 'different' ? (
          <Banner tone="warn" icon="warning">
            {formatNoid(status.item.amount)} NOID arrived
            {status.item.counterparty ? ` from ${nameOf(status.item.counterparty)}` : ''}, but you asked for {amountStr} NOID. Check
            with the payer before you hand anything over.
          </Banner>
        ) : (
          <Banner tone="neutral" icon="clock">
            Waiting for payment. This turns to Paid ✓ by itself. A screenshot from the payer is not proof: wait for it here.
          </Banner>
        )}
        {paidTxid ? (
          <Button
            title="View payment"
            kind="tertiary"
            onPress={() => go({ pathname: '/tx/[txid]', params: { txid: paidTxid } })}
          />
        ) : null}

        <RequestCard
          ref={card}
          link={link}
          address={meta.address}
          amount={amountStr}
          value={value}
          note={cleanNote}
          onSize={setCardSize}
        />
        {shareError ? <Banner tone="danger">{shareError}</Banner> : null}

        <View style={{ flexDirection: 'row', justifyContent: 'center', gap: space.xxl }}>
          <IconAction
            icon={copied.isCopied() ? 'check' : 'copy'}
            label={copied.isCopied() ? 'Copied' : 'Copy link'}
            onPress={() => {
              copied.mark();
              void copyText(link, 'Request link');
            }}
          />
          <IconAction icon="share" label="Share link" onPress={shareLink} />
          <IconAction icon="request" label="Edit" onPress={() => setMade(null)} />
        </View>
        <Body muted style={{ textAlign: 'center' }}>
          The payer scans the QR with NOID or opens the link. Their wallet fills in your address and amount, and they confirm.
        </Body>
      </Screen>
    );
  }

  return (
    <Screen
      scroll
      header={{ title: 'Request NOID' }}
      footer={
        <Button
          title="Create request"
          busy={creating}
          disabled={!amountOk || amountInvalid}
          onPress={async () => {
            setShareError(null);
            setCreateError(null);
            setCreating(true);
            try {
              // The current chain height, straight from the server: payments
              // already on chain can never mark this request paid.
              const st = await w.api.status();
              setMade({ known: w.history.map((h) => h.txid), height: st.height });
            } catch {
              setCreateError('Can’t reach your wallet server, so the request can’t watch for the payment. Check your connection and try again.');
            } finally {
              setCreating(false);
            }
          }}
        />
      }
    >
      <Body muted>Ask for an exact amount. You get a card with a QR code to share on WhatsApp, Telegram, Discord, X or anywhere.</Body>
      <AmountField
        label="Amount (optional)"
        noidText={amountText}
        onChangeNoid={setAmountText}
        onInvalidChange={setAmountInvalid}
        price={w.price}
        currency={currency}
        placeholder="0.0"
        hint={value}
        error={amountOk ? null : 'Use a number like 1500 or 1.5: a dot for decimals, no commas for thousands.'}
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
      {createError ? <Banner tone="danger">{createError}</Banner> : null}
    </Screen>
  );
}
