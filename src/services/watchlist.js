/**
 * frani-agent — standing watches + the DM command surface
 * ────────────────────────────────────────────────────────────
 * Owner / Creator: Itachi
 * Made by CRYPTFRANI
 *
 * Discovery is the product. A `watch` is a standing want: the agent re-runs it
 * against the Unicity market on every sweep and DMs an alert the first time a
 * new intent matches it. One new matching intent delivered = one alert.
 *
 * DM grammar (case-insensitive first word):
 *   free  : help | about | status | find <query> | watches | unwatch <n|all>
 *   watch : watch <query>   → a standing want, alerted as the market changes
 *   metered: topup          → re-send the open alert-credit request
 *
 * How alerts are paid for, and why there is no refund in this file:
 *   • Every account gets a free allowance of alerts, so you see the product
 *     working before you are ever asked for anything.
 *   • After that an alert is drawn against prepaid credit held in UCT base
 *     units. When the allowance and the credit are both gone the agent QUEUES
 *     the match and raises ONE payment request. You pay it from your own wallet
 *     or you decline it — the agent never pulls, never holds an escrow, and
 *     never sends UCT anywhere, because it has no outbound rail at all.
 *   • A top-up that does not divide evenly by the alert price leaves the
 *     remainder as credit toward the next alert. That is the whole reason no
 *     refund is needed: an overpayment has somewhere honest to go.
 *   • Decline, and nothing is owed. The watch pauses holding its matches, and
 *     resumes the moment credit exists again.
 */

import { randomUUID } from 'node:crypto';

import { coinIdsMatch } from '@unicitylabs/sphere-sdk';

import config from '../config.js';
import { createLogger } from '../logger.js';
import { searchSupply, formatShortlist } from './concierge.js';

const log = createLogger('watch');

const sym = () => config.coinSymbol;
const truncate = (s, n) => {
  const str = String(s ?? '').replace(/\s+/g, ' ').trim();
  return str.length > n ? `${str.slice(0, n - 1)}…` : str;
};

// Markers our own outbound messages start with — so an echoed banner (ours or
// another agent's) never gets parsed as a command and loops.
const OUR_MARKERS = ['🤖', '🔔', '🔎', '👋', '📡', '🧾'];

const DAY_MS = 86_400_000;

function recipientOf(dm) {
  return dm.senderNametag ? `@${dm.senderNametag}` : dm.senderPubkey;
}

function recipientFor(key, sub) {
  return sub?.nametag ? `@${sub.nametag}` : key;
}

function underCaps(rateLimit) {
  return (
    rateLimit.peek('dm', config.safety.maxDmsPerHour) &&
    rateLimit.peek('action', config.safety.maxActionsPerHour)
  );
}
function noteSend(rateLimit) {
  rateLimit.record('dm');
  rateLimit.record('action');
}

async function replyFree(client, dm, rateLimit, body) {
  if (!underCaps(rateLimit)) {
    log.warn(`Rate cap reached — dropping free reply to ${recipientOf(dm)}.`);
    return;
  }
  noteSend(rateLimit);
  await client.sendDM(recipientOf(dm), body);
}

// ── pricing helpers (exact base-unit math) ───────────────────────────────────
export function alertPriceBase(client) {
  return client.toBase(config.watch.alertPriceWhole);
}

/** The whole-UCT amount one top-up request asks for. */
export function packPriceWhole() {
  return Number((config.watch.alertPriceWhole * config.watch.packAlerts).toFixed(6));
}

/** How the account currently stands, in the words `status` uses. */
export function fundingLine(client, state, sub) {
  const free = state.freeLeft(sub);
  const credit = state.creditBase(sub);
  const alerts = state.creditAlerts(sub, alertPriceBase(client));
  const parts = [];
  if (free > 0) parts.push(`${free} free alert${free === 1 ? '' : 's'} left`);
  parts.push(`${client.toWhole(credit)} ${sym()} credit (${alerts} alert${alerts === 1 ? '' : 's'})`);
  return parts.join(' · ');
}

