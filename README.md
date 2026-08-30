# frani-agent

### The market has a search box. It does not have a memory.

`market.search` on Unicity answers what is listed *right now*. Ask it for GPU
hours before anyone is selling GPU hours and you get nothing — and there is
nowhere to leave the question. `frani-agent` is that missing piece: a daemon on
testnet2 that holds your query as a **standing watch**, re-runs it against the
live board on its own schedule, and DMs you the moment supply appears that was
not there before.

It is a discovery agent, and discovery is the whole product. It does not notarize
text, sell reports, escrow rewards, quote deals or lend UCT. Its siblings do those.

| | |
|---|---|
| **Submission track** | **Autonomous agents** — discovery |
| **Agentic** | Yes. Nobody asks it to run a pass. It decides when to search, what counts as new, who is owed an alert, and when to stop asking. |
| **Runs on AstridOS** | No — a Node.js daemon under `systemd` on Linux |
| **Live on** | Unicity **testnet2** as `@frani-agent` |
| **Address** | `DIRECT://00007a2c3ff6bc11ce43427029117eb047afa8606fa11cf433df50af76fcb273a2ba6f0e2391` |
| **SDK** | `@unicitylabs/sphere-sdk` ^0.15.0 (`state-transition-sdk` 3.x) |
| **Status** | Live and holding 100 UCT. The concierge has run on-network since launch: nametag claimed, `service` intent published, buyer intents answered with shortlists over DM. The watch/credit surface here replaced a paid-task shop that earned nothing (three requests were raised, none paid, so retiring it stranded no funds and every v1 requester is told so once, on boot). It is pinned by 97 offline assertions and has not yet been exercised on-network — stated plainly rather than implied. |
| **Owner / Creator** | Itachi · Made by **CRYPTFRANI** |

---

## The one design decision worth reviewing

**This agent has no outbound payment rail. Not a disabled one — an absent one.**

Alerts past the free allowance are paid for, so money had to come into the design
somewhere. The obvious shape is the one every custodial agent uses: name a price,
take the UCT, hand over the goods, refund the difference. That shape needs a send
method, and a send method needs a min-balance floor, a double-pay guard, a
retry policy, an unconfirmed-certification branch, and a test suite proving the
agent never claims a refund it did not actually make.

`frani-agent` does not have any of that, because alerts are metered against
**prepaid credit denominated in UCT base units**:

```
top-up 1.7 UCT  ·  alerts cost 0.5 UCT
                → 3 alerts released, 0.2 UCT carried
```

An amount that does not divide evenly is not an overpayment. It is a **carry**.
There is nothing to give back, so there is no code that gives anything back:

```js
// src/sphere-client.js
// ── inbound-only money: no send path exists ─────────────────────────────────
/**
 * Deliberately absent: `_send` / `refund` / any `payments.send` wrapper.
 */
```

Settlement is the SDK's own `payments.requests` rail. The agent places a request
in your wallet; **your wallet decides**. It cannot pull funds, cannot chase you,
and cannot strand funds it never held. Decline the request and the answer is
complete: nothing is owed, ever, and the matches it was holding stay held for
whenever you come back.

`test-mint-gate-unit.mjs` asserts this **structurally** — it walks the client's
prototype chain looking for a method named after paying somebody, and greps
`src/sphere-client.js` for a `payments.send(` call site. Both must come back
empty. Every custodial sibling in the fleet fails that test by design.

---

## How the metering works

| | |
|---|---|
| First **3** alerts per account | free |
| After that | **0.5 UCT** per alert, sold 10 at a time (**5 UCT** a top-up) |
| Setting a watch, `find`, `help`, `about`, `status`, `watches`, `unwatch` | free, always |
| Supply already live when you set a watch | handed over free — a watch bills for *new* supply, never for a backlog |

The order matters and is tested: a match past your allowance is **held**, and the
credit request goes out *for the held match*. An agent that alerted first and
invoiced after would be giving away the paid product and then asking nicely.

One open request per account, ever. A pass that holds three matches raises one
request, not three.

### When it cannot raise the request

`payments.requests.create()` **resolves** with `{success: false}` when the
wallet-api is unreachable. It does not throw. An agent that reads that as success
tells you to check your wallet for a prompt that is not there, while your matches
go stale. So the bill is recorded and announced **only** when the SDK confirms it,
and otherwise you get told plainly that it could not be raised and that nothing is
owed — and the next sweep tries again.

---

## Talk to it

DM `@frani-agent` on testnet2.

```
watch <query>        hold this question; alert me when new supply matches
watches              your watches, their age, alert counts and state
unwatch <n|all>      drop one or all — closes any open request too
find <query>         a free snapshot of what matches right now
topup                re-send the open credit request
status               your allowance, credit and carry
help · about
```

Watches live 14 days and renew by re-issuing the same `watch`. Three per account.

## Two directions of latency, on purpose

- **Push** — the concierge is debounced off `market.subscribeFeed`. A fresh buyer
  intent is worth answering in seconds, so it is answered in seconds, with a
  ranked shortlist of matching supply. Free, unmetered, unsolicited: this is the
  agent being a good citizen of the board.
- **Pull** — watches run on a slow timer (120 s default). A standing want does not
  go stale in two minutes, and hammering `market.search` on behalf of every open
  watch would make the agent a bad neighbour.

Both go through the *same* ranking path in `services/concierge.js`, so a watch can
never surface something `find` would have filtered out.

---

## See it work in five minutes

```bash
npm install
npm run demo
```

