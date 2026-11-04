// Send a token or NFT (NOID 1.2). Form -> review (computed on the phone from
// the decoded transfer, never from the server's numbers) -> confirm -> sent.
import { useCallback, useRef, useState } from 'react';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import { Pressable, Text, View } from 'react-native';

import { Icon } from '@/components/Icon';
import { TokenIcon } from '@/components/AssetRows';
import { SendProgress } from '@/components/Progress';
import { AssetSelector, RecentRecipients, recentRecipients } from '@/components/SendPickers';
import { Avatar, Banner, Body, Button, Card, Field, IconButton, KeyValue, Screen, SuccessMark, Title } from '@/components/ui';
import { formatNoid, shortAddress } from '@/lib/amount';
import { nftName, shownAssets, tokenName, useAssets } from '@/lib/assets';
import { LINK_HOSTS } from '@/lib/config';
import { core, type NativeSendReview, type NativeTransfer } from '@/lib/core';
import { parseLink } from '@/lib/links';
import { knownBlockId } from '@/lib/chain';
import { executeNativeSend, NativeFeeChanged, reviewNativeSend } from '@/lib/nativeSend';
import { go, goHome, useArmed, useHardwareBack } from '@/lib/nav';
import { checkAddress, fiat, groupAddress } from '@/lib/safety';
import { assetPick, contactPick, scanResult } from '@/lib/scan';
import { hasUnresolvedSend, overrideRefusals, RefusedButSpent, SubmitUnknown, type Stage } from '@/lib/send';
import { storage } from '@/lib/storage';
import { formatUnits, nftKey, parseUnits, toBig } from '@/lib/tokenMath';
import { useWallet } from '@/state/wallet';
import { colors, fonts, space, type } from '@/theme';

type Step = 'form' | 'review' | 'sending' | 'done';

