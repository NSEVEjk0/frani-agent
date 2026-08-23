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
  }),

  // ── Economic safety rails ────────────────────────────────────────────────
  safety: Object.freeze({
    dryRun: bool('DRY_RUN', false),
    // Whole-UCT floor the agent will never spend below.
    minBalanceWhole: num('MIN_BALANCE', 1),
    selfMintEnabled: bool('SELF_MINT_ENABLED', true),
    selfMintAmountWhole: num('SELF_MINT_AMOUNT', 100),
    // Earn-only policy: the ONLY autonomous outbound payment is refunding overpayment.
    autoRefundOverpayment: bool('AUTO_REFUND_OVERPAYMENT', true),
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

  // ── Paid tasks module ────────────────────────────────────────────────────
  paidTasks: Object.freeze({
    enabled: bool('PAID_TASKS_ENABLED', true),
    // Price per paid task (notarize / digest). NOTARIZE_FEE_UCT is the documented name;
    // TASK_PRICE is kept as a legacy alias.
    priceWhole: num('NOTARIZE_FEE_UCT', num('TASK_PRICE', 5)),
  }),

  logLevel: str('LOG_LEVEL', 'info'),
});

export default config;
