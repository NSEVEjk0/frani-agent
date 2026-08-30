/**
 * frani-agent — central configuration
 * ────────────────────────────────────────────────────────────
 * Owner / Creator: Itachi
 * Made by CRYPTFRANI
 *
 * All runtime settings live here. Values come from environment variables
 * (optionally loaded from a local .env file), each with a safe default.
 * The exported object is frozen so nothing mutates config at runtime.
 */

import { createLogger } from './logger.js';

const log = createLogger('config');

// Load .env if present (Node >=20.12). Never fatal if the file is missing.
try {
  process.loadEnvFile(process.env.ENV_FILE || '.env');
} catch {
  // No .env file — rely on real environment variables and defaults.
}

// ── small typed env helpers ────────────────────────────────────────────────
const str = (key, def) => {
  const v = process.env[key];
  return v === undefined || v === '' ? def : v;
};
const int = (key, def) => {
  const v = process.env[key];
  if (v === undefined || v === '') return def;
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) {
    log.warn(`Invalid integer for ${key}="${v}", using default ${def}`);
    return def;
  }
  return n;
};
const num = (key, def) => {
  const v = process.env[key];
  if (v === undefined || v === '') return def;
  const n = Number.parseFloat(v);
  if (!Number.isFinite(n)) {
    log.warn(`Invalid number for ${key}="${v}", using default ${def}`);
    return def;
  }
  return n;
};
const bool = (key, def) => {
  const v = process.env[key];
  if (v === undefined || v === '') return def;
  return /^(1|true|yes|on)$/i.test(v.trim());
};
const list = (key, def) => {
  const v = process.env[key];
  if (v === undefined || v === '') return def;
  const parts = v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.length ? parts : def;
};

// Nametag: strip a leading '@' and lowercase, since the SDK expects the bare form.
// AGENT_NAME is the documented alias for NAMETAG (AGENT_NAME wins if both are set).
const rawNametag = str('AGENT_NAME', str('NAMETAG', 'frani-agent'))
  .replace(/^@/, '')
  .trim()
  .toLowerCase();

