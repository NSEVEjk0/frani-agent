/**
 * test-refund-truth-unit.mjs — offline proof that @frani-agent never claims a refund
 * that did not actually happen, and never returns money silently.
 *
 * `client.refund` resolves rather than throws for every failure mode it has:
 *   {skipped:'refunds disabled'} · {skipped:'min-balance floor'}
 *   {skipped:'non-positive amount'} · {error:…} · {unconfirmed:true} · {dryRun:true}
 *
 * settlePayment ignored that return in all three of its refund paths. Two consequences:
 *
 *   1. the underpaid and fulfilment-error branches said "I've refunded it" BEFORE
 *      knowing whether it went out — so a min-balance floor or a disabled-refunds
 *      switch turned into a false statement about somebody's money;
 *   2. the overpayment refund was neither checked NOR announced — correct, it was an
 *      unexplained transfer arriving after the result; failed, it was the difference
 *      quietly kept, against a promise `help` and `about` both make in writing.
 *
 * Same family as the silent terminal transitions fixed in @frani-agora (c5ea1a6),
 * @frani-bounty (63efd6b) and @frani-treasury (f8e8174), but the sharper version:
 * not silence, a false claim.
 *
 * Offline: no network, no wallet, no funds.
 *
 * Gitignored (test-*.mjs). Run: node test-refund-truth-unit.mjs
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const tmp = mkdtempSync(join(tmpdir(), 'frani-agent-refund-'));
process.env.ENV_FILE = join(tmp, 'no-such.env'); // config falls back to defaults
process.env.WALLET_DIR = tmp; // state.json lives here
process.env.LOG_LEVEL = 'error';

const { State } = await import('./src/state.js');
const { settlePayment } = await import('./src/services/paid-tasks.js');
const { RateLimiter } = await import('./src/ratelimit.js');
const { default: config } = await import('./src/config.js');

const DEC = 18n;
const D = 10n ** DEC;
const base = (whole) => (BigInt(Math.round(Number(whole) * 1000)) * D) / 1000n;
const toWhole = (b) => {
  b = BigInt(b);
  const f = (b % D).toString().padStart(Number(DEC), '0').replace(/0+$/, '');
  return f ? `${b / D}.${f}` : `${b / D}`;
};

let passed = 0, failed = 0;
const ok = (cond, msg) => { if (cond) { passed++; console.log(`  ✅ ${msg}`); } else { failed++; console.log(`  ❌ ${msg}`); } };

const COIN = { coinId: 'uct-coin-id', symbol: 'UCT', decimals: Number(DEC) };
const SENDER = '02' + 'c'.repeat(64);
const PRICE = config.paidTasks.priceWhole;

/** A fake client whose refund returns exactly what we tell it to. */
const makeClient = (refundResult = { status: 'ok' }) => ({
  refundResult,
  refunds: [],
  dms: [],
  coin: COIN,
  toWhole,
  toBase: base,
  // Enough of the surface for fulfillNotarize to actually succeed, so the
  // overpayment path can be reached without the error branch swallowing it.
  sphere: { signMessage: (msg) => `sig-${msg.length}` },
  identity: { chainPubkey: '02' + 'd'.repeat(64) },
  nametag: 'frani-agent',
  async refund(recipient, b, memo) {
    this.refunds.push({ recipient, base: BigInt(b).toString(), memo });
    return this.refundResult;
  },
  async sendDM(recipient, content) { this.dms.push({ recipient, content }); return { id: `dm-${this.dms.length}` }; },
});

/** Same client, but notarize fulfilment throws — for the error-path tests. */
const makeBrokenClient = (refundResult) => {
  const c = makeClient(refundResult);
  c.sphere = { signMessage: () => { throw new Error('signer unavailable'); } };
  return c;
};

const freshState = () => {
  const s = State.load();
  s.data.pendingTasks = {};
  return s;
};

const withTask = (state, kind = 'notarize') => {
  const task = {
    id: randomUUID(),
    kind,
    priceBase: base(PRICE).toString(),
    payload: 'offline harness',
    createdAt: Date.now(),
  };
  state.addPendingTask(SENDER, task);
  return task;
};

const transfer = (whole) => ({
  senderPubkey: SENDER,
  senderNametag: 'payer-demo',
  tokens: [{ coinId: COIN.coinId, amount: base(whole).toString() }],
});

const said = (client) => client.dms.map((m) => m.content).join('\n');

console.log('════════ frani-agent · refund-truth unit proof (offline) ════════');

// Every failure mode client.refund can actually return, and what it means.
const FAILURES = [
  { label: 'refunds disabled by config', result: { skipped: 'refunds disabled' } },
  { label: 'min-balance floor would be breached', result: { skipped: 'min-balance floor' } },
  { label: 'the send errored', result: { error: 'aggregator rejected the transfer' } },
  { label: 'no result at all', result: null },
];