`--demo` runs the real service module, the real ledger and the real config against
a fake market. **It opens no wallet and no socket**, so unlike `whoami` it is safe
to run while the daemon is up. It walks two paths:

- **happy** — watch set → free allowance spent → next match held → one request →
  they pay 1.7 UCT → held matches released → 0.2 carried.
- **failure** — the request is **declined**. Bill dropped, watch paused *still
  holding its matches*, nothing owed, and a later payment of any size resumes it
  from exactly there.

It ends by printing the number of payments the agent attempted to send across
both paths. It is zero, and not because a flag was off.

## Run it

```bash
npm run whoami            # identity, address, nametag, balance
npm run doctor            # connectivity + config self-check
npm start                 # the autonomous daemon
npm test                  # the two offline suites
```

Node ≥ 22 (the SDK's live feed uses native `WebSocket`/`fetch`). First launch
generates a BIP39 identity, registers the nametag, and performs a **one-time
capped self-mint** — testnet2 has no faucet. The phrase is printed once and
written to `wallet-data/` (gitignored, mode 0600); back it up offline, set
`WALLET_PASSWORD` to encrypt it at rest, and delete the directory to start over.

> Do not run `npm run whoami` / `doctor` while the service is up — each boots a
> second Sphere instance on the same wallet. Use `journalctl` or the DM `status`.

### As a service

```ini
# /etc/systemd/system/frani-agent.service
[Service]
WorkingDirectory=/root/unicity-agent
ExecStart=/usr/bin/node --max-old-space-size=500 src/index.js
Restart=always
RestartSec=5
KillSignal=SIGINT        # graceful: stop timers → persist state → close socket
```

```bash
systemctl enable --now frani-agent
journalctl -u frani-agent -f
```

### Configuration

Every knob has a safe default; see [`.env.example`](.env.example). The ones that
change behaviour:

| Variable | Default | Meaning |
|---|---|---|
| `WATCH_FREE_ALERTS` | `3` | Free alerts per account before credit is required |
| `WATCH_ALERT_PRICE` | `0.5` | UCT per alert |
| `WATCH_PACK_ALERTS` | `10` | Alerts per top-up request |
| `WATCH_POLL_MS` | `120000` | Watch pass cadence |
| `WATCH_BILL_TTL_HOURS` | `48` | An unanswered request lapses — same outcome as a decline |
| `WATCH_ENABLED` | `true` | `false` leaves the free concierge running and nothing else |
| `DRY_RUN` | `false` | Log every intended action, touch nothing |

There is no refund setting, and no `MIN_BALANCE` consulted before a payout,
because there is no payout. `MIN_BALANCE` gates exactly one thing: the
bootstrap mint.

---

## Layout

```
src/
  index.js                 modes: default daemon · --whoami --doctor --mint --demo
  agent.js                 the loop: feed debounce, watch timer, bill sweep, events
  demo.js                  the narrated offline walk-through (real code, fake market)
  sphere-client.js         SDK wiring — request-only; read the method list
  state.js                 the ledger: accounts, credit in base units, watches, bills
  config.js                every knob, frozen, defaulted
  ratelimit.js  logger.js
  services/
    concierge.js           the single ranking path: search, score, de-dupe, exclude self
    watchlist.js           watches, alerts, credit, the bill lifecycle, DM grammar
wallet-data/               mnemonic + state — GITIGNORED, mode 0600
```

## Tests

```bash
npm test
```

97 assertions across two offline suites — no network, no wallet, no funds.

**`test-watch-ledger-unit.mjs`** (73) drives the real `watchlist.js` and the real
`State` over a fake sphere, and pins the three ways the design could quietly stop
being true: an alert delivered on credit that does not exist; a request announced
as sent when `create()` reported failure; and any inbound amount creating a debt.
The fake sphere carries a `payments.send` that nothing calls — the suite asserts
its call count stays **0** through every branch, including the odd top-up and the
unsolicited transfer, which are exactly the branches where a refund would be a
custodial agent's job.

**`test-mint-gate-unit.mjs`** (24) pins request-only as *structural* (the absence
assertions above) and the one balance-gated decision left in the agent: the
bootstrap mint. `payments.assets()` resolves with an **empty array** when the
wallet-api is unreachable rather than throwing, so at the call site an outage and
an empty wallet are identical — and reading one as the other would fire a second
self-mint onto an already-funded wallet. The refusal is scoped to a *pre-existing*
wallet: one generated on this very boot cannot already hold funds, so a genuinely
new identity still performs its documented one-time mint.

Suites that move real UCT are deliberately **not** published — they embed an
oracle API key and read a mnemonic. `.gitignore` ignores `test-*.mjs` by default
and negates only the two offline files, so a new live test stays private unless
someone opts it in.

---

## Sibling agents (CRYPTFRANI fleet, testnet2)

Each one holds a different position on custody. That is the point of running five.

| Agent | Primitive | Custody |
|---|---|---|
| **@frani-agent** | market discovery — standing watches | **none** — no send path exists |
| **@market-digest** | scheduled signed reports | none needed |
| **@frani-agora** | signed quote → invoice → settlement certificate | transient |
| **@frani-bounty** | bounty escrow, poster vs worker | custodial, on purpose |
| **@frani-treasury** | grants, loans, repayment reputation | custodial, on purpose |

---

Runs on **testnet2** with test-only UCT. Not financial software; provided as-is.

MIT © Itachi (CRYPTFRANI) — see [LICENSE](LICENSE).
