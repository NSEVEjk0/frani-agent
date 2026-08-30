/**
 * frani-agent — `npm run demo`
 * ────────────────────────────────────────────────────────────
 * Owner / Creator: Itachi
 * Made by CRYPTFRANI
 *
 * A five-minute read of the one thing this agent does: it watches the market on
 * your behalf and meters the alerts against credit you paid in advance.
 *
 * This runs the REAL service module (`services/watchlist.js`), the real ledger
 * (`state.js`) and the real config against a fake network, so what you see below
 * is the live code path and not a script of what it would say. Nothing is
 * booted, nothing is claimed, no wallet is opened, no UCT moves — which also
 * means it is safe to run while the daemon is up, unlike `--whoami`.
 *
 * Two paths, because the interesting one is the second:
 *
 *   PATH A (happy) — a watch is set, the free allowance runs out, the next
 *   matches are HELD rather than handed over, one credit request goes into the
 *   account's wallet, they pay an amount that does not divide evenly, the held
 *   matches are released and the remainder stays as carry.
 *
 *   PATH B (failure) — the same request is DECLINED. This is where a custodial
 *   agent has to decide what to do with money it is holding. This one is holding
 *   none: the request is dropped, the watch pauses still holding its matches,
 *   the account is told it owes nothing, and any later payment resumes it from
 *   exactly that point. The counter printed at the end is the proof — across
 *   both paths, payments this agent attempted to send: 0.
 */

import config from './config.js';
import { State } from './state.js';
import { RateLimiter } from './ratelimit.js';
import {
  handleDm, runWatchPass, settleTopup, onBillUpdated, packPriceWhole,
} from './services/watchlist.js';

