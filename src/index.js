#!/usr/bin/env node
/**
 * frani-agent — entrypoint
 * ────────────────────────────────────────────────────────────
 * Owner / Creator: Itachi
 * Made by CRYPTFRANI
 *
 * Modes:
 *   node src/index.js            start the autonomous agent (default)
 *   node src/index.js --whoami   print identity + balance, then exit
 *   node src/index.js --doctor   connectivity / config self-check, then exit
 *   node src/index.js --mint     capped self-mint, then exit
 *   node src/index.js --demo     narrated offline walk-through, then exit
 *
 * `--demo` is the only mode that does not open a wallet or a socket, so it is the
 * only one that is safe to run while the daemon is up.
 */

import config from './config.js';
import { createLogger } from './logger.js';
import { SphereClient } from './sphere-client.js';

const log = createLogger('main');

function banner() {
  log.info('──────────────────────────────────────────────');
  log.info(' frani-agent · autonomous Unicity testnet2 agent');
  log.info(` owner: ${config.owner}   ·   made by ${config.brand}`);
  log.info(` network: ${config.network}   dry-run: ${config.safety.dryRun}`);
  log.info('──────────────────────────────────────────────');
}

async function reportStatus(client) {
  const balance = await client.spendableWhole();
  log.info(`Identity : ${client.describe()}`);
  log.info(`Coin     : ${client.coin.symbol} (${client.coin.decimals} decimals)`);
  log.info(`Balance  : ${balance} ${client.coin.symbol} (spendable)`);
  log.info(`Wallet   : ${config.walletDir}  (device ${client.deviceId})`);
}

async function main() {
  const args = new Set(process.argv.slice(2));
  banner();

  // Before the boot, deliberately: the demo runs the real service modules over a
  // fake network, so it must not open a second Sphere connection on this wallet.
  if (args.has('--demo')) {
    const { runDemo } = await import('./demo.js');
    await runDemo({ pace: args.has('--fast') ? 0 : 900 });
    process.exit(0);
  }

  const client = await SphereClient.boot();

  // ── one-shot inspection / maintenance modes ───────────────────────────────
  if (args.has('--doctor')) {
    await reportStatus(client);
    log.info(`Connection: ${client.sphere.payments.connectionStatus?.() ?? 'n/a'}`);
    log.info('Doctor check complete. ✅');
    await client.destroy();
    process.exit(0); // one-shot modes: force exit (open sockets otherwise keep the loop alive)
  }

  if (args.has('--whoami')) {
    await reportStatus(client);
    await client.destroy();
    process.exit(0); // one-shot modes: force exit (open sockets otherwise keep the loop alive)
  }

  if (args.has('--mint')) {
    await client.ensureNametag();
    await client.mint(config.safety.selfMintAmountWhole);
    await reportStatus(client);
    await client.destroy();
    process.exit(0); // one-shot modes: force exit (open sockets otherwise keep the loop alive)
  }

  // ── default: run the autonomous agent ──────────────────────────────────────
  await client.ensureNametag();
  await client.bootstrapMintIfNeeded();
  await reportStatus(client);

  const { startAgent } = await import('./agent.js');
  const controller = new AbortController();

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`Received ${signal} — shutting down gracefully…`);
    controller.abort();
    // Give the loop a moment to unwind, then close the connection.
    setTimeout(async () => {
      await client.destroy();
      process.exit(0);
    }, 500);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  await startAgent(client, controller.signal);
  await client.destroy();
}

main().catch((err) => {
  log.error('Fatal:', err?.stack ?? err?.message ?? err);
  process.exit(1);
});
