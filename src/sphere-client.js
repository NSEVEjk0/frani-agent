/**
 * frani-agent — Sphere client: identity, wallet, and money primitives
 * ────────────────────────────────────────────────────────────
 * Owner / Creator: Itachi
 * Made by CRYPTFRANI
 *
 * Wraps @unicitylabs/sphere-sdk for a headless Node.js agent on testnet2:
 *   • builds Node providers (storage + Nostr transport + aggregator oracle)
 *     and the required wallet-api transport layer
 *   • load-or-create identity from a locally-persisted BIP39 mnemonic
 *   • registers the @nametag, resolves the UCT coin, checks balance
 *   • exposes the two money actions this agent has: the one-time bootstrap mint,
 *     and raising a payment REQUEST
 *
 * Money policy = REQUEST-ONLY. Read the method list: there is no send. Not a
 * disabled send, not a send behind a flag — no `payments.send` call exists in
 * this file, so no bug, no compromised config and no confused state machine can
 * make this agent pay anybody. It asks, and the counterparty's own wallet
 * decides. That is the whole reason the product upstream can meter alerts
 * without ever holding, escrowing or returning somebody's UCT.
 *
 * The consequence to keep in mind while editing: nothing here can settle a debt.
 * If a caller ever finds itself owing UCT, the bug is in the caller's design,
 * not in a missing rail here.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

import {
  Sphere,
  NETWORKS,
  isSphereError,
  isValidNametag,
  getCoinIdBySymbol,
  getTokenDecimals,
} from '@unicitylabs/sphere-sdk';
import { createNodeProviders, createWalletApiProviders } from '@unicitylabs/sphere-sdk/impl/nodejs';

import config from './config.js';
import { createLogger } from './logger.js';

const log = createLogger('sphere');

// ── amount helpers (exact big-int math; never floats for money) ─────────────
/** Convert a whole-token amount (number|string) to smallest-unit BigInt. */
export function toBaseUnits(whole, decimals) {
  const s = String(whole).trim();
  const neg = s.startsWith('-');
  const [intPart, fracRaw = ''] = s.replace(/^-/, '').split('.');
  const frac = (fracRaw + '0'.repeat(decimals)).slice(0, decimals);
  const digits = ((intPart || '0') + frac).replace(/^0+(?=\d)/, '');
  const v = BigInt(digits === '' ? '0' : digits);
  return neg ? -v : v;
}

