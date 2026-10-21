import { test } from 'node:test';
import assert from 'node:assert/strict';

import { maxSendable, networkFee, WALLET_FEE, WALLET_FEE_ADDRESS, walletFeeFor, type FeeRule } from './walletFee';

const rule: FeeRule = { address: 'o1example', bps: 25, min: 5_000, max: 500_000 };
const ctx = { activeSlotCount: 95_000, logSlots: 24, relayFloor: 5_000 };

test('wallet fee: 0.25%, at least 0.005 NOID, at most 0.5 NOID', () => {
  assert.equal(walletFeeFor(10_000_000, rule), 25_000, '10 NOID -> 0.025');
  assert.equal(walletFeeFor(1_000_000, rule), 5_000, '1 NOID -> the 0.005 minimum');
  assert.equal(walletFeeFor(2_000_000_000, rule), 500_000, '2,000 NOID -> the 0.5 maximum');
  assert.equal(walletFeeFor(0, rule), 0);
  assert.equal(walletFeeFor(10_000_000, { ...rule, address: '' }), 0, 'no fee address, no fee');
});

test('network fee matches the consensus rule', () => {
  assert.equal(networkFee(1, 2, ctx), 9_000);
  assert.equal(networkFee(1, 3, ctx), 12_200);
  assert.equal(networkFee(3, 2, ctx), 6_700);
  assert.equal(networkFee(1, 2, { activeSlotCount: 1 << 23, logSlots: 24, relayFloor: 5_000 }), 11_500, 'half full: double growth');
  assert.equal(networkFee(1, 1, { ...ctx, relayFloor: 50_000 }), 50_000, 'relay floor');
});

test('send max leaves nothing behind and pays both fees', () => {
  for (const spendable of [20_000, 1_000_000, 4_743_400, 80_000_000, 900_000_000_000]) {
    for (const coins of [1, 3]) {
      const amount = maxSendable(spendable, coins, ctx, rule)!;
      const total = amount + walletFeeFor(amount, rule) + networkFee(coins, 2, ctx);
      assert.ok(total <= spendable, `fits: ${spendable}`);
      assert.ok(spendable - total <= 2, `uses it all: ${spendable} left ${spendable - total}`);
    }
  }
  assert.equal(maxSendable(10_000, 1, ctx, rule), null, 'less than the fees');
  assert.equal(maxSendable(1_000_000, 1, ctx, { ...rule, address: '' }), 1_000_000 - networkFee(1, 1, ctx));
});

test('the release has a fee address that can not come from the server', () => {
  assert.match(WALLET_FEE_ADDRESS, /^o1[02-9ac-hj-np-z]{50,70}$/, 'set WALLET_FEE_ADDRESS before a release');
  assert.equal(WALLET_FEE.address, WALLET_FEE_ADDRESS);
});
