/**
 * frani-agent — paid micro-tasks + DM command handling
 * ────────────────────────────────────────────────────────────
 * Owner / Creator: Itachi
 * Made by CRYPTFRANI
 *
 * DM command grammar (case-insensitive first word):
 *   FREE : help | about | find <query>
 *   PAID : notarize <text>   → signed, timestamped proof-of-existence
 *          digest   <query>  → fuller ranked market shortlist
 *
 * Paid flow (earn-only, never trust a memo round-trip):
 *   1. request → we create a pending task (persisted) + a payment request.
 *   2. settle  → on an incoming UCT transfer we fulfil the requester's OLDEST
 *      pending task, deliver the result, and auto-refund any overpayment.
 *   Underpayment or a fulfilment error refunds the full amount (the only
 *   outbound payments we ever make).
 */

import { randomUUID } from 'node:crypto';

import { coinIdsMatch } from '@unicitylabs/sphere-sdk';

import config from '../config.js';
import { createLogger } from '../logger.js';
import { searchSupply, formatShortlist } from './concierge.js';

const log = createLogger('tasks');

const sym = () => config.coinSymbol;
const truncate = (s, n) => {
  const str = String(s ?? '').replace(/\s+/g, ' ').trim();
  return str.length > n ? `${str.slice(0, n - 1)}…` : str;
};

// Markers our own outbound messages start with — used to avoid replying to
// another agent's (or our own) machine output and looping.
const OUR_MARKERS = ['🤖', '✅', '📊', '🔎', '👋'];

