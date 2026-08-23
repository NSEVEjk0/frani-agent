/**
 * frani-agent — the autonomous loop
 * ────────────────────────────────────────────────────────────
 * Owner / Creator: Itachi
 * Made by CRYPTFRANI
 *
 * Ties the services together and keeps the agent alive:
 *   • publishes the market `service` intent
 *   • drains any transfers that arrived while offline, then fulfils them
 *   • reacts to events (message:dm, transfer:incoming, payment_request:incoming)
 *   • subscribes to the live market feed as a real-time accelerator
 *   • runs gentle periodic passes (concierge + a receive() safety-net)
 *
 * Everything is event-driven or slow-polled (45–90s) with awaited,
 * non-overlapping passes — no busy loops, tiny CPU/RAM footprint. The whole
 * loop unwinds cleanly when the AbortSignal fires.
 */

import config from './config.js';
import { createLogger } from './logger.js';
import { State, normalizeKey } from './state.js';
import { RateLimiter } from './ratelimit.js';
import { ensureServiceIntent, runConciergePass } from './services/concierge.js';
import { settlePayment, handleDm } from './services/paid-tasks.js';

const log = createLogger('agent');

const truncate = (s, n) => {
  const str = String(s ?? '').replace(/\s+/g, ' ').trim();
  return str.length > n ? `${str.slice(0, n - 1)}…` : str;
};

/**
 * Run `fn` every `ms`, non-overlapping (awaits each run before scheduling the
 * next), stopping cleanly on abort. Timers are NOT unref'd — they are what keep
 * the process alive for the lifetime of the loop.
 */
function every(ms, fn, signal, label) {
  let timer = null;
  let stopped = false;
  const stop = () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    timer = null;
  };
  const tick = async () => {
    if (stopped || signal.aborted) return;
    try {
      await fn();
    } catch (err) {
      log.error(`[${label}] pass error: ${err?.stack ?? err?.message ?? err}`);
    }
    if (stopped || signal.aborted) return;
    timer = setTimeout(tick, ms);
  };
  timer = setTimeout(tick, ms);
  signal.addEventListener('abort', stop, { once: true });
  return stop;
}

