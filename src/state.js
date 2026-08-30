/**
 * frani-agent — lightweight persisted state
 * ────────────────────────────────────────────────────────────
 * Owner / Creator: Itachi
 * Made by CRYPTFRANI
 *
 * A tiny JSON-backed store in wallet-data/state.json. It keeps just enough
 * across restarts to behave correctly and idempotently:
 *   • seenDmIds / seenTransferIds — dedup rings (relays replay; events double-fire)
 *   • servedIntentIds             — buyers the concierge has already helped
 *   • serviceIntentId             — the market 'service' intent we've published
 *   • subscribers                 — standing watches and the alert-credit ledger
 *
 * The ledger is the only money-shaped thing in here, and it is deliberately
 * one-directional: `creditBase` is prepaid alert credit in UCT base units. It
 * goes UP when someone pays a top-up request and DOWN when an alert is
 * delivered. There is no field for "owed back", because this agent has no
 * outbound payment rail — see the note on spendAlert().
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
const SEEN_PER_WATCH = 120; // matched-intent ids remembered per watch
const STATE_VERSION = 2; // v1 held `pendingTasks` for the retired paid-task shop

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
    subscribers: {}, // { [normalizedPubkey]: Subscriber }
    // v1 → v2: the paid notarize/digest shop is gone. Any request that was
    // sitting unpaid in v1 was never charged for, so nothing is owed — but the
    // requester was told a result was coming, so they get told once that it is not.
    legacyTasks: [],
    legacyTasksRetired: false,
  };
}

function freshSubscriber(nametag) {
  return {
    nametag: nametag ?? null,
    firstSeen: Date.now(),
    freeUsed: 0, // alerts drawn from the free allowance
    creditBase: '0', // prepaid alert credit, UCT base units
    alertsDelivered: 0, // lifetime, for `status`
    paidBase: '0', // lifetime top-ups received, UCT base units
    watches: [], // Watch[]
    bill: null, // the one open top-up request, if any
  };
}

/** Push onto a capped ring; returns true if the id was NEW (not already present). */
function ringAdd(arr, id, cap = RING_CAP) {
  if (!id) return false;
  if (arr.includes(id)) return false;
  arr.push(id);
  if (arr.length > cap) arr.splice(0, arr.length - cap);
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
      for (const k of ['servedIntentIds', 'seenDmIds', 'seenTransferIds']) {
        if (!Array.isArray(data[k])) data[k] = [];
      }
      if (typeof data.subscribers !== 'object' || data.subscribers === null) data.subscribers = {};
      migrate(data);
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

  // ── service intent ──────────────────────────────────────────────────────────
  get serviceIntentId() {
    return this.data.serviceIntentId;
  }
  setServiceIntentId(id) {
    this.data.serviceIntentId = id;
    this._dirty = true;
  }

  // ── subscribers ─────────────────────────────────────────────────────────────
  /** The subscriber record for a pubkey, creating it if this is a first contact. */
  subscriber(pubkey, nametag = undefined) {
    const key = normalizeKey(pubkey);
    const sub = (this.data.subscribers[key] ??= freshSubscriber(nametag));
    if (nametag && sub.nametag !== nametag) {
      sub.nametag = nametag; // a nametag can be claimed after we first saw the key
      this._dirty = true;
    }
    return sub;
  }

  /** The existing record for a pubkey, or null — never creates one. */
  peek(pubkey) {
    return this.data.subscribers[normalizeKey(pubkey)] ?? null;
  }

  /** Every [key, subscriber, watch] triple with a live watch, oldest watch first. */
  *liveWatches(now = Date.now()) {
    for (const [key, sub] of Object.entries(this.data.subscribers)) {
      for (const w of sub.watches ?? []) {
        if (w.expiresAt && w.expiresAt <= now) continue;
        yield { key, sub, watch: w };
      }
    }
  }

  countWatches() {
    let n = 0;
    for (const _ of this.liveWatches()) n++;
    return n;
  }

  countSubscribers() {
    return Object.keys(this.data.subscribers).length;
  }

  addWatch(sub, watch) {
    (sub.watches ??= []).push(watch);
    this._dirty = true;
    return watch;
  }

  removeWatch(sub, id) {
    const before = (sub.watches ?? []).length;
    sub.watches = (sub.watches ?? []).filter((w) => w.id !== id);
    if (sub.watches.length !== before) this._dirty = true;
    return before - sub.watches.length;
  }

  /** Drop watches that have lapsed; returns the ones removed. */
  reapExpiredWatches(now = Date.now()) {
    const gone = [];
    for (const [key, sub] of Object.entries(this.data.subscribers)) {
      const keep = [];
      for (const w of sub.watches ?? []) {
        if (w.expiresAt && w.expiresAt <= now) gone.push({ key, sub, watch: w });
        else keep.push(w);
      }
      if (keep.length !== (sub.watches ?? []).length) {
        sub.watches = keep;
        this._dirty = true;
      }
    }
    return gone;
  }

  /** @returns true if this intent id is new for this watch (worth alerting on). */
  markWatchSeen(watch, intentId) {
    const isNew = ringAdd((watch.seen ??= []), intentId, SEEN_PER_WATCH);
    if (isNew) this._dirty = true;
    return isNew;
  }

  // ── the alert-credit ledger ─────────────────────────────────────────────────
  /** Free alerts still available to this account. */
  freeLeft(sub) {
    return Math.max(0, config.watch.freeAlerts - (sub.freeUsed ?? 0));
  }

  creditBase(sub) {
    return BigInt(sub.creditBase ?? '0');
  }

  /** Whole alerts the account's prepaid credit can still pay for. */
  creditAlerts(sub, alertPriceBase) {
    if (alertPriceBase <= 0n) return 0;
    return Number(this.creditBase(sub) / alertPriceBase);
  }

  /**
   * Draw one alert. Free allowance first, then prepaid credit.
   *
   * Returns how it was funded, or null when the account can afford nothing —
   * the caller must then queue the match and raise a top-up, never deliver on
   * credit it does not have.
   *
   * Note what is missing: there is no path that puts creditBase back. A top-up
   * that does not divide evenly by the alert price leaves the remainder sitting
   * as credit toward the next alert, which is why this agent needs no refund
   * rail and cannot owe anybody a send.
   */
  spendAlert(sub, alertPriceBase) {
    if (this.freeLeft(sub) > 0) {
      sub.freeUsed = (sub.freeUsed ?? 0) + 1;
      sub.alertsDelivered = (sub.alertsDelivered ?? 0) + 1;
      this._dirty = true;
      return { funded: 'free', freeLeft: this.freeLeft(sub) };
    }
    const credit = this.creditBase(sub);
    if (alertPriceBase > 0n && credit >= alertPriceBase) {
      sub.creditBase = (credit - alertPriceBase).toString();
      sub.alertsDelivered = (sub.alertsDelivered ?? 0) + 1;
      this._dirty = true;
      return { funded: 'credit', creditBase: sub.creditBase };
    }
    return null;
  }

  /** Add a paid top-up to the account's credit. Base units in, base units kept. */
  addCredit(sub, base) {
    sub.creditBase = (this.creditBase(sub) + BigInt(base)).toString();
    sub.paidBase = (BigInt(sub.paidBase ?? '0') + BigInt(base)).toString();
    this._dirty = true;
    return sub.creditBase;
  }

  // ── open top-up request (at most one per account) ────────────────────────────
  setBill(sub, bill) {
    sub.bill = bill;
    this._dirty = true;
    return bill;
  }

  clearBill(sub) {
    if (sub.bill) {
      sub.bill = null;
      this._dirty = true;
      return true;
    }
    return false;
  }

  /** Find the account holding the open bill with this request id. */
  findBill(requestId) {
    if (!requestId) return null;
    for (const [key, sub] of Object.entries(this.data.subscribers)) {
      if (sub.bill && (sub.bill.requestId === requestId || sub.bill.id === requestId)) {
        return { key, sub, bill: sub.bill };
      }
    }
    return null;
  }

  /** Open bills whose TTL has run out. */
  staleBills(now = Date.now(), ttlMs = config.watch.billTtlHours * 3_600_000) {
    const out = [];
    for (const [key, sub] of Object.entries(this.data.subscribers)) {
      if (sub.bill && now - (sub.bill.createdAt ?? 0) >= ttlMs) out.push({ key, sub, bill: sub.bill });
    }
    return out;
  }

  // ── queued matches (held while a top-up is unanswered) ──────────────────────
  queue(watch, entry) {
    (watch.queued ??= []).push(entry);
    const cap = config.watch.maxQueuedPerWatch;
    if (watch.queued.length > cap) watch.queued.splice(0, watch.queued.length - cap);
    this._dirty = true;
    return watch.queued.length;
  }

  drainQueue(watch) {
    const q = watch.queued ?? [];
    watch.queued = [];
    if (q.length) this._dirty = true;
    return q;
  }

  totalQueued(sub) {
    return (sub.watches ?? []).reduce((n, w) => n + (w.queued?.length ?? 0), 0);
  }

  // ── v1 leftovers ────────────────────────────────────────────────────────────
  /** Requesters owed a one-time "the paid shop is retired" note, then never again. */
  legacyTasksToRetire() {
    if (this.data.legacyTasksRetired) return [];
    return this.data.legacyTasks ?? [];
  }

  markLegacyRetired() {
    this.data.legacyTasksRetired = true;
    this.data.legacyTasks = [];
    this._dirty = true;
  }
}

/**
 * v1 → v2. v1 kept `pendingTasks` — notarize/digest requests waiting to be paid
 * for. The shop is retired, and because a task only ever became pending BEFORE
 * its payment request was answered, an entry here means nobody was ever charged.
 * We carry the requesters over just long enough to tell each of them once, then
 * drop the field.
 */
function migrate(data) {
  if (data.pendingTasks && typeof data.pendingTasks === 'object') {
    const carried = [];
    for (const [key, tasks] of Object.entries(data.pendingTasks)) {
      for (const t of tasks ?? []) {
        carried.push({ key, kind: t.kind ?? 'task', nametag: t.requesterNametag ?? null, createdAt: t.createdAt ?? null });
      }
    }
    if (carried.length) {
      data.legacyTasks = [...(data.legacyTasks ?? []), ...carried];
      log.info(`Carried ${carried.length} unpaid v1 task request(s) over for a one-time retirement notice.`);
    }
    delete data.pendingTasks;
  }
  data.version = STATE_VERSION;
}

export default State;
