import { useState } from 'react';

import { Banner, Body, Button, Field, Screen } from '@/components/ui';
import { goRoot } from '@/lib/nav';
import { useWallet } from '@/state/wallet';

export default function RemoveWallet() {
  const w = useWallet();
  const [confirm, setConfirm] = useState('');
  if (!w.meta) return null;
  const backedUp = w.meta.backedUp;
  const openGifts = w.gifts.filter((g) => !g.hidden && g.status === 'funded').length;

  return (
    <Screen
      header={{ title: 'Remove wallet' }}
      footer={
        <Button
          title="Remove wallet"
          kind="danger"
          icon="warning"
          disabled={confirm !== 'REMOVE' || !backedUp}
          onPress={async () => {
            if (!(await w.confirmUser('Remove this wallet'))) return;
            await w.removeWallet();
            goRoot();
          }}
        />
      }
    >
      {backedUp ? (
        <Body muted>
          Your NOID stays on the network, but this phone forgets the wallet. You can only get back in with your 64-character secret.
        </Body>
      ) : (
        <Banner tone="danger" icon="key">
          You haven’t confirmed a backup of this wallet’s secret. Removing it now would lose your NOID for good. Back it up first in
          Settings.
        </Banner>
      )}
      {openGifts > 0 ? (
        <Banner tone="warn" icon="gift">
          {openGifts} gift card{openGifts === 1 ? ' is' : 's are'} still waiting to be claimed. After you restore this wallet, Gift cards →
          Find gifts brings them back.
        </Banner>
      ) : null}
      {backedUp ? (
        <Field
          label="Type REMOVE to confirm"
          value={confirm}
          onChangeText={(t) => setConfirm(t.toUpperCase())}
          placeholder="REMOVE"
          autoCapitalize="characters"
        />
      ) : null}
    </Screen>
  );
}