// ── static copy ──────────────────────────────────────────────────────────────
function helpText(client) {
  const tag = client.nametag ?? 'frani-agent';
  return [
    `🤖 @${tag} — market discovery on Unicity testnet2 (by ${config.brand}, owner ${config.owner})`,
    ``,
    `I watch the market so you don't have to.`,
    ``,
    `  find <query>     one free ranked look at what is live right now`,
    `  watch <query>    a STANDING want — I alert you when something new matches`,
    `  watches          your standing watches`,
    `  unwatch <n|all>  drop one (or all) of them`,
    `  status           your alerts, credit and any open request`,
    `  topup            re-send the open alert-credit request`,
    `  help · about`,
    ``,
    `Alerts: your first ${config.watch.freeAlerts} are free. After that an alert costs`,
    `${config.watch.alertPriceWhole} ${sym()}, drawn from prepaid credit. When you run out I hold your`,
    `matches and send ONE request for ${packPriceWhole()} ${sym()} (${config.watch.packAlerts} alerts). Pay it and the held`,
    `matches arrive; decline it and nothing is owed — the watch just pauses.`,
    ``,
    `I have no outbound payment rail: I cannot send ${sym()} to anyone, which is why`,
    `credit carries over instead of being refunded. — ${config.brand}`,
  ].join('\n');
}

function aboutText(client) {
  const tag = client.nametag ?? 'frani-agent';
  return [
    `🤖 @${tag} is an autonomous discovery agent on the Unicity testnet2 network.`,
    `Owner / creator: ${config.owner}. Made by ${config.brand}.`,
    ``,
    `What I do, and only this: I read the market — the live feed plus semantic`,
    `search — and I put the right intent in front of the right person. Free and`,
    `unprompted, I DM buyers a shortlist when I spot supply that matches what they`,
    `posted. On request I hold a STANDING watch and alert you as the market moves.`,
    ``,
    `Money policy — REQUEST-ONLY, and stricter than earn-only: this agent has no`,
    `outbound payment code path at all. It cannot send ${sym()}, so it cannot`,
    `double-pay, cannot be drained, and cannot hold your funds pending anything.`,
    `What it can do is ask: alerts past the free allowance are drawn from prepaid`,
    `credit, and a top-up you never answer simply lapses.`,
    ``,
    `Because I cannot send funds back, ${sym()} that arrives here becomes alert`,
    `credit — including an overpayment, and including a transfer I never asked for.`,
    `Credit does not expire. Reply \`help\` for the commands. — ${config.brand}`,
  ].join('\n');
}

// ── watch management (DM commands) ───────────────────────────────────────────
async function cmdWatch(client, { dm, arg, state, rateLimit }) {
  if (!config.watch.enabled) {
    return replyFree(client, dm, rateLimit, `Standing watches are switched off right now — \`find <query>\` still works, free. — ${config.brand}`);
  }
  if (!arg) {
    return replyFree(
      client,
      dm,
      rateLimit,
      `Usage: \`watch <what you are after>\` — e.g. \`watch node hosting for an agent\`.\n` +
        `I re-check the market and alert you when something NEW matches. First ${config.watch.freeAlerts} alerts free. — ${config.brand}`,
    );
  }
  const sub = state.subscriber(dm.senderPubkey, dm.senderNametag ?? undefined);
  const query = truncate(arg, 160);

  // Same query twice = renew, not duplicate.
  const existing = (sub.watches ?? []).find((w) => w.query.toLowerCase() === query.toLowerCase());
  if (existing) {
    existing.expiresAt = Date.now() + config.watch.expiresInDays * DAY_MS;
    existing.paused = false;
    existing.pausedReason = null;
    state.save();
    return replyFree(
      client,
      dm,
      rateLimit,
      `📡 Already watching "${query}" — renewed for another ${config.watch.expiresInDays} days.\n${fundingLine(client, state, sub)} — ${config.brand}`,
    );
  }

  const live = (sub.watches ?? []).length;
  if (live >= config.watch.maxPerAccount) {
    return replyFree(
      client,
      dm,
      rateLimit,
      `You already hold ${live} watch${live === 1 ? '' : 'es'}, which is my per-account limit.\n` +
        `\`watches\` lists them, \`unwatch <n>\` frees a slot. — ${config.brand}`,
    );
  }

  const watch = state.addWatch(sub, {
    id: randomUUID().slice(0, 8),
    query,
    createdAt: Date.now(),
    expiresAt: Date.now() + config.watch.expiresInDays * DAY_MS,
    paused: false,
    pausedReason: null,
    alertsSent: 0,
    seen: [],
    queued: [],
  });
  state.save();

  // Seed it immediately from what is already live, so the first alert is not a
  // promise about the future. Anything surfaced now is marked seen, so the
  // standing watch only ever fires on genuinely new listings after this.
  const seeded = await searchSupply(client, query, { limit: config.concierge.shortlistSize });
  for (const m of seeded) state.markWatchSeen(watch, m.id);
  state.save();

  const head = `📡 Watching "${query}" for ${config.watch.expiresInDays} days (watch ${watch.id}).`;
  const body = seeded.length
    ? `${head}\n\nLive right now — yours free, this does not touch your allowance:\n${formatShortlist(seeded)}\n\n` +
      `From here I only speak up when something NEW matches. ${fundingLine(client, state, sub)} — ${config.brand}`
    : `${head}\n\nNothing matches yet — that is exactly what a watch is for. I will DM you the moment it does.\n` +
      `${fundingLine(client, state, sub)} — ${config.brand}`;
  return replyFree(client, dm, rateLimit, body);
}