const DEC = 18;
const D = 10n ** BigInt(DEC);
const base = (whole) => (BigInt(Math.round(Number(whole) * 1e6)) * D) / 1_000_000n;
const SELF = `02${'a'.repeat(64)}`;
const BUYER = `02${'b'.repeat(64)}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rule = (t) => console.log(`\n\x1b[1m${'─'.repeat(74)}\n ${t}\n${'─'.repeat(74)}\x1b[0m`);
const beat = (t) => console.log(`\n\x1b[36m▸ ${t}\x1b[0m`);
const note = (t) => console.log(`\x1b[2m  ${t}\x1b[0m`);

/** A fake market whose supply the demo changes between passes. */
const market = { pool: [], async search() { return { intents: market.pool }; } };
let sendsAttempted = 0;

function listing(n, what) {
  return {
    id: `intent-${n}`,
    agentPublicKey: `02${String(n).padStart(2, '0').repeat(32)}`,
    agentNametag: `supplier-${n}`,
    intentType: 'sell',
    description: what,
    price: `${n} UCT`,
    score: 0.88,
  };
}

const client = {
  nametag: config.nametag,
  coin: { coinId: 'uct-coin-id', symbol: 'UCT', decimals: DEC },
  identity: { chainPubkey: SELF },
  selfPubkeys: () => new Set([SELF, SELF.slice(2)]),
  toBase: (whole) => base(whole),
  toWhole(b) {
    const v = BigInt(b);
    const frac = (v % D).toString().padStart(DEC, '0').replace(/0+$/, '');
    return `${v / D}${frac ? `.${frac}` : ''}`;
  },
  async sendDM(_to, content) {
    console.log(`\n  \x1b[32m@${config.nametag} → @buyer\x1b[0m`);
    for (const line of String(content).split('\n')) console.log(`  \x1b[32m│\x1b[0m ${line}`);
    return { id: 'dm' };
  },
  async requestPayment(_to, whole, memo) {
    console.log(`\n  \x1b[33m⇢ payment REQUEST placed in @buyer's wallet: ${whole} UCT\x1b[0m`);
    note(`memo: ${memo}`);
    note('their wallet decides. This agent cannot move their funds and cannot chase them.');
    return { success: true, requestId: 'req-demo' };
  },
  sphere: {
    market,
    payments: {
      // Present only so the demo can count. Nothing in src/ ever calls it —
      // `sphere-client.js` has no send wrapper at all.
      async send() { sendsAttempted++; return { status: 'ok' }; },
    },
  },
};

const dm = (text) => {
  console.log(`\n  \x1b[35m@buyer → @${config.nametag}\x1b[0m  ${text}`);
  return { id: `dm-${Math.random()}`, senderPubkey: BUYER, senderNametag: 'buyer', content: text };
};
const paid = (whole) => {
  console.log(`\n  \x1b[33m⇠ @buyer's wallet settles ${whole} UCT inbound\x1b[0m`);
  return { id: `t-${Math.random()}`, senderPubkey: BUYER, tokens: [{ coinId: 'uct-coin-id', amount: base(whole).toString() }] };
};

function ledger(state, sub) {
  const price = base(config.watch.alertPriceWhole);
  const w = sub.watches?.[0];
  console.log(
    `\n  \x1b[1mledger\x1b[0m  free left ${state.freeLeft(sub)}/${config.watch.freeAlerts}` +
      ` · credit ${client.toWhole(state.creditBase(sub))} UCT (= ${state.creditAlerts(sub, price)} alerts)` +
      ` · delivered ${sub.alertsDelivered}` +
      ` · held ${state.totalQueued(sub)}` +
      ` · bill ${sub.bill ? 'OPEN' : 'none'}` +
      ` · watch ${w ? (w.paused ? `PAUSED (${w.pausedReason})` : 'live') : '—'}`,
  );
}

export async function runDemo({ pace = 900 } = {}) {
  const state = new State({
    version: 2, serviceIntentId: null, servedIntentIds: [], seenDmIds: [], seenTransferIds: [],
    subscribers: {}, legacyTasks: [], legacyTasksRetired: true,
  });
  state.save = () => {}; // the demo touches no disk
  const rateLimit = new RateLimiter();

  console.log(`\n\x1b[1m@${config.nametag}\x1b[0m — standing market watches, metered on prepaid credit.`);
  console.log(`Owner: ${config.owner} · made by ${config.brand} · Unicity ${config.network}`);
  note(`${config.watch.freeAlerts} free alerts, then ${config.watch.alertPriceWhole} UCT each,`
    + ` sold ${config.watch.packAlerts} at a time (${packPriceWhole()} UCT a top-up).`);
  note('Fake market, real code. No wallet is opened and no UCT exists in here.');

  // ───────────────────────────── PATH A ─────────────────────────────────────
  rule('PATH A — the happy path: a watch, an allowance, a bill, a carry');

  beat('The buyer asks a free question first. Discovery is the product, so asking is free.');
  market.pool = [listing(1, 'dedicated GPU hours, hourly billing')];
  await handleDm(client, { dm: dm('find gpu hours'), state, rateLimit });
  await sleep(pace);

  beat('Now they set a standing watch. What is already live comes back with it, free —');
  note('those are marked seen, so the watch only ever fires on genuinely NEW supply.');
  await handleDm(client, { dm: dm('watch gpu hours for training runs'), state, rateLimit });
  const sub = state.peek(BUYER);
  ledger(state, sub);
  await sleep(pace);

  beat('Time passes. Two new suppliers list. Both alerts come out of the free allowance.');
  market.pool = [listing(1, 'dedicated GPU hours, hourly billing'),
    listing(2, 'A100 GPU hours, spot pricing'), listing(3, 'GPU cluster time, weekly blocks')];
  await runWatchPass(client, { state, rateLimit });
  ledger(state, sub);
  note('Allowance spent. Nothing has been asked of them yet.');
  await sleep(pace);

  beat('Two more list. One takes the last free alert — and the next is HELD, not sent.');
  note('This is the moment the design turns on. An agent that alerted first and invoiced');
  note('after would be handing over the paid product and then asking nicely. So the');
  note('match waits, and exactly one credit request goes out.');
  market.pool.push(listing(4, 'H100 GPU hours, reserved capacity'), listing(5, 'GPU hours, EU region'));
  await runWatchPass(client, { state, rateLimit });
  ledger(state, sub);
  await sleep(pace);

  beat('A third listing appears while the request is open. It is held too — and no second');
  note('request is raised. One open bill per account, ever.');
  market.pool.push(listing(6, 'GPU hours, bare metal'));
  await runWatchPass(client, { state, rateLimit });
  ledger(state, sub);
  await sleep(pace);

  beat(`They pay 1.7 UCT — not the ${packPriceWhole()} asked, and not a multiple of ${config.watch.alertPriceWhole}.`);
  note('A custodial agent would now owe them change. Watch what happens instead.');
  await settleTopup(client, { transfer: paid(1.7), state, rateLimit });
  ledger(state, sub);
  note(`Every held match released, and ${client.toWhole(state.creditBase(sub))} UCT sits as carry toward the next alert.`);
  note('That carry is the whole reason this agent has no refund path: an odd payment');
  note('is not an overpayment when the unit of account is base units.');
  await sleep(pace);

  // ───────────────────────────── PATH B ─────────────────────────────────────
  rule('PATH B — the failure path: the request is declined');

  beat('Fresh account, same story up to the bill: allowance spent, two matches held.');
  const state2 = new State({
    version: 2, serviceIntentId: null, servedIntentIds: [], seenDmIds: [], seenTransferIds: [],
    subscribers: {}, legacyTasks: [], legacyTasksRetired: true,
  });
  state2.save = () => {};
  const rl2 = new RateLimiter();
  market.pool = [];
  await handleDm(client, { dm: dm('watch rpc node capacity'), state: state2, rateLimit: rl2 });
  const sub2 = state2.peek(BUYER);
  market.pool = [listing(7, 'archive RPC node, 99.9% SLA'), listing(8, 'RPC endpoints, rate-limited free tier')];
  await runWatchPass(client, { state: state2, rateLimit: rl2 });
  market.pool.push(listing(9, 'dedicated RPC node, EU'), listing(10, 'RPC node with archive + traces'));
  await runWatchPass(client, { state: state2, rateLimit: rl2 });
  ledger(state2, sub2);
  await sleep(pace);

  beat('They decline it in their wallet. No answer is owed to me and none is coming.');
  note("The SDK reports it as payment_request:updated → 'rejected'. If it were never");
  note('answered at all, the TTL sweep would reach the same outcome — deliberately.');
  await onBillUpdated(client, { update: { id: 'req-demo', status: 'rejected' }, state: state2, rateLimit: rl2 });
  ledger(state2, sub2);
  note('Bill dropped. Watch paused. The held matches are still held. Nothing is owed.');
  await sleep(pace);

  beat('And a paused watch goes quiet — it does not keep alerting, and does not re-ask.');
  market.pool.push(listing(11, 'RPC node, bare metal, 10Gbps'));
  const quiet = await runWatchPass(client, { state: state2, rateLimit: rl2 });
  console.log(`\n  alerts sent this pass: ${quiet.alerted} · matches newly held: ${quiet.queued}`);
  await sleep(pace);

  beat('Weeks later they change their mind and just send 1 UCT. No command needed.');
  await settleTopup(client, { transfer: paid(1), state: state2, rateLimit: rl2 });
  ledger(state2, sub2);
  note('Resumed from exactly where it paused, holding exactly what it was holding.');

  // ───────────────────────────── the point ──────────────────────────────────
  rule('What the two paths have in common');
  console.log(`  Payments this agent attempted to send, across both paths: \x1b[1m${sendsAttempted}\x1b[0m`);
  console.log('  Not zero because a flag was off, or a guard held, or a floor was hit.');
  console.log('  Zero because `src/sphere-client.js` has no send method to call: this agent');
  console.log('  requests and receives, and the counterparty\'s own wallet decides. It cannot');
  console.log('  strand your funds, because it never takes custody of them.\n');
  console.log('  A sibling in the fleet holds custody on purpose — @frani-bounty escrows a');
  console.log('  reward until work is confirmed. This one is the other end of that trade-off.\n');
  return { sendsAttempted };
}