/** Convert a smallest-unit amount (BigInt|string) to a human whole-token string. */
export function toWholeString(base, decimals) {
  let v = BigInt(base);
  const neg = v < 0n;
  if (neg) v = -v;
  const denom = 10n ** BigInt(decimals);
  const int = v / denom;
  const frac = (v % denom).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${int}${frac ? `.${frac}` : ''}`;
}

// ── small utilities ─────────────────────────────────────────────────────────
function withTimeout(promise, ms, label) {
  let t;
  const timeout = new Promise((_, reject) => {
    t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

function fmtErr(err) {
  if (isSphereError(err)) return `${err.code}: ${err.message}`;
  return err?.message ?? String(err);
}

// ── file-backed identity bits ───────────────────────────────────────────────
function walletPaths() {
  const dir = resolve(config.walletDir);
  return {
    dir,
    mnemonic: join(dir, 'mnemonic.txt'),
    deviceId: join(dir, 'device-id.txt'),
  };
}

function ensureWalletDir() {
  const { dir } = walletPaths();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function loadOrCreateDeviceId() {
  const { deviceId } = walletPaths();
  if (existsSync(deviceId)) return readFileSync(deviceId, 'utf8').trim();
  const id = `frani-agent-${randomUUID()}`;
  writeFileSync(deviceId, `${id}\n`, { mode: 0o600 });
  return id;
}

function readMnemonicFile() {
  const { mnemonic } = walletPaths();
  return existsSync(mnemonic) ? readFileSync(mnemonic, 'utf8').trim() : undefined;
}

function saveMnemonicFile(phrase) {
  const { mnemonic } = walletPaths();
  writeFileSync(mnemonic, `${phrase}\n`, { mode: 0o600 });
}

function printMnemonicBanner(phrase, saved) {
  const line = '═'.repeat(72);
  log.warn(`\n${line}`);
  log.warn('  🔑  NEW IDENTITY CREATED FOR @' + config.nametag);
  log.warn('  This BIP39 recovery phrase controls the wallet and its funds.');
  log.warn('  BACK IT UP OFFLINE. It is shown ONCE and never printed again.');
  log.warn(line);
  log.warn(`  ${phrase}`);
  log.warn(line);
  log.warn(
    saved
      ? `  Also saved (mode 0600) to ${walletPaths().mnemonic}`
      : '  Not written to disk (WALLET_PASSWORD set or SAVE_MNEMONIC_FILE=false).',
  );
  log.warn(`${line}\n`);
}

// ── token registry fallback (used when the SDK cache is not yet populated) ──
async function fetchRegistrySymbol(symbol) {
  const net = NETWORKS[config.network] ?? NETWORKS.testnet2 ?? NETWORKS.testnet;
  const url = net?.tokenRegistryUrl;
  if (!url) return undefined;
  const res = await withTimeout(fetch(url), 15_000, 'token-registry fetch');
  if (!res.ok) throw new Error(`token registry HTTP ${res.status}`);
  const list = await res.json();
  const arr = Array.isArray(list) ? list : [];
  return arr.find(
    (e) => e?.assetKind === 'fungible' && String(e?.symbol).toUpperCase() === symbol.toUpperCase(),
  );
}

async function resolveCoin(symbol) {
  let coinId;
  try {
    coinId = getCoinIdBySymbol(symbol) || undefined;
  } catch {
    /* registry not loaded yet */
  }
  let decimals;
  if (coinId) {
    try {
      const d = getTokenDecimals(coinId);
      if (Number.isFinite(d)) decimals = d;
    } catch {
      /* fall through to registry */
    }
  }
  if (!coinId || decimals == null) {
    const entry = await fetchRegistrySymbol(symbol);
    if (!entry) throw new Error(`Coin symbol "${symbol}" not found in the testnet2 registry`);
    coinId = coinId ?? entry.id;
    decimals = decimals ?? entry.decimals;
  }
  log.info(`Resolved ${symbol}: coinId=${coinId.slice(0, 12)}… decimals=${decimals}`);
  return { symbol, coinId, decimals };
}

/**
 * SphereClient — the agent's handle on the network. Bundles the initialized
 * Sphere instance, the resolved coin, and guarded high-level actions.
 */
export class SphereClient {
  constructor(sphere, coin, deviceId, created) {
    this.sphere = sphere;
    this.coin = coin;
    this.deviceId = deviceId;
    this.created = created;
  }

  /** Boot providers + identity. Load-or-create from the local mnemonic file. */
  static async boot() {
    ensureWalletDir();
    const deviceId = loadOrCreateDeviceId();

    const base = createNodeProviders({
      network: config.network,
      dataDir: resolve(config.walletDir),
      walletFileName: config.walletFileName,
      oracle: { apiKey: config.oracleApiKey },
      market: true,
    });

    const providers = createWalletApiProviders(base, {
      baseUrl: config.walletApiUrl,
      network: config.network,
      deviceId,
    });

    const fileMnemonic = config.password ? undefined : readMnemonicFile();
    const initOpts = {
      ...providers,
      network: config.network, // engine/registry network — must match walletApi.network
      market: true,
      communications: {},
      dmSince: Math.floor(Date.now() / 1000) - 86_400, // catch DMs from the last 24h on connect
      ...(config.password ? { password: config.password } : {}),
      ...(fileMnemonic ? { mnemonic: fileMnemonic } : { autoGenerate: true }),
    };

    log.info(`Connecting to ${config.network} as @${config.nametag} (device ${deviceId})…`);
    const { sphere, created, generatedMnemonic } = await withTimeout(
      Sphere.init(initOpts),
      60_000,
      'Sphere.init',
    );

    if (created && generatedMnemonic) {
      const shouldSave = !config.password; // don't scatter a plaintext phrase when encrypting the store
      if (shouldSave) saveMnemonicFile(generatedMnemonic);
      printMnemonicBanner(generatedMnemonic, shouldSave);
    } else {
      log.info(created ? 'New wallet created.' : 'Existing wallet loaded.');
    }

    const coin = await resolveCoin(config.coinSymbol);
    const client = new SphereClient(sphere, coin, deviceId, created);
    log.info(`Identity ready: ${client.describe()}`);
    return client;
  }

  // ── identity accessors ────────────────────────────────────────────────────
  get identity() {
    return this.sphere.identity ?? {};
  }

  get nametag() {
    return this.identity.nametag?.replace(/^@/, '') || null;
  }

  get address() {
    return this.identity.directAddress || this.identity.chainPubkey || null;
  }

  /** Both key encodings that may echo back as "self" on the relay. */
  selfPubkeys() {
    const set = new Set();
    const cp = this.identity.chainPubkey;
    if (cp) {
      set.add(cp);
      if (cp.length === 66) set.add(cp.slice(2)); // 32-byte x-only form
    }
    return set;
  }

  describe() {
    return `@${this.nametag ?? '(unregistered)'} · ${this.address ?? '?'}`;
  }

  // ── balance ───────────────────────────────────────────────────────────────
  /**
   * Read our coin's asset row, and say whether we actually got one.
   *
   * `payments.assets()` resolves with an EMPTY ARRAY when the wallet-api cannot
   * be reached — it does not throw. So "no row for our coin" is two different
   * facts wearing the same clothes: a wallet that genuinely holds nothing, and a
   * backend that never answered. This agent has exactly one decision gated on
   * the balance — whether to fire the one-time bootstrap self-mint — and getting
   * that wrong in the "silence read as zero" direction mints a second time onto
   * a wallet that is already funded. Hence {present, row} rather than a number:
   * bootstrapMintIfNeeded() has to be able to see the difference.
   */
  async _coinRow() {
    const assets = await this.sphere.payments.assets(this.coin.coinId);
    const row = Array.isArray(assets)
      ? assets.find((x) => x.coinId === this.coin.coinId)
      : undefined;
    return { present: !!row, row: row ?? {} };
  }

  async spendableBase() {
    const { row } = await this._coinRow();
    return BigInt(row.confirmedAmount ?? row.totalAmount ?? '0');
  }

  async spendableWhole() {
    return toWholeString(await this.spendableBase(), this.coin.decimals);
  }

  toBase(whole) {
    return toBaseUnits(whole, this.coin.decimals);
  }

  toWhole(base) {
    return toWholeString(base, this.coin.decimals);
  }

  // ── nametag ────────────────────────────────────────────────────────────────
  /** Register the configured nametag if the identity doesn't already hold one. */
  async ensureNametag() {
    if (this.nametag) {
      log.info(`Nametag already held: @${this.nametag}`);
      return this.nametag;
    }
    if (!isValidNametag(config.nametag)) {
      log.warn(`Configured nametag "${config.nametag}" is invalid; running keys-only.`);
      return null;
    }
    if (config.safety.dryRun) {
      log.warn(`[DRY_RUN] Would register nametag @${config.nametag}.`);
      return null;
    }
    try {
      const available = await this.sphere.isNametagAvailable(config.nametag);
      if (!available) {
        log.warn(`Nametag @${config.nametag} is taken by another identity; running keys-only.`);
        return null;
      }
      await this.sphere.registerNametag(config.nametag);
      log.info(`Registered nametag @${config.nametag}.`);
      return config.nametag;
    } catch (err) {
      log.warn(`Nametag registration failed (non-fatal): ${fmtErr(err)}`);
      return null;
    }
  }

  // ── minting (testnet2 self-funding; no faucet) ──────────────────────────────
  /** Mint `whole` UCT to self. Amount is passed to the SDK in smallest units. */
  async mint(whole) {
    const base = this.toBase(whole);
    if (config.safety.dryRun) {
      log.warn(`[DRY_RUN] Would self-mint ${whole} ${this.coin.symbol}.`);
      return { success: false, dryRun: true };
    }
    log.info(`Self-minting ${whole} ${this.coin.symbol}…`);
    const result = await this.sphere.payments.mint(this.coin.coinId, base);
    if (result?.success) {
      log.info(`Minted ${whole} ${this.coin.symbol} (token ${String(result.tokenId).slice(0, 12)}…).`);
    } else {
      log.error(`Mint failed: ${result?.error ?? 'unknown error'}`);
    }
    return result;
  }

  /** One-time bootstrap mint on first run if enabled and below the floor. */
  async bootstrapMintIfNeeded() {
    if (!config.safety.selfMintEnabled) return;
    const { present, row } = await this._coinRow();
    if (!present && !this.created) {
      // An absent row is genuinely ambiguous: it is what an unreachable wallet-api
      // looks like, AND what a wallet holding nothing at all looks like. assets()
      // cannot tell them apart. But a wallet GENERATED THIS BOOT cannot hold
      // funds, so there the absence is definitively a zero and the documented
      // testnet2 self-mint bootstrap is safe. On a pre-existing wallet we refuse:
      // re-minting onto funds we simply failed to read is the worse error.
      log.warn(
        'Balance unavailable (wallet-api gave no asset row) on an existing wallet — ' +
          'skipping bootstrap mint. If this wallet is genuinely empty, top it up ' +
          'deliberately with the daemon stopped rather than guessing here.',
      );
      return;
    }
    if (!present) {
      log.info('Brand-new wallet with no asset row yet — treating as a genuine 0 balance.');
    }
    const balance = BigInt(row.confirmedAmount ?? row.totalAmount ?? '0');
    const floor = this.toBase(config.safety.minBalanceWhole);
    if (balance >= floor) {
      log.info(`Balance ${this.toWhole(balance)} ${this.coin.symbol} ≥ floor; no bootstrap needed.`);
      return;
    }
    log.info(`Balance below floor — bootstrapping with a capped self-mint.`);
    await this.mint(config.safety.selfMintAmountWhole);
  }

  // ── inbound-only money: no send path exists ─────────────────────────────────
  /**
   * Deliberately absent: `_send` / `refund` / any `payments.send` wrapper.
   *
   * An earlier version of this agent sold paid tasks and therefore needed to
   * hand money back when someone overpaid. Metered alerts replaced that: credit
   * is held in base units and an odd amount just carries to the next alert, so
   * there is nothing to return and no rail to return it on. If you are about to
   * add one, check first whether the feature that needs it is really this
   * agent's job — a sibling in the fleet already holds custody on purpose.
   */

  // ── payment requests (how the agent earns) ──────────────────────────────────
  async requestPayment(recipient, whole, memo) {
    if (config.safety.dryRun) {
      log.warn(`[DRY_RUN] Would request ${whole} ${this.coin.symbol} from ${recipient} (${memo}).`);
      return { success: false, dryRun: true };
    }
    try {
      const result = await this.sphere.payments.requests.create(recipient, {
        coinId: this.coin.coinId,
        amount: this.toBase(whole).toString(),
        memo,
      });
      if (result?.success) log.info(`Payment request sent to ${recipient} for ${whole} ${this.coin.symbol}.`);
      else log.warn(`Payment request to ${recipient} failed: ${result?.error ?? 'unknown'}`);
      return result;
    } catch (err) {
      log.error(`Payment request failed to ${recipient}: ${fmtErr(err)}`);
      return { success: false, error: fmtErr(err) };
    }
  }

  /**
   * Decline a payment request somebody sent US. This agent never pays: an
   * inbound request is answered rather than ignored so the sender's wallet stops
   * showing it as pending on our account.
   */
  async declinePaymentRequest(id) {
    try {
      const res = await this.sphere.payments.requests.decline(id);
      log.info(`Declined inbound payment request ${String(id).slice(0, 10)}… (this agent does not pay).`);
      return res;
    } catch (err) {
      log.warn(`Could not decline payment request ${String(id).slice(0, 10)}…: ${fmtErr(err)}`);
      return { success: false, error: fmtErr(err) };
    }
  }

  // ── messaging ────────────────────────────────────────────────────────────────
  async sendDM(recipient, content) {
    if (config.safety.dryRun) {
      log.warn(`[DRY_RUN] Would DM ${recipient}: ${content.slice(0, 80)}…`);
      return { dryRun: true };
    }
    try {
      const dm = await this.sphere.communications.sendDM(recipient, content);
      log.info(`DM sent to ${recipient} (${String(dm?.id ?? '').slice(0, 10)}…).`);
      return dm;
    } catch (err) {
      log.error(`DM failed to ${recipient}: ${fmtErr(err)}`);
      return { error: fmtErr(err) };
    }
  }

  async destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    try {
      await this.sphere.destroy?.();
      log.info('Sphere connection closed.');
    } catch (err) {
      log.warn(`Error during shutdown: ${fmtErr(err)}`);
    }
  }
}

export default SphereClient;
