/**
 * frani-agent — lightweight persisted state
 * ────────────────────────────────────────────────────────────
 * Owner / Creator: Itachi
 * Made by CRYPTFRANI
 *
 * A tiny JSON-backed store in wallet-data/state.json. It keeps just enough
 * across restarts to behave correctly and idempotently:
 *   • seenDmIds / seenTransferIds  — dedup rings (relays replay; events can double-fire)
 *   • servedIntentIds              — buyers we've already helped (never spam twice)
 *   • pendingTasks                 — paid tasks awaiting payment, keyed by requester
 *   • serviceIntentId              — the market 'service' intent we've published
 *
 * Everything is capped so the file (and memory) stay small on a shared VPS.
 * Writes are atomic (temp file + rename) so a crash mid-write can't corrupt it.
 */

import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';

import config from './config.js';
import { createLogger } from './logger.js';

const log = createLogger('state');

const RING_CAP = 500; // max ids kept per dedup ring
const STATE_VERSION = 1;

/** Normalize a pubkey to x-only lowercase hex so 02.../03… and bare forms collide. */
export function normalizeKey(key) {
  if (typeof key !== 'string') return String(key ?? '');
  const k = key.trim().toLowerCase();
  if (k.length === 66 && (k.startsWith('02') || k.startsWith('03'))) return k.slice(2);
  return k;
}

function statePath() {
  return join(resolve(config.walletDir), 'state.json');
}

function freshState() {
  return {
    version: STATE_VERSION,
    serviceIntentId: null,
    servedIntentIds: [],
    seenDmIds: [],
    seenTransferIds: [],
    pendingTasks: {}, // { [normalizedPubkey]: Task[] }
  };
}

/** Push onto a capped ring; returns true if the id was NEW (not already present). */
function ringAdd(arr, id) {
  if (!id) return false;
  if (arr.includes(id)) return false;
  arr.push(id);
  if (arr.length > RING_CAP) arr.splice(0, arr.length - RING_CAP);
  return true;
}

export class State {
  constructor(data) {
    this.data = data;
    this._dirty = false;
  }

  static load() {
    const path = statePath();
    if (!existsSync(path)) return new State(freshState());
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8'));
      const data = { ...freshState(), ...raw };
      // Coerce the shapes we depend on, in case of an older/edited file.
      for (const k of ['servedIntentIds', 'seenDmIds', 'seenTransferIds']) {
        if (!Array.isArray(data[k])) data[k] = [];
      }
      if (typeof data.pendingTasks !== 'object' || data.pendingTasks === null) data.pendingTasks = {};
      return new State(data);
    } catch (err) {
      log.warn(`state.json unreadable (${err?.message ?? err}); starting fresh.`);
      return new State(freshState());
    }
  }

  save() {
    const path = statePath();
    const tmp = `${path}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
      renameSync(tmp, path); // atomic swap
      this._dirty = false;
    } catch (err) {
      log.warn(`Could not persist state: ${err?.message ?? err}`);
    }
  }

  // ── dedup rings ─────────────────────────────────────────────────────────────
  /** @returns true if this DM id is new (should be processed). */
  markDmSeen(id) {
    const isNew = ringAdd(this.data.seenDmIds, id);
    if (isNew) this._dirty = true;
    return isNew;
  }

  /** @returns true if this transfer id is new (should be processed). */
  markTransferSeen(id) {
    const isNew = ringAdd(this.data.seenTransferIds, id);
    if (isNew) this._dirty = true;
    return isNew;
  }

  /** @returns true if this buyer intent hasn't been served before. */
  markIntentServed(id) {
    const isNew = ringAdd(this.data.servedIntentIds, id);
    if (isNew) this._dirty = true;
    return isNew;
  }

  hasServedIntent(id) {
    return this.data.servedIntentIds.includes(id);
  }

  // ── service intent ────────────────────────────────────────────────────────────
  get serviceIntentId() {
    return this.data.serviceIntentId;
  }
  setServiceIntentId(id) {
    this.data.serviceIntentId = id;
    this._dirty = true;
  }

  // ── pending paid tasks (keyed by requester pubkey) ─────────────────────────────
  addPendingTask(pubkey, task) {
    const key = normalizeKey(pubkey);
    (this.data.pendingTasks[key] ??= []).push(task);
    this._dirty = true;
  }

  pendingFor(pubkey) {
    return this.data.pendingTasks[normalizeKey(pubkey)] ?? [];
  }

  /** Remove and return the OLDEST pending task for a requester (FIFO), or null. */
  takeOldestTask(pubkey) {
    const key = normalizeKey(pubkey);
    const q = this.data.pendingTasks[key];
    if (!q || q.length === 0) return null;
    const task = q.shift();
    if (q.length === 0) delete this.data.pendingTasks[key];
    this._dirty = true;
    return task;
  }

  totalPendingTasks() {
    return Object.values(this.data.pendingTasks).reduce((n, q) => n + q.length, 0);
  }
}

export default State;
