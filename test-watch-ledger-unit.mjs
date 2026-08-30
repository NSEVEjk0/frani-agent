/**
 * test-watch-ledger-unit.mjs — offline proof of the alert-credit ledger.
 *
 * frani-agent meters discovery instead of selling it: every account gets a free
 * allowance of alerts, and after that alerts are drawn against prepaid credit
 * held in UCT BASE UNITS. That single design choice is what lets this agent have
 * no outbound payment rail at all, and this suite pins the three ways it could
 * quietly stop being true:
 *
 *   1. AN ALERT IS NEVER DELIVERED ON CREDIT THAT DOES NOT EXIST.
 *      `spendAlert()` returns null when the account can afford nothing, and a
 *      caller that ignores the return value hands out the paid product for free
 *      and then invoices for it. Matches with nothing to draw on must be HELD.
 *
 *   2. A TOP-UP REQUEST IS NEVER CLAIMED TO HAVE BEEN SENT UNLESS IT WAS.
 *      `payments.requests.create()` RESOLVES with {success:false} when the
 *      request could not be created — it does not throw. Announcing it anyway
 *      leaves someone waiting for a wallet prompt that does not exist while
 *      their matches go stale, and records a bill nobody can pay or decline.
 *
 *   3. NO AMOUNT OF INBOUND UCT EVER CREATES A DEBT.
 *      Odd top-ups, overpayments and transfers nobody asked for all become
 *      credit, because credit is denominated in base units and the remainder
 *      carries. If any path here ever needed to send money back, the agent could
 *      not do it: there is no send method. So the invariant is checked directly —
 *      the fake sphere records every send, and the count must stay at zero
 *      through every branch, including the ones that look like a refund's job.
 *
 * A declined or lapsed request is a complete answer: nothing is owed, the watch
 * pauses holding its matches, and a later top-up resumes it from exactly there.
 *
 * Offline: real State, real config, real watchlist service, fake sphere. No
 * network, no wallet, no funds.  Run:  node test-watch-ledger-unit.mjs
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'watchledger-'));
process.env.ENV_FILE = join(tmp, 'no-such.env');
process.env.WALLET_DIR = tmp;
process.env.LOG_LEVEL = 'error';
process.env.WATCH_FREE_ALERTS = '2';
process.env.WATCH_ALERT_PRICE = '0.5';
process.env.WATCH_PACK_ALERTS = '4';
process.env.WATCH_MAX_ALERTS_PER_PASS = '5';
process.env.WATCH_BILL_TTL_HOURS = '48';

const { default: config } = await import('./src/config.js');
const { State } = await import('./src/state.js');
const W = await import('./src/services/watchlist.js');
const { RateLimiter } = await import('./src/ratelimit.js');

const DEC = 18;
const D = 10n ** BigInt(DEC);
const base = (whole) => (BigInt(Math.round(Number(whole) * 1e6)) * D) / 1_000_000n;
const COIN = { coinId: 'uct-coin-id', symbol: 'UCT', decimals: DEC };
const SELF = '02' + 'a'.repeat(64);
const ALICE = '02' + 'b'.repeat(64);

let passed = 0, failed = 0;
const ok = (cond, msg, got) => {
  if (cond) { passed++; console.log(`  ✅ ${msg}`); }
  else { failed++; console.log(`  ❌ ${msg}${got !== undefined ? ` — got ${JSON.stringify(got)}` : ''}`); }
};

const listing = (n) => ({
  id: `intent-${n}`,
  agentPublicKey: '02' + String(n).padStart(2, '0').repeat(32),
  agentNametag: `seller${n}`,
  intentType: 'sell',
  description: `supply number ${n}`,
  score: 0.9,
});

/**
 * A fake client with the exact surface watchlist.js touches — and, pointedly, no
 * send. `sends` exists only so the suite can assert it stays empty.
 */
