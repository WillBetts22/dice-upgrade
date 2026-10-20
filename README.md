# Dice Upgrade

A live multiplayer browser game for 20 to 30 players. A host opens a room, everyone joins from their phone with a short code, and players trade dice upgrades in a real bid/ask market before rolling. You can sell upgrades you do not own, but uncovered shorts are charged at the round's highest traded price.

**Live:** https://web-production-3b3d3.up.railway.app

Everything is server-authoritative: one Node process owns matching, timers, inventory, cash, dice and scoring, and persists every change to Postgres in a transaction. Browsers only send commands and render snapshots.

- [Rules of the game](#rules-of-the-game)
- [Running it locally](#running-it-locally)
- [Hosting on Railway](#hosting-on-railway)
- [Tests and balance checks](#tests-and-balance-checks)
- [Architecture](#architecture)
- [Assumptions, limitations and future work](#assumptions-limitations-and-future-work)
- [Facilitator guide](docs/facilitator-guide.md) · [Balance report](docs/balance-report.md) · [Deployment notes](docs/deployment.md)

---

## Rules of the game

### Session format

- The host picks **1 to 6 rounds** (default 2) before starting. The round count then locks.
- Projected session length is **5 minutes of explanation + 10 minutes per round**, so the default is 25 minutes.
- Each round:
  1. **Market, 7 minutes.** Continuous trading.
  2. **Settlement + selection, 1 minute.** The market closes, uncovered shorts are settled automatically, then players pick their upgrades.
  3. **Reveal + results, 2 minutes.** Everyone's dice resolve at the same time, then scores are shown.
- The next round starts automatically after results unless the host pauses. The host can also start the next round early from the results screen.
- Everything resets each round: cash, positions, order books, round highs, equipment, deductions, dice. Only identities, deal history and completed round results carry over.
- The **overall score is the sum of every round score**. Negative round scores stay negative and count. Equal totals share a rank.
- Coins are pretend money.

### Starting each round

- Every player gets **100 coins** and **one upgrade card**.
- Each round, the server picks a shared active pool of **4 of the 6 upgrade types**. Only those four can be traded, shorted or equipped that round. The pool, rules and total supply are shown before the market opens, and no surprise upgrade is ever added.
- Cards are dealt so that each active type's count differs by at most one, and so that each player's total expected endowment value across the session stays within 3 coins of everyone else's.

### Dice and upgrades

You roll **five fair six-sided dice** and earn **5 coins per point**. With no upgrades, a roll of 2, 3, 4, 5, 6 pays 100 coins.

After the market, you may **equip up to two different upgrade types you own** (a positive position). Extra copies do nothing, and owing an upgrade never gives you its effect.

| Upgrade | Effect |
|---|---|
| **Extra Die** | Roll one additional independent die, for six dice total. |
| **Second Chance** | Reroll up to two of your lowest dice worth 1, 2 or 3 points, once each. You keep the replacements even if they are worse. Loaded Dice values count when deciding which dice qualify. Ties go to the earlier die. |
| **Loaded Dice** | Each 1 counts as 5 points instead of 1, including on rerolled dice. |
| **Six Hunter** | +20 coins for each final 6. |
| **Jackpot** | +85 coins once if at least two final dice are 6. |
| **Safety Net** | If the base payout would be under 100, raise it to 100. Six Hunter and Jackpot bonuses apply on top. |

Resolution order: extra die, initial roll, Loaded Dice preview, choose up to two lowest dice worth at most 3 points, one replacement per chosen die, final Loaded Dice values, base payout, Safety Net floor, then Six Hunter and Jackpot. A 1 worth 5 points under Loaded Dice is not reroll-eligible, and a replacement never triggers another reroll.

If selection time runs out, your valid picks are kept and any empty slot is filled from what you own in the table's order above. Your starting upgrade is preselected if you still own it.

### Score

```
round score = trading cash + dice payout - short deductions
```

Your starting 100 coins are part of trading cash, so nothing extra is added at scoring. Scores can go negative.

The results screen also shows a **net trading result** = trading cash − 100 − short deductions. Starting cards are a free endowment, so they are not counted as a cost.

### The market

- Each active upgrade has its own order book.
- A **bid** is an offer to buy ("buy at most X"). An **ask** is an offer to sell ("sell for at least X").
- Prices are whole coins from **1 to 50**. Each order is for **1 or 2 units**. You can have **at most 12 open orders** in total.
- **Matching:** crossing orders trade automatically. The best price goes first (highest bid, lowest ask), then the earliest order. The trade happens at the **resting order's price**: a new bid at 20 against a resting ask at 15 trades at 15, and a new ask at 12 against a resting bid at 18 trades at 18. Partial fills leave the rest on the book.
- **Accepting a quote:** you can tap any specific order on the book to trade against it at its price, even if it is not the best one. If that order changed or vanished in the meantime, you are asked to refresh, and nothing trades against a different order.
- **No self-trades.** An order that would cross one of your own resting orders is rejected, and you are told to cancel that quote first.
- To edit an order, cancel it and post a new one. The new order goes to the back of the time queue.
- **Bids reserve cash.** Spendable cash = cash − the full value of your open bids, and it can never go below zero. Cancelling a bid releases its reserve. Money from a sale becomes spendable once the sale executes.
- Every trade appears immediately on the public **trade tape** with upgrade, price, quantity, buyer, seller and time.
- Each book shows the best bid, best ask, last trade and the **round high**. The round high is the highest price any real trade between players reached this round. Quotes, cancels, rejected orders and bank closeouts never move it. It only goes up during a round.

### Short selling and closeout

- Each player has one signed position per upgrade. `+2` means you own two, `0` means none, `-1` means you **owe** one.
- Selling below zero is a **short sale**: the buyer gets a real, usable unit, and you take on an obligation. There is no borrowing fee.
- Buying while you are short **covers** the short first. It takes you from `-1` to `0`; you need one more purchase to own one you can equip.
- **Short limit:** you can owe at most **2 units in total**, counting the worst case where all your open asks fill. For each type that is `max(0, open ask units − position)`, summed across types. Two asks against one owned unit can therefore create one short.
- No collateral is locked for shorts. You can keep trading and rolling even if your deductions exceed your cash.
- **At market close:** new trades are rejected, open orders are cancelled, each type's round high is frozen, and every remaining short is closed exactly once by the game bank. For each unit owed, the **round high** of that type is deducted from your score. If an upgrade never traded, a fallback of 10 coins is used, though in normal play a short always comes from a trade.
- The bank's purchase settles your obligation. It does not give you a unit you can equip, and it does not take anything from long holders, who keep their upgrades. Deductions come out of your score, not out of your cash, and are not paid to anyone.
- With prices capped at 50 and at most 2 owed units, short deductions are at most **100 coins per round**.

**Example.** Alex starts with 100 coins and no Extra Die, and sells one Extra Die to Bea at 12. Alex now has 112 coins and a position of −1.
- If Alex buys one back from Chen at 9, Alex is flat with 103 coins. That is +3 on the two trades, and there is no charge even if the Extra Die high later reaches 30.
- If Alex stays short and the Extra Die high reaches 30, Alex keeps the 112 coins and gets a 30 point deduction, for a net trading result of −18. With a dice payout of 100, Alex scores 112 + 100 − 30 = **182**.

### Public information

- The **Holdings** tab lists every player's exact signed quantity of every active upgrade. It highlights the largest holder and who owes units, so you can see who can sell you a scarce upgrade.
- Named orders on the book and every executed trade are public.
- Your cash, reserved cash and selections are private until results.

### Fairness

Everyone gets the same cash, one card from a similarly valued catalog, and access to the same randomized market. Dice luck still affects results. The [balance report](docs/balance-report.md) has the exact expected values.

---

## Running it locally

Requires Node 22 or newer. No database install is needed: without `DATABASE_URL`, the server uses an embedded Postgres (PGlite) stored in `./data/pglite`.

```bash
npm install
npm run dev          # API + WebSocket on :3000, Vite UI on http://localhost:5173
```

Or run the production build on one port:

```bash
npm run build
npm start            # http://localhost:3000 (set PORT to change it)
```

To try a full game alone, create a room with **Test mode** ticked, press **Add 5 bots**, then open `/play/<CODE>` in a private window to join as yourself. Bots go through exactly the same command path as real players and only exist in test-mode rooms. Test mode also lets the host skip phases.

### Environment

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | HTTP and WebSocket port |
| `DATABASE_URL` | unset | Postgres connection string. When unset, embedded PGlite is used. |
| `PGLITE_DIR` | `./data/pglite` | Where PGlite stores data when `DATABASE_URL` is unset |
| `STATIC_DIR` | `dist/client` | Built client files |

See [.env.example](.env.example).

## Hosting on Railway

Railway runs one long-lived Node process with WebSockets and a managed Postgres, which is exactly what the game needs. Vercel's serverless functions cannot hold WebSocket connections or run phase timers, so Vercel is not suitable.

1. `npm i -g @railway/cli && railway login`
2. In this folder: `railway init` (new project), then `railway add --database postgres`.
3. Create the app service and point it at the database: `railway add --service web --variables 'DATABASE_URL=${{Postgres.DATABASE_URL}}'`
4. `railway up --service web` to deploy, then `railway domain --service web` for a public URL.

[railway.json](railway.json) sets the build command, start command, `/healthz` health check and **one replica**. Run a single instance: room state is served from that process's memory, with Postgres as the durable source of truth. See [docs/deployment.md](docs/deployment.md) for details and other hosts.

## Tests and balance checks

```bash
npm test             # engine, dice, settlement, persistence/restart, 30-client WebSocket session, balance
npm run typecheck
npm run balance      # regenerates docs/balance-report.md and .json; exits non-zero if any release check fails
npm run simulate -- http://localhost:3000   # drives 30 headless clients through a live server
```

What the tests cover, as listed in section 9 of the spec:

- **Matching:** price/time priority, execution at the resting price, partial fills, cancellation, stale quote rejection, self-trade rejection, invalid inputs, bid reserves, overlapping asks, the short cap under adversarial order sequences, covering with available cash, unauthorized actions, and 2000-step random sequences that check cash and supply conservation after every accepted change.
- **Settlement:** the 12/9/30 examples (net +3 with no charge, or net −18 with a 30 deduction and a 182 score), round highs ignoring quotes and cancels, the fallback price, the 100-coin cap, and no double settlement.
- **Dice:** every fixture from the spec, using injected draws.
- **Persistence and concurrency:** five concurrent accepts of the last unit give exactly one fill; a cancel racing an accept never duplicates anything; duplicate request IDs return the original receipt, including after a restart; orders at or after the deadline are rejected; a double-fired timer settles once; a crash between Settling and Selection recovers exactly once; pause and resume keep the remaining time; no dice exist before the selection deadline; refreshing or restarting during reveal shows the same stored result; the next round resets while past results persist; sessions of 1, 2 and 6 rounds end in Finished.
- **End to end:** 30 WebSocket clients plus a spectator play a full 2-round session against the real server, with room and credential isolation checks.

## Architecture

```
src/shared/     catalog, dice resolution, rules constants, wire types (used by server and client)
src/server/
  engine/       pure game logic: market.ts (matching, reserves, exposure), rounds.ts (deal, settle,
                select, resolve, rank), deal.ts (fair pools), room.ts (commands + phase machine)
  manager.ts    per-room serialization, idempotent command receipts, commit-then-broadcast, timers
  persist.ts    transactional writes and restart loading; db.ts has the schema (Postgres or PGlite)
  server.ts     HTTP API, static files, WebSocket protocol; view.ts builds snapshots/deltas
  bots.ts       test-mode bots that use the normal command path
src/client/     React UI: landing/join, player market, holdings, selection, reveal, results,
                host dashboard, projector view
src/tools/      balance tooling and the headless simulation client
test/           vitest suites
```

How a market command is processed: authenticate the session, queue behind the room's lock, check for a duplicate request ID, check the phase and the server deadline, validate the inputs, and simulate the matching on a draft copy of the round. It then checks every affected account's spendable cash and short exposure, commits the orders, trades, accounts, highs, ledger entries and receipt in **one transaction** (with a check that the room revision has not moved), and only then swaps the draft in and broadcasts the new revision. Any failed check discards the draft.

Phase changes are driven by deadlines stored in the database, not by in-memory timers, so a restarted server finishes an overdue phase exactly once. Unique keys on settlements `(round, player, type)` and dice results `(round, player)` block duplicates at the database level.

## Assumptions, limitations and future work

**Decisions I made where the spec left room:**

- **Phase timing:** the 2-minute reveal-and-results allowance is split into 60 s of reveal and 60 s of results. The host can change all four durations in the lobby.
- **Settlement:** Settling is recorded as its own committed step (market closed, orders cancelled), followed immediately by the settlement transaction. A crash between the two resumes cleanly.
- **Selection timeout:** the fallback always fills empty slots from owned types in catalog order, as the spec says. A player who deliberately clears a slot will still have it filled at the deadline. Every allowed pair is worth at least as much as either single, so filling never lowers a player's expected payout. The screen explains this rule before the deadline.
- **Joining:** the browser generates the session token and the server stores only its hash. A retried join is therefore idempotent, and reconnecting on the same device restores the same player.
- **Host as player:** the host joins as a normal player with a separate player credential and counts toward the 30-player cap.
- **Bots:** only available in rooms created with test mode on.
- **Pools:** all 15 four-type pools pass the balance checks and each mixes straightforward and situational effects, so pool version `v1-all15` approves all of them.

**Known limitations:**

- Run **one server instance**. Command order is guaranteed by an in-process lock per room. A second instance would make its revision checks fail rather than corrupt data, but it would not serve consistent live state. Sharing rooms across instances would need a shared lock or sticky routing.
- The highest-executed-price closeout rule deliberately lets other players' trades raise a short seller's liability. Price caps and the 2-unit short limit bound the damage at 100 coins per round, but **this market is not manipulation-proof**: collusion and squeezes are possible. This is a game convention, not a model of real exchange settlement.
- The upgrade values and the 50-coin cap are prototype settings that need playtesting. They are not claims of established balance. The balance report checks expected payouts, not strategic balance.
- Receipts for rejected commands are stored too, so retrying a rejected request ID returns the same rejection. The client always uses a new request ID for a new attempt.
- There are no accounts, chat, payments or tournaments, by design.

**Suggested future work (not implemented):** a host-selectable alternative closeout rule (any rule change should be proposed explicitly first), shared-lock multi-instance support, a downloadable audit-ledger export for the host, and per-player order history.