function watchesText(client, state, sub) {
  const list = sub.watches ?? [];
  if (list.length === 0) return `No standing watches. Start one with \`watch <query>\`. — ${config.brand}`;
  const lines = list.map((w, i) => {
    const age = Math.max(0, Math.round((Date.now() - (w.createdAt ?? Date.now())) / 3_600_000));
    const left = Math.max(0, Math.round(((w.expiresAt ?? Date.now()) - Date.now()) / DAY_MS));
    const flags = [
      `${w.alertsSent ?? 0} alert${(w.alertsSent ?? 0) === 1 ? '' : 's'}`,
      `${left}d left`,
      ...(w.queued?.length ? [`${w.queued.length} held`] : []),
      ...(w.paused ? [`PAUSED (${w.pausedReason ?? 'paused'})`] : []),
    ];
    return `${i + 1}. "${truncate(w.query, 70)}" — ${flags.join(' · ')} [${w.id}], set ${age}h ago`;
  });
  return `📡 Your standing watches:\n${lines.join('\n')}\n\n${fundingLine(client, state, sub)} — ${config.brand}`;
}

function statusText(client, state, sub) {
  const list = sub.watches ?? [];
  const lines = [
    `📡 @${client.nametag ?? 'frani-agent'} — your standing with me`,
    ``,
    `watches   : ${list.length}/${config.watch.maxPerAccount}${list.some((w) => w.paused) ? ' (some paused)' : ''}`,
    `alerts    : ${sub.alertsDelivered ?? 0} delivered to you so far`,
    `funding   : ${fundingLine(client, state, sub)}`,
    `held      : ${state.totalQueued(sub)} match(es) waiting on credit`,
  ];
  if (sub.bill) {
    const hrs = Math.round((Date.now() - (sub.bill.createdAt ?? Date.now())) / 3_600_000);
    lines.push(
      `open req  : ${client.toWhole(BigInt(sub.bill.amountBase))} ${sym()} for ${sub.bill.alerts} alerts, sent ${hrs}h ago` +
        ` — lapses after ${config.watch.billTtlHours}h`,
    );
  } else {
    lines.push(`open req  : none — you owe me nothing`);
  }
  lines.push('', `\`watches\` for the list, \`watch <query>\` to add one. — ${config.brand}`);
  return lines.join('\n');
}

// ── the metered path: raise ONE request, claim nothing that did not happen ────
/**
 * Ask an account to top up its alert credit.
 *
 * `requestPayment` RESOLVES with `{success:false, error}` when the request could
 * not be created — it does not throw. If we told the account "I've sent you a
 * request" off the back of that, they would sit waiting for a wallet prompt that
 * does not exist while their matches went stale. So the bill is only recorded,
 * and only announced, when the SDK actually confirms the request. Otherwise we
 * say so plainly and retry on the next sweep.
 */