function makeClient({ requestOk = true } = {}) {
  const rec = { dms: [], requests: [], sends: [], declined: [] };
  const market = { pool: [], async search() { return { intents: market.pool }; } };
  const client = {
    nametag: 'frani-agent',
    coin: COIN,
    identity: { chainPubkey: SELF },
    selfPubkeys: () => new Set([SELF, SELF.slice(2)]),
    toBase: (whole) => base(whole),
    toWhole: (b) => {
      const v = BigInt(b);
      const int = v / D;
      const frac = (v % D).toString().padStart(DEC, '0').replace(/0+$/, '');
      return `${int}${frac ? `.${frac}` : ''}`;
    },
    async sendDM(to, content) { rec.dms.push({ to, content }); return { id: `dm-${rec.dms.length}` }; },
    async requestPayment(to, whole, memo) {
      rec.requests.push({ to, whole, memo });
      return requestOk
        ? { success: true, requestId: `req-${rec.requests.length}` }
        : { success: false, error: 'wallet-api unreachable' };
    },
    async declinePaymentRequest(id) { rec.declined.push(id); return { success: true }; },
    sphere: {
      market,
      payments: {
        // Present ONLY so the suite can prove nothing ever calls it.
        async send(args) { rec.sends.push(args); return { status: 'ok' }; },
      },
    },
  };
  return { client, rec, market };
}

const transfer = (from, whole) => ({
  id: `t-${Math.random().toString(36).slice(2, 8)}`,
  senderPubkey: from,
  tokens: [{ coinId: COIN.coinId, amount: base(whole).toString() }],
});

const dmFrom = (pubkey, content) => ({ id: `dm-${Math.random()}`, senderPubkey: pubkey, senderNametag: null, content });

const fresh = () => {
  const state = new State(JSON.parse(JSON.stringify({
    version: 2, serviceIntentId: null, servedIntentIds: [], seenDmIds: [], seenTransferIds: [],
    subscribers: {}, legacyTasks: [], legacyTasksRetired: false,
  })));
  state.save = () => {}; // keep the suite off the filesystem
  return state;
};
const lastDm = (rec) => rec.dms.at(-1)?.content ?? '';
const alerts = (rec) => rec.dms.filter((d) => d.content.startsWith('🔔'));

console.log('════════ alert-credit ledger proof (offline) ════════');
console.log(`   (${config.watch.freeAlerts} free alerts, ${config.watch.alertPriceWhole} UCT each, ` +
  `${config.watch.packAlerts} per top-up = ${W.packPriceWhole()} UCT)`);

console.log('\n[1] the free allowance is spent first, and nobody is asked for anything');
{
  const { client, rec, market } = makeClient();
  const state = fresh();
  const rl = new RateLimiter();
  await W.handleDm(client, { dm: dmFrom(ALICE, 'watch node hosting'), state, rateLimit: rl });
  const sub = state.peek(ALICE);
  ok(!!sub && sub.watches.length === 1, 'the watch is recorded', sub?.watches?.length);
  ok(rec.requests.length === 0, 'setting a watch costs nothing', rec.requests.length);

  market.pool = [listing(1), listing(2)];
  const r = await W.runWatchPass(client, { state, rateLimit: rl });
  ok(r.alerted === 2 && r.queued === 0, 'both matches are alerted from the free allowance', r);
  ok(state.freeLeft(sub) === 0, 'the allowance is now used up', state.freeLeft(sub));
  ok(state.creditBase(sub) === 0n, 'and no credit was touched — there is none', String(state.creditBase(sub)));
  ok(rec.requests.length === 0, 'still no payment request raised', rec.requests.length);
  ok(rec.sends.length === 0, 'and nothing was sent anywhere', rec.sends.length);
}

console.log('\n[2] PAST THE ALLOWANCE, A MATCH IS HELD — NOT DELIVERED AND BILLED AFTER');
{
  const { client, rec, market } = makeClient();
  const state = fresh();
  const rl = new RateLimiter();
  await W.handleDm(client, { dm: dmFrom(ALICE, 'watch gpu time'), state, rateLimit: rl });
  const sub = state.peek(ALICE);

  market.pool = [listing(1), listing(2)];
  await W.runWatchPass(client, { state, rateLimit: rl });
  const alertedFree = alerts(rec).length;

  market.pool = [listing(3), listing(4), listing(5)];
  const r = await W.runWatchPass(client, { state, rateLimit: rl });

  // The assertions that fail if the spendAlert() return value is ignored.
  ok(r.alerted === 0, 'nothing is alerted with no allowance and no credit', r.alerted);
  ok(r.queued === 3, 'all three matches are held instead', r.queued);
  ok(alerts(rec).length === alertedFree, 'no 🔔 alert DM went out for a held match', alerts(rec).length);
  ok(sub.alertsDelivered === config.watch.freeAlerts,
    'the delivered count did not move', sub.alertsDelivered);
  ok(state.creditBase(sub) === 0n, 'credit did not go negative', String(state.creditBase(sub)));
  ok(state.totalQueued(sub) === 3, 'the hold is visible in state', state.totalQueued(sub));

  ok(rec.requests.length === 1, 'exactly ONE top-up request is raised for the batch', rec.requests.length);
  ok(rec.requests[0].whole === W.packPriceWhole(),
    `for the pack price (${W.packPriceWhole()} UCT)`, rec.requests[0].whole);
  ok(!!sub.bill && sub.bill.requestId === 'req-1', 'and the bill is recorded against the account', sub.bill);
  ok(/holding/i.test(lastDm(rec)) && !/here (they|it) are/i.test(lastDm(rec)),
    'the DM says the matches are held, not that they are attached');

  // A second pass must not raise a second request for the same open bill.
  market.pool = [listing(6)];
  await W.runWatchPass(client, { state, rateLimit: rl });
  ok(rec.requests.length === 1, 'a later pass does not pile on a second request', rec.requests.length);
  ok(rec.sends.length === 0, 'and still nothing has been sent', rec.sends.length);
}

