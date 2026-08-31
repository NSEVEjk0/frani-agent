# frani-agent

A market discovery agent on Unicity **testnet2**. `market.search` answers what is
listed *right now* — ask it for GPU hours before anyone is selling GPU hours and you
get nothing, and there is nowhere to leave the question. This daemon is that missing
piece: it holds your query as a **standing watch**, re-runs it against the live board on
its own schedule, and DMs you the moment supply appears that was not there before.

Discovery is the whole product. It does not notarize text, sell reports, escrow rewards,
quote deals or lend UCT. Its siblings do those.

**Live as `@frani-agent`**, holding 100 UCT.
Address: `DIRECT://00007a2c3ff6bc11ce43427029117eb047afa8606fa11cf433df50af76fcb273a2ba6f0e2391`

---

## Track

**Autonomous agents** — discovery

## Is it Agentic?

**Yes.** Nobody asks it to run a pass. It decides when to search, what counts as new,
who is owed an alert, when to bill and when to stop asking.

## Runs on AstridOS?

**No** — a Node.js daemon under `systemd` on Linux.

## SDK features used

| Sphere SDK feature | How it's used here |
|---|---|
| `market.search` | every watch pass and every `find` — the same ranking path |
| `market.subscribeFeed` | a fresh buyer intent is answered with a shortlist in seconds |
| Market intents | publishes its own `service` intent so it is discoverable too |
| `payments.requests` | how alerts are paid for — a request in your wallet, never a pull |
| `payments.assets` | one decision only: whether the bootstrap mint is still needed |
| Direct Messages | watches, alerts, shortlists, credit notices |
| Nametags | `@frani-agent` |
| `mintFungibleToken` | one-time capped self-mint at first launch (testnet2 has no faucet) |

---

## What makes it different

**This agent has no outbound payment rail. Not a disabled one — an absent one.**

Alerts past the free allowance are paid for, so money had to enter the design somewhere.
The obvious shape is the custodial one: name a price, take the UCT, hand over the goods,
refund the difference. That shape needs a send method — and a send method needs a
min-balance floor, a double-pay guard, a retry policy, an unconfirmed-certification
branch, and a suite proving the agent never claims a refund it did not make.

None of that exists here, because alerts are metered against **prepaid credit
denominated in UCT base units**:

```
top-up 1.7 UCT  ·  alerts cost 0.5 UCT
                → 3 alerts released, 0.2 UCT carried
```

An amount that does not divide evenly is not an overpayment. It is a **carry**. There is
nothing to give back, so there is no code that gives anything back:

```js
// src/sphere-client.js
// ── inbound-only money: no send path exists ─────────────────────────────────
/**
 * Deliberately absent: `_send` / `refund` / any `payments.send` wrapper.
 */
```

Settlement is the SDK's own `payments.requests` rail: the agent places a request in your
wallet and **your wallet decides**. It cannot pull funds, cannot chase you, and cannot
strand funds it never held. Decline the request and the answer is complete — nothing is
owed, ever, and the matches it was holding stay held for whenever you come back.

`test-mint-gate-unit.mjs` asserts this **structurally**: it walks the client's prototype
chain for any method named after paying somebody, and greps `src/sphere-client.js` for a
`payments.send(` call site. Both must come back empty. Every custodial sibling in the
fleet fails that test by design.

**The bill goes out for the held match, not after the alert.** A match past your
allowance is *held*, and the credit request is raised for it. An agent that alerted first
and invoiced after would be giving away the paid product and then asking nicely. One open
request per account, ever — a pass that holds three matches raises one request, not three.

**And a request it could not raise is never announced as raised.**
`payments.requests.create()` *resolves* with `{success: false}` when the wallet-api is
unreachable; it does not throw. An agent that reads that as success tells you to check
your wallet for a prompt that is not there while your matches go stale. So the bill is
recorded and announced only when the SDK confirms it; otherwise you are told plainly
that it could not be raised and that nothing is owed, and the next sweep tries again.

---

## How the metering works

| | |
|---|---|
| First **3** alerts per account | free |
| After that | **0.5 UCT** per alert, sold 10 at a time (**5 UCT** a top-up) |
| Setting a watch, `find`, `status`, `watches`, `unwatch`, `help`, `about` | free, always |
| Supply already live when you set a watch | handed over free — a watch bills for *new* supply, never a backlog |

**Two directions of latency, on purpose.** *Push*: the concierge is debounced off
`market.subscribeFeed` — a fresh buyer intent is worth answering in seconds, so it is,
free and unsolicited. *Pull*: watches run on a slow 120 s timer, because a standing want
does not go stale in two minutes and hammering `market.search` for every open watch would
make the agent a bad neighbour. Both go through the *same* ranking path, so a watch can
never surface something `find` would have filtered out.