export async function raiseTopup(client, { key, sub, state, rateLimit, heldCount }) {
  if (sub.bill) return { already: true, bill: sub.bill };
  const recipient = recipientFor(key, sub);
  const whole = packPriceWhole();
  const amountBase = client.toBase(whole);

  if (config.safety.dryRun) {
    log.warn(`[DRY_RUN] Would request ${whole} ${sym()} of alert credit from ${recipient}.`);
    return { dryRun: true };
  }

  const res = await client.requestPayment(recipient, whole, `frani-agent alert credit (${config.watch.packAlerts} alerts)`);
  if (!res?.success) {
    const why = res?.error ?? 'the request was not accepted';
    log.error(`Could not raise the alert-credit request for ${recipient}: ${why}. Not claiming one was sent.`);
    noteSend(rateLimit);
    await client.sendDM(
      recipient,
      `🧾 Your watch matched ${heldCount} new intent(s), which is past your free allowance — but I could not put an ` +
        `alert-credit request in your wallet just now (${why}), so please do not go looking for one. ` +
        `Your matches are held and I will try again on the next sweep. Nothing is owed. — ${config.brand}`,
    );
    return { ok: false, why };
  }

  const bill = state.setBill(sub, {
    requestId: res.requestId ?? null,
    amountBase: amountBase.toString(),
    alerts: config.watch.packAlerts,
    createdAt: Date.now(),
  });
  state.save();
  noteSend(rateLimit);
  await client.sendDM(
    recipient,
    `🧾 Your watch matched ${heldCount} new intent(s) — that is past your free allowance, so I am holding them.\n\n` +
      `I have sent a request for ${whole} ${sym()} to your wallet: ${config.watch.packAlerts} alerts at ` +
      `${config.watch.alertPriceWhole} ${sym()} each. Pay it and the held matches arrive immediately, and the credit ` +
      `keeps drawing down as the market moves.\n\n` +
      `Decline it and NOTHING is owed — the watch pauses and I stop asking. I cannot pull funds and I cannot send ` +
      `them back, so the only thing that ever happens here is a request you choose to answer. — ${config.brand}`,
  );
  log.info(`Raised a ${whole} ${sym()} alert-credit request for ${recipient} (${heldCount} held).`);
  return { ok: true, bill };
}

// ── the sweep: run every standing watch ──────────────────────────────────────
/**
 * One pass over every live watch. Returns counters for the log line.
 *
 * Ordering matters: a match is only marked seen once it has been either
 * delivered or queued. If neither is possible (the hold is full) it is left
 * unmarked so a later sweep can still surface it, rather than being silently
 * consumed.
 */