console.log('\n[3] A REQUEST THAT WAS NOT CREATED IS NEVER ANNOUNCED AS SENT');
{
  const { client, rec, market } = makeClient({ requestOk: false });
  const state = fresh();
  const rl = new RateLimiter();
  await W.handleDm(client, { dm: dmFrom(ALICE, 'watch storage'), state, rateLimit: rl });
  const sub = state.peek(ALICE);
  market.pool = [listing(1), listing(2)];
  await W.runWatchPass(client, { state, rateLimit: rl });
  market.pool = [listing(3)];
  await W.runWatchPass(client, { state, rateLimit: rl });

  // These fail if the {success:false} return value is treated as success.
  ok(sub.bill === null, 'no bill is recorded when create() reported failure', sub.bill);
  ok(!/I have sent a request/.test(lastDm(rec)),
    'the DM does not claim a request was sent to their wallet');
  ok(/could not/i.test(lastDm(rec)), 'it says plainly that it could not be raised');
  ok(/nothing is owed/i.test(lastDm(rec)), 'and that nothing is owed');
  ok(state.totalQueued(sub) === 1, 'the match stays held for the retry', state.totalQueued(sub));

  // With no bill on file the next pass is free to try again — that is the point.
  client.requestPayment = async (to, whole, memo) => {
    rec.requests.push({ to, whole, memo });
    return { success: true, requestId: 'req-late' };
  };
  market.pool = [listing(4)];
  await W.runWatchPass(client, { state, rateLimit: rl });
  ok(sub.bill?.requestId === 'req-late', 'the retry succeeds and is recorded', sub.bill);
}

console.log('\n[4] A TOP-UP CREDITS, RELEASES THE HOLD, AND LEAVES AN ODD CARRY');
{
  const { client, rec, market } = makeClient();
  const state = fresh();
  const rl = new RateLimiter();
  await W.handleDm(client, { dm: dmFrom(ALICE, 'watch bandwidth'), state, rateLimit: rl });
  const sub = state.peek(ALICE);
  market.pool = [listing(1), listing(2)];
  await W.runWatchPass(client, { state, rateLimit: rl });
  market.pool = [listing(3), listing(4)];
  await W.runWatchPass(client, { state, rateLimit: rl });
  ok(state.totalQueued(sub) === 2 && !!sub.bill, 'two held, one bill open', [state.totalQueued(sub), !!sub.bill]);

  // 1.7 UCT at 0.5/alert = 3 alerts with 0.2 left over. Not a round number on
  // purpose: the carry is the whole reason no refund is needed.
  market.pool = [listing(3), listing(4)]; // still live, so the release can describe them
  const res = await W.settleTopup(client, { transfer: transfer(ALICE, 1.7), state, rateLimit: rl });
  ok(res.credited === base(1.7), 'the full 1.7 UCT is credited', String(res.credited));
  ok(res.released === 2, 'both held matches are released', res.released);
  ok(sub.bill === null, 'the open bill is closed by the payment', sub.bill);
  ok(state.creditBase(sub) === base(0.7),
    '0.7 UCT of credit remains — 1.7 paid, 1.0 spent on the two releases', String(state.creditBase(sub)));
  ok(state.creditAlerts(sub, base(0.5)) === 1, 'which is one more alert, with 0.2 carried', state.creditAlerts(sub, base(0.5)));
  ok(state.totalQueued(sub) === 0, 'nothing is still held', state.totalQueued(sub));
  ok(rec.sends.length === 0, 'AND NOT ONE UCT WAS SENT BACK — the carry replaced the refund', rec.sends.length);
  ok(/credit/i.test(lastDm(rec)), 'the reply accounts for the credit');

  // Draw the last alert, then confirm the carry alone cannot buy one.
  market.pool = [listing(7), listing(8)];
  const r = await W.runWatchPass(client, { state, rateLimit: rl });
  ok(r.alerted === 1 && r.queued === 1,
    'exactly one more alert is affordable; the next is held', r);
  ok(state.creditBase(sub) === base(0.2), 'the 0.2 carry survives, unspent and unowed', String(state.creditBase(sub)));
}

