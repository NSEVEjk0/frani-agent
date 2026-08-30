# frani-agent 🤖

**An autonomous Market Concierge + paid-task service agent for the [Unicity](https://unicity.network) testnet2 network.**

**Track:** Autonomous agents — discovery and paid services
**Agentic:** Yes — it finds work, prices it, delivers it and refunds overpayment with no human in the loop
**Runs on AstridOS:** No — a Node.js daemon under `systemd` on Linux
**Status:** Live on testnet2 as `@frani-agent`, holding 100 UCT. Verified end-to-end on-network, including the awkward path: a deliberate 4 UCT underpayment against a 5 UCT task was detected, explained with the real price, and refunded in full — reported as done only because it really went out.
**SDK:** `@unicitylabs/sphere-sdk` ^0.15.0 (`state-transition-sdk` 3.x)

Built on the official [`@unicitylabs/sphere-sdk`](https://www.npmjs.com/package/@unicitylabs/sphere-sdk). `frani-agent` claims the nametag **`@frani-agent`**, lives on the network continuously as a background daemon, and takes economic actions on its own — no human clicking required.

> **Owner / Creator:** Itachi &nbsp;·&nbsp; **Made by CRYPTFRANI**
>
> **Live agent address:** `DIRECT://00007a2c3ff6bc11ce43427029117eb047afa8606fa11cf433df50af76fcb273a2ba6f0e2391`

---

## What it does

`frani-agent` is a good citizen of the Unicity **market** (a signed, semantic intent bulletin board). It runs two cooperating services plus a strict safety layer.

### 1. Market Concierge (proactive matchmaking — free)
- Posts a public **`service` intent** advertising itself.
- Continuously watches the **live feed** (`market.subscribeFeed`) and runs periodic **semantic searches** (`market.search`, ~90 s cadence).
- When someone posts a **buy / seeking intent** that strongly matches available supply, the agent DMs that poster a **ranked shortlist** of matching live intents — each with its nametag/contact. Real discovery value on a semantic board.

### 2. Paid micro-tasks (settled in UCT, over encrypted DM)

| DM command | Cost | What you get |
|---|---|---|
| `help` | free | The command list |
| `about` | free | Who the agent is and how it works |
| `find <query>` | free | Up to 3 live market matches (self-serve concierge) |
| `notarize <text>` | **5 UCT** | A **signed, timestamped proof-of-existence** — a secp256k1 signature over `frani-agent-notary\n<iso-time>\n<text>`, verifiable by anyone with `verifySignedMessage()` from the SDK |
| `digest <query>` | **5 UCT** | A **fuller ranked shortlist** of live market intents matching your query, each with its contact |

**Paid flow:** send the command → the agent replies with a **payment request** → you pay it → your result returns automatically over DM. Overpayment is **auto-refunded**; underpayment is refunded in full with an invitation to retry. The agent never holds your funds.

### 3. Conservative by design
- **Earn-only money policy** — the agent only *requests* and *receives* UCT. The single autonomous outbound payment it will ever make is **refunding an overpayment**. Its balance can only grow.
- Hard **rate limits** (DMs/hour, actions/hour), a **minimum-balance floor**, a **semantic-match threshold** before it ever contacts anyone, and a global **`DRY_RUN`** kill-switch.
- **Light footprint** — gentle polling (60–90 s), event-driven where possible, minimal CPU/RAM. Safe to run beside other nodes on a 6 GB VPS.

---

## Install & run (testnet2)

> Requires **Node.js ≥ 22** (native `WebSocket` + `fetch`, used by the SDK's live market feed).

```bash
git clone https://github.com/NSEVEjk0/frani-agent.git
cd frani-agent
npm install

# Configure (all values have safe defaults)
cp .env.example .env        # optional; edit if you want to override anything

# Inspect identity + balance without starting the loop
npm run whoami

# Start the autonomous agent
npm start
```

First launch generates a brand-new identity, registers `@frani-agent`, and (unless disabled) performs a **one-time capped self-mint** of test UCT — testnet2 has no faucet.

### Commands
| Command | What it does |
|---|---|
| `npm start` | Run the autonomous agent loop |
| `npm run whoami` | Print identity, address, nametag and balance, then exit |
| `npm run doctor` | Connectivity / config self-check, then exit |
| `npm run mint` | Manually trigger a capped self-mint, then exit |

---

## Configuration

All settings are environment variables resolved in [`src/config.js`](src/config.js); every one has a safe default. See [`.env.example`](.env.example) for the full annotated list. The three most common:

| Variable | Default | Meaning |
|---|---|---|
| `AGENT_NAME` | `frani-agent` | Nametag to claim (alias: `NAMETAG`) |
| `UNICITY_NETWORK` | `testnet2` | Network to run against (alias: `NETWORK`) |
| `NOTARIZE_FEE_UCT` | `5` | Price per paid task, notarize/digest (alias: `TASK_PRICE`) |

---

## Deployment — systemd (background daemon)

`frani-agent` is designed to run as a persistent, auto-restarting service.

**`/etc/systemd/system/frani-agent.service`**

| Setting | Value |
|---|---|
| `WorkingDirectory` | `/root/unicity-agent` |
| `ExecStart` | `/usr/bin/node --max-old-space-size=500 src/index.js` |
| `Restart` / `RestartSec` | `always` / `5s` |
| `Environment` | `NODE_ENV=production`, `NODE_OPTIONS=--max-old-space-size=500` |
| V8 heap cap | ~500 MB (`--max-old-space-size=500`) |
| `MemorySwapMax` | `5G` — physical RAM left uncapped so the kernel pages to swap under load instead of OOM-killing the process |
| `KillSignal` | `SIGINT` → triggers graceful shutdown (persist state → close connection) |
| Logs | journald → `journalctl -u frani-agent -f` |

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now frani-agent
systemctl status frani-agent
journalctl -u frani-agent -f       # live logs
```

> Tip: for a running service, inspect it with `journalctl` / `systemctl status`. Run `npm run whoami` / `doctor` only while the service is **stopped**, or they open a second connection as `@frani-agent`.

---

## Identity & the mnemonic — read this

On first run the agent creates a wallet and prints a **BIP39 recovery phrase (mnemonic)** once, then writes it to `wallet-data/`.

- **`wallet-data/` is gitignored and must stay secret.** It contains the mnemonic and derived keys — anyone with it controls `@frani-agent` and its funds.
- Set **`WALLET_PASSWORD`** in `.env` to encrypt the mnemonic at rest (PBKDF2). Without it, the phrase is stored in plaintext (fine for a throwaway testnet identity, risky on a shared box).
- **Back up the phrase** shown on first run somewhere safe and offline. It is the only way to recover the identity if `wallet-data/` is lost.
- To start over with a fresh identity, stop the agent and delete `wallet-data/`.

---

## Rewards & ownership → Itachi / CRYPTFRANI

`@frani-agent` is a service run **by Itachi under the CRYPTFRANI banner**. Its identity metadata, its advertised market intent, and every public-facing message it sends attribute it to CRYPTFRANI, and every unit of UCT it earns (finder's fees, paid-task settlements, tips) accrues to **this single wallet — owned and controlled by Itachi**. There is no separate treasury or split: the agent *is* the CRYPTFRANI-owned wallet, so rewards flow directly and verifiably back to its owner.

---

## Project structure

```
frani-agent/
├── package.json
├── .env.example          # annotated settings
├── .gitignore
├── README.md
├── SUBMISSION.md         # submission report
└── src/
    ├── index.js          # entrypoint: boot, modes (--whoami/--doctor/--mint), graceful shutdown
    ├── config.js         # env-based settings + safety rails
    ├── logger.js         # lightweight leveled logger
    ├── state.js          # tiny persisted state (dedup rings, pending paid tasks)
    ├── ratelimit.js      # sliding-window rate limiter (polite, no timers)
    ├── sphere-client.js  # identity/wallet setup, providers, balance, mint, refunds
    ├── agent.js          # the autonomous loop + event wiring
    └── services/
        ├── concierge.js  # matchmaking: search, rank, DM shortlist + service intent
        └── paid-tasks.js # DM commands + notarize/digest fulfilment & refunds
```

---

## Tests

```bash
npm test
```

Two offline suites, 62 assertions, no network, wallet or funds:

`test-refund-truth-unit.mjs` — 45 assertions, 21 of which fail without the fix. It pins the
rule that the agent **never claims a refund that did not go out**: `client.refund` resolves
rather than throws for every failure mode it has (refunds disabled, min-balance floor, send
error, unconfirmed certification), so a caller that ignores the return tells someone their
money is on the way when it never left. An unconfirmed certification is its own third
answer — reported as neither done nor failed, and never retried, because the burn may
already have certified.

`test-balance-outage-unit.mjs` — 17 assertions, 5 of which fail without the fix. It pins the
rule that a wallet-api outage is **never read as a zero balance**. `payments.assets()`
resolves with an empty array when the backend is unreachable rather than throwing, so at the
call site an outage and an empty wallet look identical. Two things went wrong on that: a
withheld refund blamed the min-balance floor when the wallet in fact held 100 UCT, and the
one-time bootstrap would have fired a *second* self-mint onto an already-funded wallet. The
send still fails closed — it just says why truthfully now.

The suites that move real UCT are deliberately **not** published: they embed an oracle
API key and read a wallet mnemonic. `.gitignore` keeps `test-*.mjs` ignored by default and
negates only the offline ones, so a new live test stays private unless someone opts it in.

---

## Disclaimer

Runs on **testnet2** with test-only UCT. Not financial software; provided as-is for experimentation on the Unicity network.

---

## License

MIT © Itachi (CRYPTFRANI) — see [LICENSE](LICENSE).

---

<div align="center">

**Made by CRYPTFRANI** · Agent owner/creator: **Itachi**

</div>
