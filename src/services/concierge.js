/**
 * frani-agent — Market Concierge (discovery / matchmaking)
 * ────────────────────────────────────────────────────────────
 * Owner / Creator: Itachi
 * Made by CRYPTFRANI
 *
 * Two jobs:
 *   1. Publish the agent's own `service` intent so it is discoverable.
 *   2. Proactively help buyers: each pass, surface *contactable* buyer intents
 *      (via semantic search, which returns pubkeys/handles — unlike the feed),
 *      find matching supply for each, and DM the buyer a ranked shortlist.
 *
 * The search helper here is reused by the free `find` and paid `digest` DM
 * commands, so ranking/formatting/self-exclusion live in one place.
 */

import config from '../config.js';
import { createLogger } from '../logger.js';
import { normalizeKey } from '../state.js';

const log = createLogger('concierge');

const truncate = (s, n) => {
  const str = String(s ?? '').replace(/\s+/g, ' ').trim();
  return str.length > n ? `${str.slice(0, n - 1)}…` : str;
};

/** The set of this identity's pubkeys (normalized), so we never match/DM ourselves. */
function selfKeys(client) {
  const set = new Set();
  for (const k of client.selfPubkeys()) set.add(normalizeKey(k));
  return set;
}

/** Human label + resolvable DM recipient for a search result. */
function contactOf(r) {
  const label = r.agentNametag ? `@${r.agentNametag}` : `${String(r.agentPublicKey).slice(0, 10)}…`;
  const recipient = r.agentNametag ? `@${r.agentNametag}` : r.agentPublicKey;
  return { label, recipient };
}

/**
 * Semantic search for contactable supply, ranked best-first.
 * Excludes our own intents and anything below the score threshold.
 *
 * @returns {Promise<Array>} filtered SearchIntentResult[]
 */
export async function searchSupply(client, query, opts = {}) {
  const {
    limit = config.concierge.shortlistSize,
    minScore = config.safety.matchMinScore,
    excludeKeys = selfKeys(client),
    excludeIntentId = null,
    excludeTypes = [], // e.g. ['buy'] to keep only supply-side results
    intentType, // optional filter
  } = opts;

  const q = String(query ?? '').trim();
  if (!q) return [];

  const filters = { minScore };
  if (intentType) filters.intentType = intentType;

  let res;
  try {
    res = await client.sphere.market.search(q, { filters, limit: Math.max(limit * 3, 10) });
  } catch (err) {
    log.warn(`search("${truncate(q, 40)}") failed: ${err?.message ?? err}`);
    return [];
  }

  const seen = new Set();
  return (res?.intents ?? [])
    .filter((r) => r && r.id !== excludeIntentId)
    .filter((r) => !excludeKeys.has(normalizeKey(r.agentPublicKey)))
    .filter((r) => !excludeTypes.includes(r.intentType))
    .filter((r) => (typeof r.score === 'number' ? r.score >= minScore : true))
    .filter((r) => {
      if (seen.has(r.id)) return false;
      seen.add(r.id);
      return true;
    })
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .slice(0, limit);
}

/** Render a ranked result list into compact DM lines. */
export function formatShortlist(results) {
  return results
    .map((r, i) => {
      const { label } = contactOf(r);
      const score = typeof r.score === 'number' ? r.score.toFixed(2) : '—';
      const price = r.price != null ? ` [${r.price} ${r.currency ?? ''}`.trimEnd() + ']' : '';
      const type = r.intentType ? ` {${r.intentType}}` : '';
      return `${i + 1}. (${score}) ${label}${type} — ${truncate(r.description, 90)}${price}`;
    })
    .join('\n');
}

/**
 * Publish the agent's own `service` intent, once. Reconciles against the server:
 * if the previously-stored intent id is gone (expired/closed), it re-posts.
 */