console.log('\n[5] A DECLINE IS A COMPLETE ANSWER: NOTHING OWED, WATCH PAUSED, HOLD KEPT');
{
  const { client, rec, market } = makeClient();
  const state = fresh();
  const rl = new RateLimiter();
  await W.handleDm(client, { dm: dmFrom(ALICE, 'watch rpc nodes'), state, rateLimit: rl });
  const sub = state.peek(ALICE);
  market.pool = [listing(1), listing(2)];
  await W.runWatchPass(client, { state, rateLimit: rl });
  market.pool = [listing(3), listing(4)];
  await W.runWatchPass(client, { state, rateLimit: rl });
  const billId = sub.bill.requestId;

  const out = await W.onBillUpdated(client, { update: { id: billId, status: 'rejected' }, state, rateLimit: rl });
  ok(out.paused === 1, 'the watch is paused', out);
  ok(sub.bill === null, 'the bill is gone — it is not carried as a debt', sub.bill);
  ok(state.totalQueued(sub) === 2, 'the held matches are kept, not thrown away', state.totalQueued(sub));
  ok(/owe me nothing/i.test(lastDm(rec)), 'the DM states outright that nothing is owed');
  ok(rec.sends.length === 0, 'nothing was sent', rec.sends.length);

  // A paused watch stops working, and stops asking.
  market.pool = [listing(5), listing(6)];
  const r = await W.runWatchPass(client, { state, rateLimit: rl });
  ok(r.alerted === 0 && r.queued === 0, 'a paused watch neither alerts nor holds more', r);
  ok(rec.requests.length === 1, 'and never asks again on its own', rec.requests.length);

  // Any amount, any time, resumes from exactly here.
  market.pool = [listing(3), listing(4)];
  const res = await W.settleTopup(client, { transfer: transfer(ALICE, 1), state, rateLimit: rl });
  ok(res.resumed === 1, 'a later top-up resumes the paused watch', res);
  ok(res.released === 2, 'and releases the two matches it was still holding', res);
  ok(state.creditBase(sub) === 0n, '1 UCT bought exactly the two held alerts', String(state.creditBase(sub)));
  ok(rec.sends.length === 0, 'still no send, in any branch', rec.sends.length);
}

console.log('\n[6] AN UNANSWERED REQUEST LAPSES INTO THE SAME OUTCOME AS A DECLINE');
{
  const { client, rec, market } = makeClient();
  const state = fresh();
  const rl = new RateLimiter();
  await W.handleDm(client, { dm: dmFrom(ALICE, 'watch relays'), state, rateLimit: rl });
  const sub = state.peek(ALICE);
  market.pool = [listing(1), listing(2)];
  await W.runWatchPass(client, { state, rateLimit: rl });
  market.pool = [listing(3)];
  await W.runWatchPass(client, { state, rateLimit: rl });
  ok(!!sub.bill, 'a bill is open');

  ok(state.staleBills().length === 0, 'a fresh bill is not stale');
  sub.bill.createdAt = Date.now() - (config.watch.billTtlHours + 1) * 3_600_000;
  ok(state.staleBills().length === 1, 'past its TTL it is', state.staleBills().length);

  const out = await W.sweepBills(client, { state, rateLimit: rl });
  ok(out.lapsed === 1, 'the sweep closes it out', out);
  ok(sub.bill === null, 'no bill remains', sub.bill);
  ok(/lapsed/i.test(lastDm(rec)), 'and the wording is "lapsed", not "declined" — they never answered');
  ok(/owe me nothing/i.test(lastDm(rec)), 'nothing is owed either way');
  ok(state.totalQueued(sub) === 1, 'the held match survives for whenever they come back', state.totalQueued(sub));
}