export async function runWatchPass(client, { state, rateLimit }) {
  if (!config.watch.enabled) return { alerted: 0, queued: 0 };

  const lapsed = state.reapExpiredWatches();
  for (const { key, sub, watch } of lapsed) {
    log.info(`Watch ${watch.id} ("${truncate(watch.query, 40)}") lapsed for ${recipientFor(key, sub)}.`);
    if (underCaps(rateLimit)) {
      noteSend(rateLimit);
      await client.sendDM(
        recipientFor(key, sub),
        `📡 Your watch on "${truncate(watch.query, 80)}" has reached its ${config.watch.expiresInDays}-day limit and ` +
          `stopped. It sent you ${watch.alertsSent ?? 0} alert(s). Any credit you have is untouched — ` +
          `\`watch <query>\` starts it again. — ${config.brand}`,
      );
    }
  }
  if (lapsed.length) state.save();

  const priceBase = alertPriceBase(client);
  let alerted = 0;
  let queued = 0;
  const perAccount = new Map(); // key -> alerts sent this pass

  for (const { key, sub, watch } of state.liveWatches()) {
    if (watch.paused) continue;
    const already = perAccount.get(key) ?? 0;
    if (already >= config.watch.maxAlertsPerPass) continue;

    let matches;
    try {
      matches = await searchSupply(client, watch.query, { limit: config.watch.maxAlertsPerPass * 2 });
    } catch (err) {
      log.warn(`watch ${watch.id} search failed: ${err?.message ?? err}`);
      continue;
    }

    const fresh = matches.filter((m) => m?.id && !(watch.seen ?? []).includes(m.id));
    if (fresh.length === 0) continue;

    const deliver = [];
    let held = 0;
    for (const m of fresh) {
      if (deliver.length + already >= config.watch.maxAlertsPerPass) break;
      const spend = state.spendAlert(sub, priceBase);
      if (spend) {
        state.markWatchSeen(watch, m.id);
        deliver.push(m);
        continue;
      }
      // Nothing to draw on — hold it, do not deliver on credit that isn't there.
      if ((watch.queued?.length ?? 0) >= config.watch.maxQueuedPerWatch) break;
      state.queue(watch, { id: m.id, at: Date.now() });
      state.markWatchSeen(watch, m.id);
      held++;
    }

    if (deliver.length) {
      watch.alertsSent = (watch.alertsSent ?? 0) + deliver.length;
      state.save();
      noteSend(rateLimit);
      await client.sendDM(
        recipientFor(key, sub),
        `🔔 ${deliver.length} new match${deliver.length === 1 ? '' : 'es'} on your watch "${truncate(watch.query, 70)}":\n` +
          `${formatShortlist(deliver)}\n\n` +
          `${fundingLine(client, state, sub)} · \`unwatch ${watch.id}\` to stop. — ${config.brand}`,
      );
      alerted += deliver.length;
      perAccount.set(key, already + deliver.length);
      log.info(`Watch ${watch.id} → ${recipientFor(key, sub)}: ${deliver.length} alert(s).`);
    }

    if (held) {
      queued += held;
      state.save();
      await raiseTopup(client, { key, sub, state, rateLimit, heldCount: state.totalQueued(sub) });
    }
  }

  if (alerted || queued) log.info(`Watch pass: ${alerted} alert(s) delivered, ${queued} held for credit.`);
  return { alerted, queued };
}

// ── inbound UCT: the only money direction this agent has ─────────────────────
function uctAmount(client, transfer) {
  return (transfer.tokens ?? [])
    .filter((t) => coinIdsMatch(t.coinId, client.coin.coinId))
    .reduce((acc, t) => acc + BigInt(t.amount ?? '0'), 0n);
}

/**
 * Credit an incoming transfer as alert credit and release whatever was held.
 *
 * Every amount is creditable — short, exact or over. There is no under/over
 * branch here at all, which is the point: credit is denominated in base units,
 * so a payment that does not divide evenly by the alert price simply leaves a
 * carry. Nothing has to be sent back, so nothing can fail to be sent back.
 */
export async function settleTopup(client, { transfer, state, rateLimit }) {
  const amountBase = uctAmount(client, transfer);
  if (amountBase <= 0n) return { credited: 0n };

  const sender = transfer.senderPubkey;
  const knew = !!state.peek(sender);
  const sub = state.subscriber(sender, transfer.senderNametag ?? undefined);
  const recipient = recipientFor(sender, sub);
  const priceBase = alertPriceBase(client);

  const hadBill = !!sub.bill;
  state.addCredit(sub, amountBase);
  state.clearBill(sub);

  // Anything paused purely for want of credit comes back to life.
  let resumed = 0;
  for (const w of sub.watches ?? []) {
    if (w.paused && w.pausedReason === 'awaiting-credit') {
      w.paused = false;
      w.pausedReason = null;
      resumed++;
    }
  }
  state.save();

  const alerts = state.creditAlerts(sub, priceBase);
  log.info(
    `Credited ${client.toWhole(amountBase)} ${sym()} from ${recipient} as alert credit ` +
      `(${alerts} alert(s) available${hadBill ? ', open request closed' : ''}).`,
  );

  // Release the held matches, paying for them out of the credit just received.
  const released = [];
  for (const w of sub.watches ?? []) {
    const q = w.queued ?? [];
    if (q.length === 0) continue;
    const ids = [];
    while (q.length) {
      const spend = state.spendAlert(sub, priceBase);
      if (!spend) break; // credit ran out mid-release — the rest stays held
      ids.push(q.shift().id);
    }
    if (ids.length) {
      w.alertsSent = (w.alertsSent ?? 0) + ids.length;
      released.push({ watch: w, ids });
    }
  }
  state.save();

  const bodyParts = [];
  if (!knew && !hadBill) {
    // Unsolicited. We cannot return it — say exactly that, and say where it went.
    bodyParts.push(
      `🧾 Thanks for the ${client.toWhole(amountBase)} ${sym()}. I never asked for it and I have no way to send it ` +
        `back — this agent has no outbound payment rail — so I have turned it into alert credit in your name: ` +
        `${alerts} alert(s), which do not expire. Set one up with \`watch <query>\` and I will start drawing on it.`,
    );
  } else {
    bodyParts.push(
      `🧾 ${client.toWhole(amountBase)} ${sym()} received — credited as ${alerts} alert(s) at ` +
        `${config.watch.alertPriceWhole} ${sym()} each. Anything that did not divide evenly stays as credit toward ` +
        `your next alert; I never send ${sym()} back because I never need to.`,
    );
  }
  if (resumed) bodyParts.push(`${resumed} paused watch${resumed === 1 ? '' : 'es'} resumed.`);

  if (released.length) {
    for (const { watch, ids } of released) {
      const detail = await describeHeld(client, watch, ids);
      bodyParts.push(`🔔 Released ${ids.length} held match${ids.length === 1 ? '' : 'es'} on "${truncate(watch.query, 70)}":\n${detail}`);
    }
  }
  bodyParts.push(`${fundingLine(client, state, sub)} — ${config.brand}`);

  noteSend(rateLimit);
  await client.sendDM(recipient, bodyParts.join('\n\n'));
  return { credited: amountBase, released: released.reduce((n, r) => n + r.ids.length, 0), resumed };
}