export async function startAgent(client, signal) {
  const state = State.load();
  const rateLimit = new RateLimiter();
  const sym = client.coin.symbol;
  const selfNorm = new Set([...client.selfPubkeys()].map(normalizeKey));

  log.info('──────────────────────────────────────────────');
  log.info(' frani-agent services starting');
  log.info(`   concierge   : every ${Math.round(config.intervals.searchPollMs / 1000)}s (proactive matchmaking)`);
  log.info(`   receive net : every ${Math.round(config.intervals.receivePollMs / 1000)}s (payment safety-net)`);
  log.info(`   paid tasks  : ${config.paidTasks.enabled ? `notarize + digest @ ${config.paidTasks.priceWhole} ${sym}` : 'disabled'}`);
  log.info(`   dry-run     : ${config.safety.dryRun}`);
  log.info(`   pending     : ${state.totalPendingTasks()} task(s) carried over`);
  log.info('──────────────────────────────────────────────');

  // ── handlers (closures over the loop state) ─────────────────────────────────
  async function onTransfer(transfer) {
    if (signal.aborted || !transfer?.id) return;
    if (!state.markTransferSeen(transfer.id)) return; // relay/receive() double-delivery
    state.save();
    try {
      await settlePayment(client, { transfer, state, rateLimit });
    } catch (err) {
      log.error(`transfer handler error: ${err?.stack ?? err?.message ?? err}`);
    }
  }

  async function onDm(dm) {
    if (signal.aborted || !dm?.id) return;
    if (selfNorm.has(normalizeKey(dm.senderPubkey))) return; // never talk to ourselves
    if (!state.markDmSeen(dm.id)) return; // dedup replays
    state.save();
    try {
      await handleDm(client, { dm, state, rateLimit });
    } catch (err) {
      log.error(`dm handler error: ${err?.stack ?? err?.message ?? err}`);
    }
  }

  async function onPaymentRequest(pr) {
    if (signal.aborted || !pr?.id) return;
    const who = pr.senderNametag ? `@${pr.senderNametag}` : pr.senderPubkey;
    let amt = '?';
    try {
      amt = client.toWhole(BigInt(pr.amount ?? '0'));
    } catch {
      /* leave as ? */
    }
    log.info(`Incoming payment request from ${who} for ${amt} ${sym} — declining (earn-only policy).`);
    if (config.safety.dryRun) return;
    try {
      await client.sphere.payments.requests.decline(pr.id);
    } catch (err) {
      log.warn(`Could not decline payment request ${pr.id}: ${err?.message ?? err}`);
    }
  }

  // Debounced concierge trigger — many feed events collapse into one pass.
  let conciergeTimer = null;
  let conciergeRunning = false;
  async function runConcierge(why) {
    if (conciergeRunning || signal.aborted) return;
    conciergeRunning = true;
    try {
      await runConciergePass(client, { state, rateLimit });
    } catch (err) {
      log.error(`concierge pass error [${why}]: ${err?.stack ?? err?.message ?? err}`);
    } finally {
      conciergeRunning = false;
    }
  }
  function scheduleConcierge(why) {
    if (conciergeTimer || signal.aborted) return;
    conciergeTimer = setTimeout(() => {
      conciergeTimer = null;
      void runConcierge(why);
    }, 5000);
  }

  function onFeed(msg) {
    if (signal.aborted || !msg) return;
    if (msg.type === 'initial') {
      log.info(`Live feed connected (${msg.listings?.length ?? 0} recent listing(s)).`);
      return;
    }
    if (msg.type === 'new' && msg.listing) {
      const l = msg.listing;
      if (config.concierge.watchIntentTypes.includes(l.type)) {
        log.info(`Feed: new ${l.type} "${truncate(l.title, 50)}" by ${l.agentName} — nudging concierge.`);
        scheduleConcierge('feed');
      }
    }
  }

  async function drainIncoming(why) {
    try {
      const { transfers } = await client.sphere.payments.receive();
      if (transfers?.length) log.info(`receive() surfaced ${transfers.length} transfer(s) [${why}].`);
      for (const t of transfers ?? []) await onTransfer(t);
    } catch (err) {
      log.warn(`receive() failed [${why}]: ${err?.message ?? err}`);
    }
  }

  // ── 1) publish our advert ────────────────────────────────────────────────────
  await ensureServiceIntent(client, state);

  // ── 2) settle anything that landed while we were offline ─────────────────────
  await drainIncoming('startup');

  // ── 3) subscribe to events ───────────────────────────────────────────────────
  const unsubs = [];
  try {
    unsubs.push(client.sphere.on('transfer:incoming', (t) => void onTransfer(t)));
    unsubs.push(client.sphere.on('message:dm', (dm) => void onDm(dm)));
    unsubs.push(client.sphere.on('payment_request:incoming', (pr) => void onPaymentRequest(pr)));
    log.info('Subscribed to transfer / DM / payment-request events.');
  } catch (err) {
    log.warn(`Event subscription issue: ${err?.message ?? err}`);
  }

  // ── 4) live market feed (real-time accelerator; periodic pass is the backbone)
  let feedUnsub = null;
  try {
    feedUnsub = client.sphere.market.subscribeFeed(onFeed);
  } catch (err) {
    log.warn(`Live feed unavailable (${err?.message ?? err}); relying on the periodic concierge pass.`);
  }

  // ── 5) gentle periodic passes ────────────────────────────────────────────────
  const stopConcierge = every(config.intervals.searchPollMs, () => runConcierge('timer'), signal, 'concierge');
  const stopReceive = every(config.intervals.receivePollMs, () => drainIncoming('poll'), signal, 'receive');

  // First proactive matchmaking pass shortly after boot (let the feed connect first).
  scheduleConcierge('startup');

  log.info('frani-agent is live. Ctrl-C to stop.');

  // ── stay alive until aborted, then unwind ────────────────────────────────────
  await new Promise((resolve) => {
    if (signal.aborted) return resolve();
    signal.addEventListener('abort', () => resolve(), { once: true });
  });

  log.info('Stopping services…');
  stopConcierge();
  stopReceive();
  if (conciergeTimer) clearTimeout(conciergeTimer);
  for (const u of unsubs) {
    try {
      u?.();
    } catch {
      /* ignore */
    }
  }
  try {
    feedUnsub?.();
  } catch {
    /* ignore */
  }
  state.save();
  log.info('Services stopped; state persisted.');
}

export default startAgent;