export default function NativeSend() {
  const { kind, id, to: toParam } = useLocalSearchParams<{ kind: string; id: string; to?: string }>();
  const w = useWallet();
  const shown = shownAssets(useAssets(), w.meta?.address);
  const token = kind === 'token' ? shown?.tokens.find((t) => t.assetId === id) : undefined;
  const nft = kind === 'nft' ? shown?.nfts.find((n) => nftKey(n.collection, n.serial) === id) : undefined;
  const sendingRef = useRef(false);
  const [to, setTo] = useState(typeof toParam === 'string' ? toParam : '');
  const [toError, setToError] = useState<string | null>(null);
  const [amountText, setAmountText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState<Step>('form');
  const [stage, setStage] = useState<Stage>('preparing');
  const [review, setReview] = useState<NativeSendReview | null>(null);
  const [transfer, setTransfer] = useState<NativeTransfer | null>(null);
  const [checkedLookalike, setCheckedLookalike] = useState(false);
  const [doneTxid, setDoneTxid] = useState<string | null>(null);
  const [unknownTxid, setUnknownTxid] = useState<string | null>(null);
  const [refusedFor, setRefusedFor] = useState<NativeSendReview | null>(null);

  useHardwareBack(
    useCallback(() => {
      if (step === 'sending') return true;
      if (step === 'review') {
        setError(null);
        setStep('form');
        return true;
      }
      if (step === 'done') {
        goHome();
        return true;
      }
      return false;
    }, [step]),
  );

  useFocusEffect(
    useCallback(() => {
      const scanned = scanResult.take();
      if (scanned) {
        const p = parseLink(scanned, LINK_HOSTS);
        if (p && p.kind !== 'gift') {
          setTo(p.address);
          setToError(null);
        } else setToError('That QR code is not a NOID address.');
      }
      const picked = contactPick.take();
      if (picked) {
        setTo(picked);
        setToError(null);
      }
      // Something else chosen in the picker: NOID has its own form; another
      // token or NFT reuses this one. The recipient carries over.
      const what = assetPick.take();
      if (what === 'noid') router.replace({ pathname: '/send', params: { to } });
      else if (what) {
        const [k, ...rest] = what.split(':');
        setAmountText('');
        setError(null);
        router.setParams({ kind: k, id: rest.join(':') });
      }
    }, [setTo, setToError, setAmountText, setError, to]),
  );

  const armed = useArmed(step === 'review' ? review : null);

  if (!w.meta) return null;
  const meta = w.meta;
  const symbol = token?.manifest?.symbol ?? '';
  const itemTitle = token ? tokenName(token) : nft ? nftName(nft) : '';
  const held = token ? toBig(token.units) : null;
  const spendable = token && held !== null ? held - BigInt(token.lockedUnits) - BigInt(token.reservedUnits) : null;
  const units = token ? parseUnits(amountText) : null;
  const tooMuch = units !== null && spendable !== null && BigInt(units) > spendable;
  const cleanTo = to.trim().toLowerCase();
  const safety = checkAddress(cleanTo, w.contacts, w.sentTo);
  const recipientName = safety.kind === 'contact' ? safety.name : null;
  const online = !!w.settings.apiUrl && !!w.status && !w.error;
  const supported = !!w.status?.features?.nativeSend;
  const currency = w.settings.currency ?? 'none';
  const withFiat = (micro: number) => {
    const f = fiat(micro, w.price, currency);
    return `${formatNoid(micro)} NOID${f ? ` (${f})` : ''}`;
  };
  const what = (r: NativeSendReview) =>
    r.kind === 'token' ? `${formatUnits(r.units ?? '0')} ${symbol || 'tokens'}` : nft ? nftName(nft) : `NFT #${r.serial}`;

  if (!token && !nft && step === 'form') {
    return (
      <Screen header={{ title: 'Send' }}>
        <Banner tone="neutral">This is no longer at your address.</Banner>
      </Screen>
    );
  }

  async function toReview() {
    setError(null);
    setToError(null);
    const check = await core.validateAddress(to);
    if (!check.valid || !check.address) {
      setToError(check.error ?? 'That is not a valid NOID address.');
      return;
    }
    if (check.address === meta.address) {
      setToError('This is your own address.');
      return;
    }
    let t: NativeTransfer;
    if (token) {
      if (!units) {
        setError('Enter an amount like 30 or 1.5: a dot for decimals, no commas for thousands.');
        return;
      }
      t = { kind: 'token', assetId: token.assetId, units, recipient: check.address };
    } else if (nft) {
      t = { kind: 'nft', collectionId: nft.collection, serial: nft.serial, recipient: check.address };
    } else return;
    setBusy(true);
    setCheckedLookalike(false);
    try {
      const r = await reviewNativeSend(w.api, meta.address, w.pending, t, undefined, knownBlockId);
      setTo(check.address);
      setTransfer(t);
      setReview(r.review);
      setStep('review');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function confirmAndSend() {
    if (!review || !transfer || !armed || sendingRef.current) return;
    sendingRef.current = true;
    const ok = await w.confirmUser(`Send ${what(review)}`);
    if (!ok) {
      sendingRef.current = false;
      return;
    }
    setStep('sending');
    setError(null);
    try {
      const secretHex = await storage.readSecret();
      const { pending } = await executeNativeSend({
        api: w.api,
        secretHex,
        keyIndex: meta.keyIndex,
        address: meta.address,
        pending: w.pending,
        record: w.recordPending,
        discard: w.discardPending,
        transfer,
        reviewed: review,
        itemLabel: what(review),
        knownBlockId,
        onStage: (s) => setStage(s),
      });
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setDoneTxid(pending.txid);
      setStep('done');
      void w.refresh();
    } catch (e) {
      if (e instanceof SubmitUnknown) {
        setUnknownTxid(e.txid);
        setStep('done');
        return;
      }
      if (e instanceof NativeFeeChanged) {
        setReview(e.review);
        setRefusedFor(null);
        setError(`The fees are now ${formatNoid(e.review.noidDebit)} NOID in all. Review and confirm again.`);
      } else {
        setRefusedFor(e instanceof RefusedButSpent && e.missing ? review : null);
        setError((e as Error).message);
      }
      setStep('review');
    } finally {
      sendingRef.current = false;
    }
  }

  if (step === 'sending' && review) {
    return (
      <Screen>
        <SendProgress stage={stage} title={`Sending ${what(review)}`} signing="Signing your transfer" />
      </Screen>
    );
  }

  if (step === 'done' && review) {
    const txid = doneTxid ?? unknownTxid;
    return (
      <Screen
        footer={
          <>
            <Button title="Back to wallet" onPress={goHome} />
            {txid ? <Button title="View transaction" kind="tertiary" onPress={() => go({ pathname: '/tx/[txid]', params: { txid } })} /> : null}
          </>
        }
      >
        <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', gap: space.lg }}>
          <SuccessMark tone={unknownTxid ? 'warn' : undefined} />
          <Title style={{ textAlign: 'center' }}>{unknownTxid ? 'Still checking with the network' : 'Sent'}</Title>
          <Body muted style={{ textAlign: 'center' }}>
            {unknownTxid
              ? 'Your transfer was saved before it was sent. The wallet keeps checking and re-sends this same transfer if needed, so it can never go twice. Don’t send it again.'
              : 'It arrives with the next block, usually within a minute.'}
          </Body>
          <Card style={{ alignSelf: 'stretch' }}>
            <KeyValue label="Sent" value={what(review)} mono={false} />
            <KeyValue label="To" value={recipientName ?? shortAddress(review.recipient)} mono={!recipientName} />
            <KeyValue label="Fees" value={`${formatNoid(review.noidDebit)} NOID`} />
          </Card>
        </View>
      </Screen>
    );
  }

  if (step === 'review' && review) {
    return (
      <Screen
        header={{
          title: 'Review',
          back: () => {
            setError(null);
            setStep('form');
          },
        }}
        footer={
          <Button
            title={`Send ${what(review)}`}
            icon="send"
            disabled={!armed || (safety.kind === 'lookalike' && !checkedLookalike)}
            onPress={confirmAndSend}
          />
        }
      >
        <View style={{ alignItems: 'center', gap: space.xs, paddingVertical: space.md }}>
          <Text style={type.caption}>You send</Text>
          <Text adjustsFontSizeToFit numberOfLines={1} maxFontSizeMultiplier={1.3} style={type.display}>
            {review.kind === 'token' ? formatUnits(review.units ?? '0') : `#${review.serial}`}
          </Text>
          <Text style={{ color: colors.accent, fontFamily: fonts.monoBold }}>{review.kind === 'token' ? symbol || itemTitle : itemTitle}</Text>
        </View>
        <Card>
          <Text style={type.caption}>To</Text>
          <Text style={type.title}>{recipientName ?? 'NOID address'}</Text>
          <Text selectable style={[type.monoSm, { lineHeight: 20 }]}>
            {groupAddress(review.recipient)}
          </Text>
        </Card>
        {safety.kind === 'lookalike' ? (
          <Card style={{ borderColor: colors.danger, backgroundColor: colors.dangerTint }}>
            <View style={{ flexDirection: 'row', gap: space.sm, alignItems: 'center' }}>
              <Icon name="warning" size={20} color={colors.danger} />
              <Text style={[type.title, { color: colors.danger }]}>Possible look-alike address</Text>
            </View>
            <Text style={[type.bodySm, { color: colors.text }]}>
              This address starts and ends like {safety.name ? `your contact ${safety.name}` : 'an address you paid before'}, but the middle is
              different. Scammers create addresses like this so a quick glance looks right.
            </Text>
            <Text style={type.monoSm}>Known: {groupAddress(safety.similarTo)}</Text>
            <Pressable
              accessibilityRole="checkbox"
              accessibilityState={{ checked: checkedLookalike }}
              onPress={() => setCheckedLookalike((v) => !v)}
              style={{ flexDirection: 'row', gap: space.sm, alignItems: 'center', paddingVertical: 4 }}
              hitSlop={8}
            >
              <View
                style={{
                  width: 24,
                  height: 24,
                  borderRadius: 6,
                  borderWidth: 2,
                  borderColor: colors.danger,
                  backgroundColor: checkedLookalike ? colors.danger : 'transparent',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                {checkedLookalike ? <Icon name="check" size={16} color={colors.bg} /> : null}
              </View>
              <Text style={[type.body, { flex: 1 }]}>I checked every character with the person I am sending to</Text>
            </Pressable>
          </Card>
        ) : safety.kind === 'new' ? (
          <Banner tone="warn">First time sending to this address. Confirm it with the person you are sending to.</Banner>
        ) : null}
        <Card>
          <KeyValue label="NOID wallet fee" value={withFiat(review.walletFee)} />
          <KeyValue label="Network fee" value={withFiat(review.networkFee)} />
          <KeyValue label="Total in NOID" value={withFiat(review.noidDebit)} />
          <Text style={type.bodySm}>
            Your phone checked this transfer itself before showing it: it sends exactly this to this address, everything else stays with you, and
            these fees are all the NOID it costs.
          </Text>
        </Card>
        <Banner tone="danger">Transfers can’t be reversed. Check the address and what you send.</Banner>
        {error ? <Banner tone="danger">{error}</Banner> : null}
        {refusedFor === review ? (
          <Button
            title="I checked Activity: allow this transfer"
            kind="secondary"
            onPress={() => {
              overrideRefusals(meta.address);
              setRefusedFor(null);
              setError(null);
            }}
          />
        ) : null}
      </Screen>
    );
  }

  if (hasUnresolvedSend(w.pending)) {
    return (
      <Screen header={{ title: 'Send' }}>
        <Banner tone="warn" icon="clock">
          Your last send is still being checked with the network. Wait until it shows as sent in Activity, then try again.
        </Banner>
      </Screen>
    );
  }

  const blocker = !online
    ? 'Can’t reach your wallet server, so sending is paused. Check your connection.'
    : !supported
      ? 'Your wallet server can’t prepare token and NFT transfers yet.'
      : nft?.locked
        ? 'This NFT is locked for now, so it can’t be sent yet.'
        : nft?.listing
          ? 'This NFT is listed for sale. Cancel the listing in the official Parano1d wallet first.'
          : spendable !== null && spendable <= 0n
            ? 'None of this token can be sent right now (locked or in a pending transaction).'
            : null;

  return (
    <Screen
      header={{ title: 'Send' }}
      footer={
        <Button
          title="Continue"
          busy={busy}
          disabled={!to || (!!token && (!units || tooMuch)) || !!blocker}
          onPress={() => void toReview()}
        />
      }
    >
      <AssetSelector
        leading={
          token ? (
            <TokenIcon api={w.api} token={token} />
          ) : (
            <Avatar initials={nft ? `#${nft.serial}`.slice(0, 3) : '?'} />
          )
        }
        title={itemTitle}
        subtitle={token && spendable !== null ? `You can send ${formatUnits(spendable)}${symbol ? ` ${symbol}` : ''}` : nft ? `NFT #${nft.serial}` : undefined}
        onPress={() => go('/send-asset')}
      />
      {blocker ? <Banner tone="warn">{blocker}</Banner> : null}
      <Field
        label="To"
        mono
        value={to}
        onChangeText={(t) => {
          setTo(t);
          setToError(null);
        }}
        placeholder="o1… address"
        error={toError}
        hint={recipientName ? `✓ ${recipientName}` : null}
        right={
          <>
            <IconButton
              icon="paste"
              label="Paste address"
              size={40}
              onPress={async () => {
                const t = (await Clipboard.getStringAsync()).trim();
                const p = t ? parseLink(t, LINK_HOSTS) : null;
                if (p && p.kind !== 'gift') {
                  setTo(p.address);
                  setToError(null);
                } else setToError(t ? 'The copied text is not a NOID address.' : 'Nothing to paste. Copy a NOID address first.');
              }}
            />
            <IconButton icon="scan" label="Scan QR code" size={40} onPress={() => go('/scan')} />
            <IconButton icon="contacts" label="Choose contact" size={40} onPress={() => go({ pathname: '/contacts', params: { pick: '1' } })} />
          </>
        }
      />
      {!to ? (
        <RecentRecipients
          recents={recentRecipients(w.contacts, w.sentTo)}
          onPick={(a) => {
            setTo(a);
            setToError(null);
          }}
        />
      ) : null}
      {token ? (
        <Field
          label={`Amount${symbol ? ` (${symbol})` : ''}`}
          big
          keyboardType="decimal-pad"
          value={amountText}
          onChangeText={setAmountText}
          placeholder="0"
          error={tooMuch ? 'More than you can send.' : null}
          hint={spendable !== null ? `You can send ${formatUnits(spendable)}` : null}
          right={
            spendable !== null && spendable > 0n ? (
              <Button title="All" kind="tertiary" onPress={() => setAmountText(formatUnits(spendable).replace(/,/g, ''))} />
            ) : null
          }
        />
      ) : null}
      <Banner tone="neutral">
        Sending costs a NOID wallet fee of 0.005 NOID plus the network fee, both paid in NOID. You’ll see the exact amounts before you confirm.
      </Banner>
      {error ? <Banner tone="danger">{error}</Banner> : null}
    </Screen>
  );
}