console.log('\n[7] UCT NOBODY ASKED FOR BECOMES CREDIT, AND IS SAID TO BE');
{
  const { client, rec } = makeClient();
  const state = fresh();
  const rl = new RateLimiter();
  const res = await W.settleTopup(client, { transfer: transfer(ALICE, 3), state, rateLimit: rl });
  const sub = state.peek(ALICE);
  ok(res.credited === base(3), 'the transfer is credited in full', String(res.credited));
  ok(state.creditBase(sub) === base(3), 'to an account that did not exist a moment ago', String(state.creditBase(sub)));
  ok(rec.sends.length === 0, 'it is NOT returned — there is no rail to return it on', rec.sends.length);
  ok(/no way to send it back/i.test(lastDm(rec)), 'and the reply says exactly that, unprompted');
  ok(/do not expire/i.test(lastDm(rec)), 'plus that the credit does not expire');
}

console.log('\n[8] the invariant, restated as arithmetic');
{
  const { client, rec, market } = makeClient();
  const state = fresh();
  const rl = new RateLimiter();
  await W.handleDm(client, { dm: dmFrom(ALICE, 'watch anything'), state, rateLimit: rl });
  const sub = state.peek(ALICE);
  const price = base(config.watch.alertPriceWhole);

  for (let round = 1; round <= 6; round++) {
    market.pool = [listing(round * 10), listing(round * 10 + 1)];
    await W.runWatchPass(client, { state, rateLimit: rl });
    if (round === 3) await W.settleTopup(client, { transfer: transfer(ALICE, 1.25), state, rateLimit: rl });
  }

  const paid = BigInt(sub.paidBase);
  const spentOnAlerts = BigInt(Math.max(0, sub.alertsDelivered - config.watch.freeAlerts)) * price;
  ok(sub.alertsDelivered <= config.watch.freeAlerts + Number(paid / price),
    'alerts delivered never exceed free allowance + what was paid for',
    [sub.alertsDelivered, config.watch.freeAlerts, Number(paid / price)]);
  ok(state.creditBase(sub) === paid - spentOnAlerts,
    'credit remaining == paid in − spent on alerts, exactly',
    [String(state.creditBase(sub)), String(paid - spentOnAlerts)]);
  ok(state.creditBase(sub) >= 0n, 'and credit is never negative', String(state.creditBase(sub)));
  ok(rec.sends.length === 0, 'across every branch of this suite, sends attempted: 0', rec.sends.length);
}

console.log('\n[9] the free surface stays free, and unwinding costs nothing');
{
  const { client, rec, market } = makeClient();
  const state = fresh();
  const rl = new RateLimiter();
  market.pool = [listing(1), listing(2), listing(3)];
  for (const cmd of ['help', 'about', 'status', 'find gpu time', 'watches']) {
    await W.handleDm(client, { dm: dmFrom(ALICE, cmd), state, rateLimit: rl });
  }
  ok(rec.requests.length === 0, 'none of help/about/status/find/watches raises a request', rec.requests.length);
  ok(/no outbound payment rail|cannot send/i.test(rec.dms[1].content),
    '`about` states the no-send policy in writing');
  ok(/free/i.test(rec.dms[0].content), '`help` says the allowance is free');

  await W.handleDm(client, { dm: dmFrom(ALICE, 'watch gpu time'), state, rateLimit: rl });
  const sub = state.peek(ALICE);
  // The three listings that were already live were handed over with the watch
  // itself and marked seen, so a standing watch only ever bills for genuinely
  // NEW supply — never for a backlog the account could have found with `find`.
  ok(sub.freeUsed === 0, 'the listings live at watch time cost no allowance', sub.freeUsed);
  const quiet = await W.runWatchPass(client, { state, rateLimit: rl });
  ok(quiet.alerted === 0 && quiet.queued === 0, 'and are not re-alerted on the next pass', quiet);

  market.pool = [listing(4), listing(5), listing(6), listing(7)];
  await W.runWatchPass(client, { state, rateLimit: rl });
  ok(!!sub.bill, 'a bill is open before the unwatch', sub.bill);
  await W.handleDm(client, { dm: dmFrom(ALICE, 'unwatch all'), state, rateLimit: rl });
  ok(sub.watches.length === 0, 'unwatch all drops the watches', sub.watches.length);
  ok(sub.bill === null, 'and closes the open request — walking away is free', sub.bill);
  ok(rec.sends.length === 0, 'with nothing sent', rec.sends.length);
}

console.log(`\n════════ ${passed} passed, ${failed} failed ════════`);
process.exit(failed === 0 ? 0 : 1);