const config = Object.freeze({
  // ── Identity / branding ──────────────────────────────────────────────────
  nametag: rawNametag,
  owner: 'Itachi',
  brand: 'CRYPTFRANI',

  // ── Storage ────────────────────────────────────────────────────────────
  walletDir: str('WALLET_DIR', './wallet-data'),
  walletFileName: str('WALLET_FILE', 'wallet.json'),
  password: str('WALLET_PASSWORD', undefined), // undefined => plaintext on disk

  // ── Network (testnet2) ───────────────────────────────────────────────────
  network: str('UNICITY_NETWORK', str('NETWORK', 'testnet2')), // UNICITY_NETWORK is the documented alias
  oracleApiKey: str('ORACLE_API_KEY', 'sk_ddc3cfcc001e4a28ac3fad7407f99590'),
  walletApiUrl: str('WALLET_API_URL', 'https://wallet-api.unicity.network'),
  coinSymbol: str('COIN_SYMBOL', 'UCT'),

  // ── Loop cadence (ms) — deliberately gentle for a shared 6GB VPS ─────────
  intervals: Object.freeze({
    feedPollMs: int('FEED_POLL_MS', 60_000),
    searchPollMs: int('SEARCH_POLL_MS', 90_000),
    receivePollMs: int('RECEIVE_POLL_MS', 45_000),
    // Standing watches re-run on their own cadence, slower than the concierge:
    // a watch is a want that lasts days, so a couple of minutes of latency on an
    // alert costs nobody anything and keeps the market-api read load polite.
    watchPollMs: int('WATCH_POLL_MS', 120_000),
    // Sweep for top-up requests nobody ever answered. This is the backstop for
    // the payment_request:updated event, not a substitute: the event is the fast
    // path, the sweep guarantees a lapsed request eventually gets its ending.
    billSweepMs: int('BILL_SWEEP_MS', 900_000),
  }),

  // ── Economic safety rails ────────────────────────────────────────────────
  safety: Object.freeze({
    dryRun: bool('DRY_RUN', false),
    // Whole-UCT mark below which the one-time bootstrap self-mint is allowed to
    // fire. This agent has no outbound payment rail, so nothing else consults it.
    minBalanceWhole: num('MIN_BALANCE', 1),
    selfMintEnabled: bool('SELF_MINT_ENABLED', true),
    selfMintAmountWhole: num('SELF_MINT_AMOUNT', 100),
    // Politeness / anti-spam limits.
    matchMinScore: num('MATCH_MIN_SCORE', 0.72),
    maxDmsPerHour: int('MAX_DMS_PER_HOUR', 20),
    maxActionsPerHour: int('MAX_ACTIONS_PER_HOUR', 60),
  }),

  // ── Concierge service (the matchmaker) ──────────────────────────────────
  concierge: Object.freeze({
    // The public 'service' intent the agent advertises on the market.
    serviceDescription:
      str(
        'SERVICE_DESCRIPTION',
        'Autonomous market concierge: describe what you are looking for and @frani-agent ' +
          'will surface matching live intents from the Unicity market and DM you a ranked ' +
          'shortlist. Run by CRYPTFRANI.',
      ),
    intentExpiresInDays: int('INTENT_EXPIRES_DAYS', 7),
    finderFeeWhole: num('FINDER_FEE', 0), // 0 => free service
    // Buyer-side intent types worth proactively helping.
    watchIntentTypes: Object.freeze(['buy', 'service']),
    // Broad semantic seeds used to surface *contactable* buyer intents each pass.
    seedQueries: Object.freeze(
      list('CONCIERGE_QUERIES', ['wanted', 'looking for', 'need to buy', 'looking to buy', 'seeking']),
    ),
    // Politeness caps per matchmaking pass (kept small for a light footprint).
    maxBuyersPerPass: int('CONCIERGE_MAX_BUYERS_PER_PASS', 3),
    shortlistSize: int('CONCIERGE_SHORTLIST_SIZE', 3),
  }),

  // ── Standing watches (the metered half of discovery) ─────────────────────
  // A watch is a standing want. The agent re-runs it and DMs an alert the first
  // time a new intent matches. Alerts are metered, not sold as a lump: every
  // account gets a free allowance, and after that alerts are drawn against
  // prepaid credit that the account tops up by paying a payment request. Credit
  // is denominated in UCT base units and an alert costs a fixed price, so a
  // top-up that does not divide evenly leaves a carry rather than an overpayment
  // to hand back. Nothing here ever sends UCT.
  watch: Object.freeze({
    enabled: bool('WATCH_ENABLED', true),
    // Standing watches one account may hold at once.
    maxPerAccount: int('WATCH_MAX_PER_ACCOUNT', 3),
    // Alerts an account gets before it is ever asked for anything.
    freeAlerts: int('WATCH_FREE_ALERTS', 3),
    // Price of one delivered alert.
    alertPriceWhole: num('WATCH_ALERT_PRICE', 0.5),
    // Alerts in the top-up the agent asks for when the allowance runs out.
    packAlerts: int('WATCH_PACK_ALERTS', 10),
    // How long an unanswered top-up request stays open before the watch pauses.
    billTtlHours: int('WATCH_BILL_TTL_HOURS', 48),
    // Alerts one account can receive from a single sweep (anti-flood).
    maxAlertsPerPass: int('WATCH_MAX_ALERTS_PER_PASS', 3),
    // Matches held for an account while its top-up is unanswered.
    maxQueuedPerWatch: int('WATCH_MAX_QUEUED', 10),
    // A standing want is not forever; a watch lapses if it is never renewed.
    expiresInDays: int('WATCH_EXPIRES_DAYS', 14),
  }),

  logLevel: str('LOG_LEVEL', 'info'),
});

export default config;
