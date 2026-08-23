# frani-agent — Submission Report

> Autonomous service agent for the **Unicity testnet2** network, built on the official
> [`@unicitylabs/sphere-sdk`](https://www.npmjs.com/package/@unicitylabs/sphere-sdk).
> **Made by CRYPTFRANI** · Owner / Creator: **Itachi**.

---

## 1. Identity

| Field | Value |
|---|---|
| **Project name** | frani-agent |
| **Nametag** | `@frani-agent` |
| **Creator / Owner** | Itachi (CRYPTFRANI) |
| **Network** | Unicity **testnet2** |
| **Direct address** | `DIRECT://00007a2c3ff6bc11ce43427029117eb047afa8606fa11cf433df50af76fcb273a2ba6f0e2391` |
| **Chain pubkey (notary key)** | `035c9f07b623…` (compressed secp256k1) |
| **SDK** | `@unicitylabs/sphere-sdk` `^0.14.10` · Node.js ≥ 22 |

---

## 2. Features

### Proactive Market Concierge (free)
Watches the live market feed (`market.subscribeFeed`) and runs periodic semantic searches
(`market.search`, ~90s cadence). When a poster's **buy / seeking** intent strongly matches
available supply, the agent DMs that poster a **ranked shortlist** of live matching intents,
each with its nametag/contact — real discovery value on a semantic intent board. It advertises
itself with a public **`service` intent** so counterparties can find it.

### Paid cryptographic notarization — `notarize <text>` (5 UCT)
Returns a **signed, timestamped proof-of-existence**: a secp256k1 signature over
`frani-agent-notary\n<iso-timestamp>\n<text>`, produced with the agent's chain key.
Anyone can verify it with the SDK's `verifySignedMessage(message, signature, pubkey)` — no
trust in the agent required. Round-trip validity **and** tamper-rejection are verified.

### Market intelligence digests — `digest <query>` (5 UCT)
Returns a fuller ranked shortlist of live market intents matching the query, each with contact —
a paid, deeper cut of the concierge's matchmaking.

### Free `find` helper — `find <query>`
Self-serve, on-demand top matches over DM at no cost (plus free `help` / `about`).

### Earn-only money policy
The agent only **requests** and **receives** UCT. The **single** autonomous outbound payment it
will ever make is **refunding an overpayment** (over-payments auto-refunded; under-payments
refunded in full with an invitation to retry). Its balance can only grow.

### Conservative & light-footprint by design
Event-driven with gentle polling, non-overlapping self-rescheduling timers (no busy loops),
sliding-window rate limits (DMs/hour, actions/hour), a minimum-balance floor, a semantic-match
threshold before contacting anyone, and a global `DRY_RUN` kill-switch. Safe to run beside other
nodes on a small VPS.

---

## 3. Money & Profit Model

- **Revenue** (paid-task settlements, tips, optional finder's fees) accrues **directly and
  verifiably to the single CRYPTFRANI-owned wallet that _is_ the agent.** There is no separate
  treasury and no custody hop — so profit **consolidates to the owner (Itachi) by construction**,
  not via a separate sweep transaction.
- **Roadmap (not yet implemented):** an optional **profit-sweep to a separate cold wallet**,
  disabled by default. It would extend the earn-only policy with one whitelisted outbound
  destination and is intentionally left off pending an explicit destination address + sign-off,
  to preserve the current earn-only safety guarantee.

---

## 4. Live Evidence (testnet2)

| Evidence | Value / Result |
|---|---|
| **Service Intent ID** | `6fad68d8-7d90-464b-9a5e-3ff1848c2139` (type `service`, live, reconciled on boot — not re-posted) |
| **Balance (float)** | **100 UCT** spendable (self-minted at bootstrap; testnet2 has no faucet) |
| **Notary signatures** | Valid **secp256k1** — `verifySignedMessage()` returns VALID on the real message and **rejects** a tampered one |
| **Amount math** | Exact 18-decimal BigInt round-trips (incl. `1.234567890123456789`) — no float drift |
| **Nametag** | `@frani-agent` registered & held |
| **Live feed** | Connected, 10 recent real listings observed |
| **Deployment** | `systemd` service **active (running)**, auto-restart, boot-enabled |

---

## 5. Deployment

Runs as a persistent, auto-restarting **systemd** service.

| Setting | Value |
|---|---|
| Unit file | `/etc/systemd/system/frani-agent.service` |
| WorkingDirectory | `/root/unicity-agent` |
| ExecStart | `/usr/bin/node --max-old-space-size=500 src/index.js` |
| V8 heap cap | `--max-old-space-size=500` (≈500 MB) + `NODE_OPTIONS` |
| Restart policy | `Restart=always`, `RestartSec=5` |
| Environment | `NODE_ENV=production` |
| Swap allowance | `MemorySwapMax=5G` (physical RAM left uncapped so the kernel pages to swap under load instead of OOM-killing) |
| Graceful stop | `KillSignal=SIGINT` → agent persists state & closes cleanly (`TimeoutStopSec=15`) |
| Logs | journald (`journalctl -u frani-agent`) |

---

## 6. Control Commands

```bash
# Identity + balance (exits after printing)
npm run whoami

# Connectivity / config self-check (exits after printing)
npm run doctor

# Follow the live service log
journalctl -u frani-agent -f

# Service lifecycle
systemctl status  frani-agent
systemctl restart frani-agent    # SIGINT → graceful shutdown, then restart
systemctl stop    frani-agent
```

---

## 7. Security Notes

- **`wallet-data/`** holds the 12-word BIP39 mnemonic and derived keys (dir `0700`, files `0600`,
  gitignored). Anyone with it controls the identity and its funds. Set `WALLET_PASSWORD` to
  encrypt the mnemonic at rest. The phrase is printed **once** on first identity creation, with a
  back-it-up warning; on subsequent boots the existing wallet is loaded silently.
- The oracle API key shipped in defaults is a documented **public** testnet2 key (not a secret).
- testnet2 / test-only UCT. Not financial software; provided as-is for network experimentation.

---

<div align="center">

**Made by CRYPTFRANI** · Agent owner/creator: **Itachi**

</div>
