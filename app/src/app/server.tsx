import { useState } from 'react';

import { Banner, Body, Button, Field, Screen } from '@/components/ui';
import { createApi, isAllowedServerUrl } from '@/lib/api';
import { goBack } from '@/lib/nav';
import { useWallet } from '@/state/wallet';

export default function Server() {
  const w = useWallet();
  const [url, setUrl] = useState(w.settings.apiUrl);
  const [note, setNote] = useState<{ tone: 'info' | 'danger'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  async function save() {
    setNote(null);
    setSaved(false);
    let clean = url.trim().replace(/\/+$/, '');
    // A bare address like 192.168.1.20:8787 means a test server on this Wi-Fi.
    if (clean && !/^https?:\/\//i.test(clean)) clean = (/^(\d+\.){3}\d+(:\d+)?$/.test(clean) ? 'http://' : 'https://') + clean;
    setUrl(clean);
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
      setSaved(true);
    } catch (e) {
      const local = /^https:\/\/(192\.168|10\.|172\.)/.test(clean);
      setNote({
        tone: 'danger',
        text: local
          ? 'Cannot reach that server. A test server on your Wi-Fi uses http://, not https://, and needs the port, e.g. http://192.168.1.20:8787.'
          : `${(e as Error).message} Check the address, and that the server is running.`,
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen
      header={{ title: 'Wallet server' }}
      footer={
        <>
          <Button title="Test and save" busy={busy} disabled={!url.trim()} onPress={save} />
          {saved ? <Button title="Done" kind="secondary" onPress={() => goBack()} /> : null}
        </>
      }
    >
      <Body muted>
        The server reads public chain data and relays your finished payments. It never sees your secret and can’t change where
        your NOID goes.
      </Body>
      <Field
        label="Server address"
        value={url}
        onChangeText={(t) => {
          setUrl(t);
          setNote(null);
          setSaved(false);
        }}
        keyboardType="url"
        returnKeyType="go"
        onSubmitEditing={() => void save()}
        placeholder="https://api.noidusa.com"
        hint="Testing at home? Use your PC’s Wi-Fi address with http, e.g. http://192.168.1.20:8787"
      />
      {note ? <Banner tone={note.tone === 'danger' ? 'danger' : 'success'}>{note.text}</Banner> : null}
    </Screen>
  );
}