---

## Try it without a wallet

```bash
npm install && npm run demo
```

Runs the real service module, the real ledger and the real config against a fake market.
It opens **no wallet and no socket**, so unlike `whoami` it is safe to run while the
daemon is up.

- **Happy path** — a watch is set, the free allowance is spent, the next match is
  **held**, one request goes out, they pay 1.7 UCT, the held matches are released and
  0.2 UCT is carried.
- **Failure path** — the request is **declined**. The bill is dropped, the watch is
  paused *still holding its matches*, nothing is owed, and a later payment of any size
  resumes it from exactly there.

It ends by printing the number of payments the agent attempted to send across both paths.
It is zero, and not because a flag was off.

---

## Commands

DM `@frani-agent`.

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

## Run it

```bash
npm install
cp .env.example .env      # optional — every knob has a safe default

npm run doctor            # connectivity + config self-check
npm run demo              # offline walk-through (safe while running)
npm start                 # the autonomous daemon
npm test                  # 97 assertions, two offline suites
```

Node ≥ 22. First launch generates a BIP39 identity, registers the nametag and performs a
**one-time capped self-mint** — testnet2 has no faucet. The phrase prints once and lands
in `wallet-data/` (gitignored, 0600); back it up, or set `WALLET_PASSWORD` to encrypt it
at rest.

> Don't run `whoami`/`doctor` while the service is up — each opens a second connection on
> the same wallet. Use `journalctl -u frani-agent` or the DM `status`.
> `npm run demo` is the exception.

Deploy as a unit with `ExecStart=/usr/bin/node src/index.js` and
`KillSignal=SIGINT` — the agent treats SIGINT as a graceful close: stop timers, persist
state, close the socket.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `WATCH_FREE_ALERTS` | `3` | free alerts per account before credit is required |
| `WATCH_ALERT_PRICE` | `0.5` | UCT per alert |
| `WATCH_PACK_ALERTS` | `10` | alerts per top-up request |
| `WATCH_POLL_MS` | `120000` | watch pass cadence |
| `WATCH_BILL_TTL_HOURS` | `48` | an unanswered request lapses — same outcome as a decline |
| `WATCH_ENABLED` | `true` | `false` leaves the free concierge running and nothing else |
| `DRY_RUN` | `false` | log every intended action, touch nothing |

There is no refund setting and no `MIN_BALANCE` consulted before a payout, because there
is no payout. `MIN_BALANCE` gates exactly one thing: the bootstrap mint.

## Structure

```
src/
  index.js            modes: default daemon · --whoami --doctor --mint --demo
  agent.js            the loop: feed debounce, watch timer, bill sweep, events
  demo.js             the narrated offline walk-through (real code, fake market)
  sphere-client.js    SDK wiring — request-only; read the method list
  state.js            the ledger: accounts, credit in base units, watches, bills
  services/
    concierge.js      the single ranking path: search, score, de-dupe, exclude self
    watchlist.js      watches, alerts, credit, the bill lifecycle, DM grammar
```

## Tests

```bash
npm test   # 97 assertions across two offline suites — no network, no wallet
```

| Suite | What it pins |
|---|---|
| `test-watch-ledger-unit.mjs` | 73 assertions over the real `watchlist.js` and `State` against a fake sphere: no alert is ever delivered on credit that does not exist, no request is announced as sent when `create()` reported failure, and no inbound amount ever creates a debt. The fake sphere carries a `payments.send` that nothing calls — its call count must stay **0** through every branch, including the odd top-up and the unsolicited transfer. |
| `test-mint-gate-unit.mjs` | 24 assertions: request-only as a *structural* property, plus the one balance-gated decision left. `payments.assets()` resolves with an **empty array** when the wallet-api is unreachable rather than throwing, so at the call site an outage and an empty wallet are identical — and reading one as the other fires a second self-mint onto an already-funded wallet. The refusal is scoped to a *pre-existing* wallet, so a genuinely new identity still performs its documented one-time mint. |

Suites that move real UCT are deliberately not published — they read a mnemonic.

## Status on-network

Live since launch: nametag claimed, `service` intent published, buyer intents answered
with ranked shortlists over DM. The watch/credit surface replaced a paid-task shop that
earned nothing (three requests raised, none paid, so retiring it stranded no funds, and
every v1 requester is told so once on boot). That surface is pinned by the 97 offline
assertions above and **has not yet been exercised on-network** — stated plainly rather
than implied.

---

Owner / Creator: **Itachi** · Made by **CRYPTFRANI**
Runs on testnet2 with test-only UCT. Not financial software; provided as-is.
MIT — see [LICENSE](LICENSE).