export async function ensureServiceIntent(client, state) {
  if (config.safety.dryRun) {
    log.warn('[DRY_RUN] Would publish the @frani-agent service intent.');
    return;
  }
  try {
    if (state.serviceIntentId) {
      const mine = await client.sphere.market.getMyIntents();
      const alive = mine.some((m) => m.id === state.serviceIntentId && m.status === 'active');
      if (alive) {
        log.info(`Service intent already live (${state.serviceIntentId.slice(0, 10)}…).`);
        return;
      }
    }
    const result = await client.sphere.market.postIntent({
      description: config.concierge.serviceDescription,
      intentType: 'service',
      category: 'agents',
      currency: config.coinSymbol,
      contactHandle: client.nametag ? `@${client.nametag}` : undefined,
      expiresInDays: config.concierge.intentExpiresInDays,
    });
    state.setServiceIntentId(result.intentId);
    state.save();
    log.info(`Published service intent ${result.intentId.slice(0, 10)}… (expires ${result.expiresAt}).`);
  } catch (err) {
    log.warn(`Could not publish service intent (non-fatal): ${err?.message ?? err}`);
  }
}

/**
 * One proactive matchmaking pass. Surfaces contactable buyer intents, matches
 * each against live supply, and DMs a shortlist to buyers we can genuinely help.
 * Bounded by config caps and the shared rate limiter.
 */
export async function runConciergePass(client, { state, rateLimit }) {
  const keys = selfKeys(client);

  // 1) Gather contactable buyer intents from a few broad semantic seeds.
  const buyers = new Map(); // id -> result (dedup across seeds)
  for (const seed of config.concierge.seedQueries) {
    let res;
    try {
      res = await client.sphere.market.search(seed, {
        filters: { intentType: 'buy', minScore: config.safety.matchMinScore },
        limit: 10,
      });
    } catch (err) {
      log.debug(`buyer seed "${seed}" search failed: ${err?.message ?? err}`);
      continue;
    }
    for (const r of res?.intents ?? []) {
      if (!r || keys.has(normalizeKey(r.agentPublicKey))) continue;
      if (state.hasServedIntent(r.id)) continue;
      if (!buyers.has(r.id)) buyers.set(r.id, r);
    }
  }

  if (buyers.size === 0) {
    log.info('Concierge pass: no new buyer intents to help right now.');
    return { helped: 0 };
  }

  // 2) For each buyer (capped per pass), find matching supply and DM a shortlist.
  let helped = 0;
  const ranked = [...buyers.values()].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  for (const buyer of ranked.slice(0, config.concierge.maxBuyersPerPass)) {
    const matches = await searchSupply(client, buyer.description, {
      excludeKeys: new Set([...keys, normalizeKey(buyer.agentPublicKey)]),
      excludeIntentId: buyer.id,
      excludeTypes: ['buy'], // a buyer wants sellers/services, not other buyers
    });
    if (matches.length === 0) continue; // nothing useful to say — stay quiet

    if (!rateLimit.allow('dm', config.safety.maxDmsPerHour)) {
      log.warn('DM/hour cap reached — deferring remaining concierge DMs to a later pass.');
      break;
    }
    if (!rateLimit.allow('action', config.safety.maxActionsPerHour)) {
      log.warn('Action/hour cap reached — pausing concierge this pass.');
      break;
    }

    const { recipient, label } = contactOf(buyer);
    const body =
      `👋 @${client.nametag ?? 'frani-agent'} here — a market concierge run by ${config.brand}.\n` +
      `You're looking for: "${truncate(buyer.description, 100)}"\n\n` +
      `Live matches I found on the Unicity market:\n${formatShortlist(matches)}\n\n` +
      `Reach out to them directly. Reply \`help\` to see what else I can do. — ${config.brand}`;

    await client.sendDM(recipient, body);
    state.markIntentServed(buyer.id);
    state.save();
    helped++;
    log.info(`Concierge → ${label}: sent ${matches.length} match(es).`);

    // Optional finder's fee (off by default; earn-only, request-not-send).
    if (config.concierge.finderFeeWhole > 0) {
      await client.requestPayment(
        recipient,
        config.concierge.finderFeeWhole,
        `Optional tip for @${client.nametag} concierge matches`,
      );
    }
  }

  log.info(`Concierge pass complete: helped ${helped} buyer(s).`);
  return { helped };
}