function recipientOf(dm) {
  return dm.senderNametag ? `@${dm.senderNametag}` : dm.senderPubkey;
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

// ── static copy ────────────────────────────────────────────────────────────
function helpText(client) {
  const tag = client.nametag ?? 'frani-agent';
  return [
    `🤖 @${tag} — autonomous market concierge & micro-services (by ${config.brand}, owner ${config.owner})`,
    ``,
    `FREE commands:`,
    `  help            this message`,
    `  about           who I am & how I work`,
    `  find <query>    up to ${config.concierge.shortlistSize} live market matches`,
    ``,
    `PAID commands (${config.paidTasks.priceWhole} ${sym()} each, settled in UCT):`,
    `  notarize <text> signed, timestamped proof-of-existence (verifiable via sphere-sdk)`,
    `  digest <query>  fuller ranked shortlist of live market intents`,
    ``,
    `How paid tasks work: I reply with a payment request — pay it and your result`,
    `returns automatically. Overpayment is auto-refunded. I never send funds except refunds.`,
    `— ${config.brand}`,
  ].join('\n');
}

function aboutText(client) {
  const tag = client.nametag ?? 'frani-agent';
  return [
    `🤖 @${tag} is an autonomous agent on the Unicity testnet2 network.`,
    `Owner / creator: ${config.owner}. Made by ${config.brand}.`,
    ``,
    `I run a FREE market concierge (I DM buyers a shortlist of matching intents),`,
    `and offer PAID micro-tasks — notarize & digest — settled in ${sym()}.`,
    ``,
    `Policy: EARN-ONLY. I only ever request/receive ${sym()}; the sole outbound`,
    `payment I make is refunding an overpayment. Every unit earned accrues to this`,
    `single wallet, owned by ${config.owner} under the ${config.brand} banner.`,
    ``,
    `Reply \`help\` for the command list. — ${config.brand}`,
  ].join('\n');
}

// ── paid task creation ───────────────────────────────────────────────────────
async function createPaidTask(client, { dm, kind, payload, state, rateLimit }) {
  const recipient = recipientOf(dm);
  if (!config.paidTasks.enabled) {
    await replyFree(client, dm, rateLimit, `Paid tasks are currently disabled. Try \`find <query>\` (free). — ${config.brand}`);
    return;
  }
  if (!payload) {
    const usage =
      kind === 'notarize'
        ? `Usage: \`notarize <text>\` — I return a signed, timestamped proof for exactly that text (${config.paidTasks.priceWhole} ${sym()}).`
        : `Usage: \`digest <query>\` — I return a fuller ranked market shortlist (${config.paidTasks.priceWhole} ${sym()}).`;
    await replyFree(client, dm, rateLimit, usage);
    return;
  }
  if (config.safety.dryRun) {
    await replyFree(
      client,
      dm,
      rateLimit,
      `[DRY_RUN] Would create a ${kind} task and request ${config.paidTasks.priceWhole} ${sym()}. — ${config.brand}`,
    );
    return;
  }
  if (!rateLimit.allow('action', config.safety.maxActionsPerHour)) {
    log.warn(`Action cap reached — not creating a ${kind} task for ${recipient} right now.`);
    return;
  }

  const id = randomUUID();
  const task = {
    id,
    kind,
    payload,
    priceBase: client.toBase(config.paidTasks.priceWhole).toString(),
    createdAt: Date.now(),
    requesterNametag: dm.senderNametag ?? null,
  };
  state.addPendingTask(dm.senderPubkey, task);
  state.save();

  await client.requestPayment(recipient, config.paidTasks.priceWhole, `frani:${kind}:${id.slice(0, 8)}`);

  const body = [
    `🤖 Got your \`${kind}\` request. Price: ${config.paidTasks.priceWhole} ${sym()}.`,
    `I've sent you a payment request (check your wallet). Pay it and your result`,
    `returns here automatically — overpayment is refunded, I never hold your funds.`,
    `— ${config.brand}`,
  ].join('\n');
  // This DM is part of a paid flow the requester initiated — deliver it (record, don't gate).
  noteSend(rateLimit);
  await client.sendDM(recipient, body);
  log.info(`Created ${kind} task ${id.slice(0, 8)} for ${recipient}; payment requested.`);
}

// ── fulfilment ────────────────────────────────────────────────────────────────
function fulfillNotarize(client, task) {
  const iso = new Date().toISOString();
  const subject = task.payload;
  const signed = `frani-agent-notary\n${iso}\n${subject}`; // exact 3-line string that gets signed
  const signature = client.sphere.signMessage(signed);
  const pubkey = client.identity.chainPubkey;
  const tag = client.nametag ?? 'frani-agent';
  return [
    `✅ NOTARIZED — proof-of-existence by @${tag} (${config.brand})`,
    `issued : ${iso}`,
    `signer : @${tag}`,
    `pubkey : ${pubkey}`,
    `subject: ${subject}`,
    ``,
    `signedMessage (verify this exact 3-line string):`,
    signed,
    ``,
    `signature: ${signature}`,
    ``,
    `Verify with @unicitylabs/sphere-sdk →`,
    `  verifySignedMessage(signedMessage, signature, pubkey) === true`,
    `— Made by ${config.brand}`,
  ].join('\n');
}

async function fulfillDigest(client, task) {
  const matches = await searchSupply(client, task.payload, { limit: 5 });
  const header = `📊 Market digest for "${truncate(task.payload, 60)}" — @${client.nametag ?? 'frani-agent'} (${config.brand})`;
  if (matches.length === 0) {
    return `${header}\n\nNo live matches right now — your payment covered the search. Try a broader \`digest <query>\`. — ${config.brand}`;
  }
  return `${header}\n\n${formatShortlist(matches)}\n\nReach out to them directly. — ${config.brand}`;
}

/** Sum the UCT value (base units) of an incoming transfer. */
function uctAmount(client, transfer) {
  return (transfer.tokens ?? [])
    .filter((t) => coinIdsMatch(t.coinId, client.coin.coinId))
    .reduce((acc, t) => acc + BigInt(t.amount ?? '0'), 0n);
}

/**
 * Settle an incoming transfer against the sender's pending tasks.
 * Fulfils the OLDEST task if paid in full; refunds under/overpayment.
 */
export async function settlePayment(client, { transfer, state, rateLimit }) {
  const amountBase = uctAmount(client, transfer);
  if (amountBase <= 0n) return; // not a UCT transfer we price on

  const sender = transfer.senderPubkey;
  const recipient = transfer.senderNametag ? `@${transfer.senderNametag}` : sender;
  const task = state.takeOldestTask(sender);

  // No pending task → unsolicited payment. Earn-only: keep it, thank politely.
  if (!task) {
    log.info(`Received ${client.toWhole(amountBase)} ${sym()} from ${recipient} with no pending task — treating as a tip.`);
    noteSend(rateLimit);
    await client.sendDM(
      recipient,
      `Thanks for the ${client.toWhole(amountBase)} ${sym()}! No task was pending, so I'm keeping it as a tip to ${config.brand}. Reply \`help\` to put me to work. — ${config.brand}`,
    );
    return;
  }

  const priceBase = BigInt(task.priceBase);

  // Underpaid → refund everything, invite a retry.
  if (amountBase < priceBase) {
    log.warn(`Underpaid ${task.kind} from ${recipient}: ${client.toWhole(amountBase)} < ${client.toWhole(priceBase)} ${sym()}. Refunding.`);
    await client.refund(sender, amountBase, `frani refund — insufficient for ${task.kind}`);
    noteSend(rateLimit);
    await client.sendDM(
      recipient,
      `That was ${client.toWhole(amountBase)} ${sym()}, but \`${task.kind}\` costs ${config.paidTasks.priceWhole} ${sym()}. I've refunded it — send the full amount to retry. — ${config.brand}`,
    );
    return;
  }

  // Paid in full → fulfil.
  let resultBody;
  try {
    resultBody = task.kind === 'notarize' ? fulfillNotarize(client, task) : await fulfillDigest(client, task);
  } catch (err) {
    log.error(`Fulfilment of ${task.kind} failed: ${err?.message ?? err}. Refunding.`);
    await client.refund(sender, amountBase, `frani refund — ${task.kind} fulfilment failed`);
    noteSend(rateLimit);
    await client.sendDM(
      recipient,
      `Sorry — I hit an error fulfilling your \`${task.kind}\` and have refunded ${client.toWhole(amountBase)} ${sym()}. Please try again. — ${config.brand}`,
    );
    return;
  }

  // Deliver the paid result (bypasses the DM cap — the requester paid for it).
  noteSend(rateLimit);
  await client.sendDM(recipient, resultBody);
  log.info(`Fulfilled ${task.kind} (${task.id.slice(0, 8)}) for ${recipient}.`);

  // Refund any overpayment (the one autonomous outbound payment we allow).
  const over = amountBase - priceBase;
  if (over > 0n) {
    await client.refund(sender, over, `frani overpayment refund`);
  }
  state.save();
}

// ── DM dispatch ────────────────────────────────────────────────────────────────
/**
 * Parse and act on one incoming DM. Callers must already have de-duplicated the
 * message id and confirmed it is not from ourselves.
 */
export async function handleDm(client, { dm, state, rateLimit }) {
  const raw = String(dm.content ?? '').trim();
  if (!raw) return;

  // Never react to machine output (our own banners echoed, or another agent's).
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

    case 'find':
    case 'search': {
      if (!arg) {
        return replyFree(
          client,
          dm,
          rateLimit,
          `Usage: \`find <query>\` — up to ${config.concierge.shortlistSize} free matches. For a fuller ranked list use \`digest <query>\` (${config.paidTasks.priceWhole} ${sym()}). — ${config.brand}`,
        );
      }
      const matches = await searchSupply(client, arg, { limit: config.concierge.shortlistSize });
      const body = matches.length
        ? `🔎 Free matches for "${truncate(arg, 60)}":\n${formatShortlist(matches)}\n\nWant more? \`digest <query>\` returns a fuller ranked list. — ${config.brand}`
        : `No live matches for "${truncate(arg, 60)}" right now. Try broader terms, or \`digest <query>\` for a deeper search. — ${config.brand}`;
      return replyFree(client, dm, rateLimit, body);
    }

    case 'notarize':
    case 'notary':
      return createPaidTask(client, { dm, kind: 'notarize', payload: arg, state, rateLimit });

    case 'digest':
    case 'market':
      return createPaidTask(client, { dm, kind: 'digest', payload: arg, state, rateLimit });

    default:
      return replyFree(
        client,
        dm,
        rateLimit,
        `Not sure what "${truncate(cmd, 20)}" means. Reply \`help\` for what I can do. — ${config.brand}`,
      );
  }
}