/**
 * Re-describe held matches at release time rather than at hold time. A listing
 * can expire while it waits, and handing someone a stale contact they paid for
 * is worse than telling them it went. Only the intent id was held, so this is
 * always the market's current answer.
 */
async function describeHeld(client, watch, ids) {
  let live = [];
  try {
    live = await searchSupply(client, watch.query, { limit: Math.max(ids.length * 2, 6) });
  } catch {
    /* fall through to the honest "cannot re-read" line */
  }
  const byId = new Map(live.map((m) => [m.id, m]));
  const still = ids.map((id) => byId.get(id)).filter(Boolean);
  const gone = ids.length - still.length;
  const lines = [];
  if (still.length) lines.push(formatShortlist(still));
  if (gone > 0) {
    lines.push(
      `(${gone} of them is no longer live — it lapsed while the credit request was open. ` +
        `Those alerts are not charged for again, and your watch keeps running.)`,
    );
  }
  return lines.join('\n') || `(none of the held listings are live any more — your watch keeps running.)`;
}

// ── a request we raised was answered, or was not ─────────────────────────────
/**
 * `payment_request:updated` for one of OUR requests. `rejected` and `expired`
 * both mean the same thing economically — nobody owes anything — but they are
 * reported separately because "you said no" and "you never saw it" deserve
 * different words.
 */
export async function onBillUpdated(client, { update, state, rateLimit }) {
  const status = String(update?.status ?? '');
  if (status !== 'rejected' && status !== 'expired') return { ignored: status };
  const found = state.findBill(update.id);
  if (!found) return { ignored: 'not one of ours' };

  const { key, sub, bill } = found;
  state.clearBill(sub);
  let paused = 0;
  for (const w of sub.watches ?? []) {
    if ((w.queued?.length ?? 0) > 0 && !w.paused) {
      w.paused = true;
      w.pausedReason = 'awaiting-credit';
      paused++;
    }
  }
  state.save();

  const recipient = recipientFor(key, sub);
  const held = state.totalQueued(sub);
  log.info(`Alert-credit request ${status} by ${recipient} — ${paused} watch(es) paused, nothing owed.`);
  noteSend(rateLimit);
  await client.sendDM(
    recipient,
    `🧾 Your alert-credit request for ${client.toWhole(BigInt(bill.amountBase))} ${sym()} was ` +
      `${status === 'rejected' ? 'declined' : 'left unanswered and has lapsed'} — that is a complete answer and ` +
      `you owe me nothing, now or later.\n\n` +
      `${paused ? `${paused} watch${paused === 1 ? '' : 'es'} ` : 'Your watch '}` +
      `${paused === 1 || !paused ? 'is' : 'are'} paused${held ? `, still holding ${held} match(es)` : ''}. ` +
      `Send any amount of ${sym()} whenever you like and I will resume from exactly here — or \`unwatch all\` and ` +
      `I will stop entirely. \`find <query>\` stays free either way. — ${config.brand}`,
  );
  return { status, paused, held };
}

