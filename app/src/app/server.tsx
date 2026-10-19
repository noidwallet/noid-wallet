import { useState } from 'react';
import { router } from 'expo-router';

import { Body, Button, Field, Notice, Screen, Title } from '@/components/ui';
import { createApi, isAllowedServerUrl } from '@/lib/api';
import { useWallet } from '@/state/wallet';

export default function Server() {
  const w = useWallet();
  const [url, setUrl] = useState(w.settings.apiUrl);
  const [note, setNote] = useState<{ tone: 'info' | 'danger'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function save() {
    setNote(null);
    const clean = url.trim().replace(/\/+$/, '');
    if (!isAllowedServerUrl(clean)) {
      setNote({
        tone: 'danger',
        text: 'Use an https:// address. Plain http:// is only allowed for a test server on your own Wi-Fi.',
      });
      return;
    }
    setBusy(true);
    try {
      const s = await createApi(clean).status();
      await w.setApiUrl(clean);
      setNote({ tone: 'info', text: `Connected. Block ${s.height.toLocaleString()}${s.synced ? '' : ' (node still syncing)'}.` });
    } catch (e) {
      setNote({ tone: 'danger', text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen>
      <Title>Wallet server</Title>
      <Body muted>
        The server reads public chain data and relays your finished transactions. It never sees your secret, and it
        cannot change where your NOID goes.
      </Body>
      <Field label="Server address" value={url} onChangeText={setUrl} keyboardType="url" placeholder="https://api.yourdomain.com" />
      <Button title="Test and save" busy={busy} disabled={!url} onPress={save} />
      {note ? <Notice tone={note.tone}>{note.text}</Notice> : null}
      <Button title="Back" kind="ghost" onPress={() => router.back()} />
    </Screen>
  );
}
