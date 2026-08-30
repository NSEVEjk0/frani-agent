/**
 * test-mint-gate-unit.mjs — offline proof of frani-agent's money shape:
 * there is NO outbound payment rail, and the one decision that does read the
 * balance (the one-time bootstrap self-mint) never mistakes an outage for a zero.
 *
 * Two claims, and the first is why this file cannot be lifted into a sibling repo.
 *
 * CLAIM 1 — request-only is structural, not a setting.
 *   Discovery is this agent's whole product, and it is metered with prepaid
 *   credit denominated in base units: an odd top-up leaves a carry rather than an
 *   overpayment, so nothing ever has to be sent back. That let the send path be
 *   deleted outright rather than merely disabled. A flag can be flipped and a
 *   guard can be bypassed; a method that does not exist cannot be called. These
 *   assertions therefore check for ABSENCE — `_send`, `refund`, and any reference
 *   to `payments.send` in the source — which is exactly what every custodial
 *   sibling in this fleet must FAIL.
 *
 * CLAIM 2 — an outage is not a zero balance.
 *   `payments.assets()` resolves with an EMPTY ARRAY when the wallet-api is
 *   unreachable. It does not throw. Observed live on 2026-08-27/28: balances read
 *   0 while the wallets held funds. With the send path gone, exactly one decision
 *   still consults the balance — whether to fire the bootstrap mint — and reading
 *   silence as zero there mints a SECOND time onto an already-funded wallet.
 *   `_coinRow()` returns {present, row} so that decision can see the difference,
 *   and the gate is scoped to a PRE-EXISTING wallet: one generated on this very
 *   boot cannot already hold funds, so there the silence really is a zero and a
 *   brand-new identity still performs its documented one-time self-mint.
 *
 * Offline: SphereClient takes an injected `sphere`, so no network, no wallet, no
 * funds. Run:  node test-mint-gate-unit.mjs
 */

import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'mintgate-'));
process.env.ENV_FILE = join(tmp, 'no-such.env'); // config falls back to defaults
process.env.WALLET_DIR = tmp;
process.env.LOG_LEVEL = 'error';
process.env.SELF_MINT_ENABLED = 'true'; // so the bootstrap path is reachable at all
process.env.MIN_BALANCE = '1';

const { SphereClient } = await import('./src/sphere-client.js');
const { default: config } = await import('./src/config.js');

const DEC = 18n;
const D = 10n ** DEC;
const base = (whole) => (BigInt(Math.round(Number(whole) * 1000)) * D) / 1000n;
const COIN = { coinId: 'uct-coin-id', symbol: 'UCT', decimals: Number(DEC) };
const PEER = '02' + 'c'.repeat(64);

let passed = 0, failed = 0;
const ok = (cond, msg, got) => {
  if (cond) { passed++; console.log(`  ✅ ${msg}`); }
  else { failed++; console.log(`  ❌ ${msg}${got !== undefined ? ` — got ${JSON.stringify(got)}` : ''}`); }
};

/** The real shape the SDK produces when the wallet-api is unreachable. */
const OUTAGE = [];
const funded = (whole) => [{
  coinId: COIN.coinId,
  confirmedAmount: base(whole).toString(),
  totalAmount: base(whole).toString(),
}];
const OTHER_COIN_ONLY = [{ coinId: 'some-other-coin', confirmedAmount: base(999).toString() }];

const makeClient = (assetRows, created = false) => {
  const sphere = {
    payments: {
      rows: assetRows,
      sends: [],
      mints: [],
      requests: {
        created: [],
        declined: [],
        async create(to, opts) { this.created.push({ to, ...opts }); return { success: true, requestId: `req-${this.created.length}` }; },
        async decline(id) { this.declined.push(id); return { success: true }; },
      },
      async assets() { return this.rows; },
      async send(args) { this.sends.push(args); return { status: 'ok' }; },
      async mint(coinId, amount) { this.mints.push({ coinId, amount }); return { success: true, tokenId: 'deadbeef' }; },
    },
    identity: { chainPubkey: '02' + 'a'.repeat(64) },
  };
  return { client: new SphereClient(sphere, COIN, 'device-test', created), sphere };
};

console.log('════════ mint-gate + no-send-rail proof (offline) ════════');