console.log('\n[1] UNDERPAID: a refund that did not go out is never reported as done');
for (const f of FAILURES) {
  const client = makeClient(f.result);
  const state = freshState();
  withTask(state);
  await settlePayment(client, { transfer: transfer(1), state, rateLimit: new RateLimiter() });
  const text = said(client);
  ok(client.refunds.length === 1, `${f.label} — the refund was attempted`);
  ok(!/I've refunded it|have refunded/i.test(text), `${f.label} — never claims "refunded"`);
  ok(/could not send|could not return/i.test(text), `${f.label} — says plainly it could not send`);
  ok(/owed to you/i.test(text), `${f.label} — records the debt to the payer`);
}

console.log('\n[2] UNDERPAID: an unconfirmed certification is its own answer, never a retry');
{
  const client = makeClient({ unconfirmed: true });
  const state = freshState();
  withTask(state);
  await settlePayment(client, { transfer: transfer(1), state, rateLimit: new RateLimiter() });
  const text = said(client);
  ok(client.refunds.length === 1, 'attempted exactly once');
  ok(/may or may not have gone through/i.test(text), 'the ambiguity is stated, not guessed at');
  ok(/will not resend/i.test(text), 'and the double-pay guard is explained');
  ok(!/I've refunded it/i.test(text), 'never claims it completed');
}

console.log('\n[3] UNDERPAID: a refund that DID go out is reported, as before');
{
  const client = makeClient({ status: 'ok' });
  const state = freshState();
  withTask(state);
  await settlePayment(client, { transfer: transfer(1), state, rateLimit: new RateLimiter() });
  const text = said(client);
  ok(/refunded it/i.test(text), 'says it refunded');
  ok(/send the full amount to retry/i.test(text), 'and invites the retry');
  ok(!/owed to you/i.test(text), 'no phantom debt recorded');
}

console.log('\n[4] FULFILMENT ERROR: same rule on the error path');
{
  // The signer throws in this client, so this drives the real catch branch.
  const client = makeBrokenClient({ skipped: 'min-balance floor' });
  const state = freshState();
  withTask(state, 'notarize');
  await settlePayment(client, { transfer: transfer(PRICE), state, rateLimit: new RateLimiter() });
  const text = said(client);
  ok(client.refunds.length === 1, 'the refund was attempted');
  ok(BigInt(client.refunds[0].base) === base(PRICE), 'the WHOLE payment is refunded, not a part of it');
  ok(/hit an error fulfilling/i.test(text), 'the fulfilment failure is owned');
  ok(!/have refunded/i.test(text), 'but no refund is claimed');
  ok(/could not return/i.test(text) && /owed to you/i.test(text), 'the money is stated as still owed');
}

console.log('\n[5] OVERPAYMENT: the difference coming back is announced');
{
  const client = makeClient({ status: 'ok' });
  const state = freshState();
  withTask(state, 'notarize');
  await settlePayment(client, { transfer: transfer(Number(PRICE) + 2), state, rateLimit: new RateLimiter() });
  const text = said(client);
  ok(/NOTARIZED/.test(text), 'the paid result was delivered first');
  ok(client.refunds.length === 1, 'the overpayment refund was attempted');
  ok(BigInt(client.refunds[0].base) === base(2), 'only the 2 UCT difference is returned');
  ok(/2 UCT more/.test(text), 'the payer is told the amount coming back');
  ok(/on its way back/i.test(text), 'and that it is on its way');
  ok(!/owed to you/i.test(text), 'no phantom debt');
}

console.log('\n[6] OVERPAYMENT: a FAILED difference refund is never kept quietly');
{
  const client = makeClient({ skipped: 'min-balance floor' });
  const state = freshState();
  withTask(state, 'notarize');
  await settlePayment(client, { transfer: transfer(Number(PRICE) + 2), state, rateLimit: new RateLimiter() });
  const text = said(client);
  ok(/NOTARIZED/.test(text), 'the paid result was still delivered — they paid for it');
  ok(client.refunds.length === 1, 'attempted');
  ok(BigInt(client.refunds[0].base) === base(2), 'for the 2 UCT difference');
  ok(/could not return the difference/i.test(text), 'the failure is stated');
  ok(/owed to you/i.test(text), 'and the difference is recorded as owed, not kept');
  ok(!/on its way back/i.test(text), 'and never claimed to be on its way');
}

console.log('\n[7] EXACT payment: no refund, no refund talk');
{
  const client = makeClient({ status: 'ok' });
  const state = freshState();
  withTask(state, 'notarize');
  await settlePayment(client, { transfer: transfer(PRICE), state, rateLimit: new RateLimiter() });
  const text = said(client);
  ok(/NOTARIZED/.test(text), 'the result was delivered');
  ok(client.refunds.length === 0, 'nothing was refunded');
  ok(!/refund|owed to you|on its way back/i.test(text), 'and nothing about refunds was said');
}

console.log('\n[8] a payment with no pending task is still a tip, unchanged');
{
  const client = makeClient({ status: 'ok' });
  const state = freshState();
  await settlePayment(client, { transfer: transfer(3), state, rateLimit: new RateLimiter() });
  ok(client.refunds.length === 0, 'no refund attempted');
  ok(/tip/i.test(said(client)), 'thanked as a tip');
}

console.log(`\n  ${passed} passed, ${failed} failed`);
console.log(failed === 0
  ? '  ✅ ALL PASS — the agent only claims refunds it actually made.'
  : '  ❌ FAILURES — the agent can still misreport somebody\'s money.');
process.exit(failed === 0 ? 0 : 1);