/** Open requests nobody answered inside the TTL. Same treatment as a decline. */
export async function sweepBills(client, { state, rateLimit }) {
  const stale = state.staleBills();
  for (const { key, sub, bill } of stale) {
    await onBillUpdated(client, {
      update: { id: bill.requestId ?? bill.id, status: 'expired' },
      state,
      rateLimit,
    });
    log.info(`Alert-credit request for ${recipientFor(key, sub)} timed out after ${config.watch.billTtlHours}h.`);
  }
  return { lapsed: stale.length };
}

// ── one-time cleanup of the retired paid-task shop ───────────────────────────
/**
 * v1 of this agent sold `notarize` and `digest` over DM. Those are gone: they
 * were thin, and one of them duplicated a sibling agent's whole product. An
 * unpaid v1 request means the requester was told a result was coming and then
 * the shop closed under them. Nobody was charged — a task only ever became
 * pending BEFORE its payment request was answered — but silence would still be
 * the wrong ending, so each requester hears once, and only once.
 */
export async function retireLegacyTasks(client, { state, rateLimit }) {
  const owed = state.legacyTasksToRetire();
  if (owed.length === 0) return { notified: 0 };

  const byKey = new Map();
  for (const t of owed) {
    const entry = byKey.get(t.key) ?? { kinds: [], nametag: t.nametag };
    entry.kinds.push(t.kind);
    byKey.set(t.key, entry);
  }

  let notified = 0;
  for (const [key, entry] of byKey) {
    const recipient = entry.nametag ? `@${entry.nametag}` : key;
    const what = entry.kinds.length === 1 ? `a \`${entry.kinds[0]}\` request` : `${entry.kinds.length} paid requests`;
    noteSend(rateLimit);
    await client.sendDM(
      recipient,
      `🤖 A while back you sent me ${what} and I replied with a payment request. I have retired that paid-task ` +
        `shop — it was never the point of this agent — so that request will not be filled and its payment request, ` +
        `if it is still open in your wallet, can be declined. You were never charged: I only ever fulfil AFTER ` +
        `payment, and no payment arrived.\n\n` +
        `What I do now is discovery, and the free part got better: \`find <query>\` for a ranked look at the live ` +
        `market, \`watch <query>\` for a standing want I alert you about as things change (first ` +
        `${config.watch.freeAlerts} alerts free). — ${config.brand}`,
    );
    notified++;
    log.info(`Sent the retired-shop notice to ${recipient}.`);
  }
  state.markLegacyRetired();
  state.save();
  return { notified };
}

// ── DM dispatch ──────────────────────────────────────────────────────────────
/**
 * Parse and act on one incoming DM. Callers must already have de-duplicated the
 * message id and confirmed it is not from ourselves.
 */