console.log('\n[1] REQUEST-ONLY IS STRUCTURAL — the send path does not exist');
{
  const { client, sphere } = makeClient(funded(100));

  // A sibling that holds custody has these. This agent must not.
  ok(typeof client._send !== 'function', 'SphereClient exposes no _send()', typeof client._send);
  ok(typeof client.refund !== 'function', 'SphereClient exposes no refund()', typeof client.refund);
  ok(typeof client.disburse !== 'function', 'nor a disburse()', typeof client.disburse);
  ok(typeof client.release !== 'function', 'nor a release()', typeof client.release);

  // Nothing on the prototype chain sends, whatever it is called.
  const methods = new Set();
  for (let o = client; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) {
    for (const k of Object.getOwnPropertyNames(o)) methods.add(k);
  }
  const sendish = [...methods].filter((m) => /^(_?send|refund|disburse|release|payout|withdraw|transfer)/i.test(m) && m !== 'sendDM');
  ok(sendish.length === 0, 'no method on the client is named after paying anybody', sendish);

  // And the source itself never reaches for the SDK's send.
  const src = readFileSync(new URL('./src/sphere-client.js', import.meta.url), 'utf8');
  const callsSend = /payments\s*\.\s*send\s*\(/.test(src);
  ok(!callsSend, 'src/sphere-client.js contains no payments.send( call site', callsSend);

  // The rails it DOES have: ask, and decline being asked.
  ok(typeof client.requestPayment === 'function', 'it can raise a payment request');
  ok(typeof client.declinePaymentRequest === 'function', 'and decline one sent to it');
  const r = await client.requestPayment(PEER, 5, 'alert credit');
  ok(r?.success === true && sphere.payments.requests.created.length === 1, 'a request really goes out', r);
  ok(sphere.payments.sends.length === 0, 'and no send accompanies it', sphere.payments.sends.length);
}

console.log('\n[2] the config carries no refund knob for a rail that is gone');
{
  ok(config.safety.autoRefundOverpayment === undefined,
    'config.safety has no autoRefundOverpayment', config.safety.autoRefundOverpayment);
  ok(typeof config.watch?.alertPriceWhole === 'number',
    'it prices alerts instead', config.watch?.alertPriceWhole);
  ok(config.watch.freeAlerts > 0,
    'and gives every account a free allowance before asking for anything', config.watch.freeAlerts);
}

console.log('\n[3] AN OUTAGE ON A PRE-EXISTING WALLET NEVER TRIGGERS A SECOND MINT');
{
  const { client, sphere } = makeClient(OUTAGE, /* created */ false);
  // These are the assertions that fail without the fix: 0 < floor looks like
  // "unfunded", and the bootstrap fires onto a wallet that may hold 100 UCT.
  await client.bootstrapMintIfNeeded();
  ok(sphere.payments.mints.length === 0,
    'no mint on an existing wallet whose balance could not be read', sphere.payments.mints.length);

  const row = await client._coinRow();
  ok(row.present === false, '_coinRow() reports the silence as absence, not as zero', row);
  ok((await client.spendableBase()) === 0n,
    'spendableBase() still returns 0n — which is exactly why callers must use _coinRow()');
}

console.log('\n[4] a row for a DIFFERENT coin is the same silence about ours');
{
  const { client, sphere } = makeClient(OTHER_COIN_ONLY, false);
  await client.bootstrapMintIfNeeded();
  ok(sphere.payments.mints.length === 0,
    'someone else\'s coin balance is not evidence about ours', sphere.payments.mints.length);
}

console.log('\n[5] a wallet GENERATED THIS BOOT still gets its documented bootstrap');
{
  const { client, sphere } = makeClient(OUTAGE, /* created */ true);
  await client.bootstrapMintIfNeeded();
  ok(sphere.payments.mints.length === 1,
    'the one-time self-mint fires — a wallet created seconds ago cannot hold funds', sphere.payments.mints.length);
  ok(sphere.payments.mints[0]?.amount === base(config.safety.selfMintAmountWhole),
    `and mints exactly the capped ${config.safety.selfMintAmountWhole} UCT in base units`,
    String(sphere.payments.mints[0]?.amount));
}

console.log('\n[6] a funded wallet is left alone, created flag or not');
{
  for (const created of [false, true]) {
    const { client, sphere } = makeClient(funded(100), created);
    await client.bootstrapMintIfNeeded();
    ok(sphere.payments.mints.length === 0,
      `no bootstrap mint when the balance is already above the floor (created=${created})`,
      sphere.payments.mints.length);
  }
  const { client, sphere } = makeClient(funded(0), false);
  await client.bootstrapMintIfNeeded();
  ok(sphere.payments.mints.length === 1,
    'a PRESENT row reading zero is a real zero, so the bootstrap does fire', sphere.payments.mints.length);
}

console.log('\n[7] mint failure is a returned value, not a throw');
{
  const { client, sphere } = makeClient(funded(0), false);
  sphere.payments.mint = async () => ({ success: false, error: 'minting disabled upstream' });
  const r = await client.mint(10);
  ok(r?.success === false, 'mint() surfaces {success:false} rather than resolving quietly', r);
  ok(!!r?.error, 'and carries the reason, so a bare try/catch cannot swallow it', r?.error);
}

console.log(`\n════════ ${passed} passed, ${failed} failed ════════`);
process.exit(failed === 0 ? 0 : 1);