export async function handleDm(client, { dm, state, rateLimit }) {
  const raw = String(dm.content ?? '').trim();
  if (!raw) return;

  if (OUR_MARKERS.some((m) => raw.startsWith(m))) {
    log.debug(`Ignoring machine-formatted DM from ${recipientOf(dm)}.`);
    return;
  }

  const [cmdRaw] = raw.split(/\s+/, 1);
  const cmd = cmdRaw.toLowerCase();
  const arg = raw.slice(cmdRaw.length).trim();

  log.info(`DM from ${recipientOf(dm)}: ${truncate(raw, 60)}`);

  switch (cmd) {
    case 'help':
    case 'commands':
    case 'menu':
    case '?':
      return replyFree(client, dm, rateLimit, helpText(client));

    case 'about':
    case 'who':
    case 'info':
      return replyFree(client, dm, rateLimit, aboutText(client));

    case 'status':
    case 'me':
    case 'credit':
      return replyFree(client, dm, rateLimit, statusText(client, state, state.subscriber(dm.senderPubkey, dm.senderNametag ?? undefined)));

    case 'find':
    case 'search': {
      if (!arg) {
        return replyFree(
          client,
          dm,
          rateLimit,
          `Usage: \`find <query>\` — one free ranked look at what is live now. For a standing want that alerts you ` +
            `as the market changes, use \`watch <query>\`. — ${config.brand}`,
        );
      }
      const matches = await searchSupply(client, arg, { limit: config.concierge.shortlistSize });
      const body = matches.length
        ? `🔎 Live matches for "${truncate(arg, 60)}":\n${formatShortlist(matches)}\n\n` +
          `That is a snapshot. \`watch ${truncate(arg, 40)}\` and I will tell you when something NEW turns up. — ${config.brand}`
        : `Nothing live matches "${truncate(arg, 60)}" right now. \`watch ${truncate(arg, 40)}\` and I will DM you the ` +
          `moment something does — the first ${config.watch.freeAlerts} alerts are free. — ${config.brand}`;
      return replyFree(client, dm, rateLimit, body);
    }

    case 'watch':
    case 'alert':
      return cmdWatch(client, { dm, arg, state, rateLimit });

    case 'watches':
    case 'list':
    case 'mine':
      return replyFree(client, dm, rateLimit, watchesText(client, state, state.subscriber(dm.senderPubkey, dm.senderNametag ?? undefined)));

    case 'unwatch':
    case 'stop': {
      const sub = state.subscriber(dm.senderPubkey, dm.senderNametag ?? undefined);
      const list = sub.watches ?? [];
      if (list.length === 0) {
        return replyFree(client, dm, rateLimit, `You have no watches to drop. — ${config.brand}`);
      }
      if (/^all$/i.test(arg)) {
        const n = list.length;
        sub.watches = [];
        state.clearBill(sub);
        state.save();
        return replyFree(
          client,
          dm,
          rateLimit,
          `Dropped all ${n} watch${n === 1 ? '' : 'es'}, and closed any open credit request — you owe me nothing. ` +
            `Credit of ${client.toWhole(state.creditBase(sub))} ${sym()} stays on your account for whenever you come ` +
            `back. — ${config.brand}`,
        );
      }
      const byIndex = /^\d+$/.test(arg) ? list[Number(arg) - 1] : null;
      const target = byIndex ?? list.find((w) => w.id === arg.toLowerCase());
      if (!target) {
        return replyFree(
          client,
          dm,
          rateLimit,
          `I could not match "${truncate(arg, 20)}" to one of your watches. \`watches\` lists them with their ` +
            `numbers and ids; \`unwatch all\` drops the lot. — ${config.brand}`,
        );
      }
      state.removeWatch(sub, target.id);
      state.save();
      return replyFree(
        client,
        dm,
        rateLimit,
        `Stopped watching "${truncate(target.query, 70)}" after ${target.alertsSent ?? 0} alert(s). ` +
          `${fundingLine(client, state, sub)} — ${config.brand}`,
      );
    }

    case 'topup':
    case 'top-up':
    case 'buy': {
      const sub = state.subscriber(dm.senderPubkey, dm.senderNametag ?? undefined);
      if (sub.bill) {
        return replyFree(
          client,
          dm,
          rateLimit,
          `There is already a request for ${client.toWhole(BigInt(sub.bill.amountBase))} ${sym()} open in your wallet ` +
            `(${sub.bill.alerts} alerts). I will not send a second one — declining or ignoring the first costs you ` +
            `nothing. — ${config.brand}`,
        );
      }
      const res = await raiseTopup(client, {
        key: dm.senderPubkey,
        sub,
        state,
        rateLimit,
        heldCount: state.totalQueued(sub),
      });
      if (res?.dryRun) return replyFree(client, dm, rateLimit, `[DRY_RUN] Would request ${packPriceWhole()} ${sym()}. — ${config.brand}`);
      return; // raiseTopup already spoke, truthfully, either way
    }

    default:
      return replyFree(
        client,
        dm,
        rateLimit,
        `Not sure what "${truncate(cmd, 20)}" means. \`find <query>\` for a free look, \`watch <query>\` for a ` +
          `standing one, \`help\` for the rest. — ${config.brand}`,
      );
  }
}
