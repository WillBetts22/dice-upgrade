# Fair Cards

A live market-making game for 2 to 30 people. Everyone trades one contract whose value is hidden; each player holds a piece of the information, more arrives over time, and the price finds the answer. After every round each player gets a review of every decision: what it was worth given what they knew, and what would have been better.

## Rules

**The contract.** Each round the server secretly deals 10 cards from a standard deck. The contract settles at the sum of their values: ace 1, number cards face value, J 11, Q 12, K 13. Before anything is revealed the fair value is exactly 70.

**Information.** Over an 8 minute market (host adjustable):

| When | Each player privately gets | Revealed to everyone |
|---|---|---|
| Open | 1 card | none |
| 1/4 through | +1 card | 2 cards |
| 1/2 through | +1 card | 4 cards total |
| 3/4 through | none | 7 cards total |
| Close | | all 10, settlement |

Private cards are spread so each card is seen by roughly the same number of people, with the cards that stay hidden longest dealt first. Alone you know a little; together the room knows nearly everything.

**Quoting.** Every player posts a two-sided quote: a bid (you buy at) and an ask (you sell at), at most 4 apart, 1 to 5 lots each side. Anyone can buy from your ask or sell to your bid. You can only trade with others while your own two-sided quote is live, so everyone is a market maker. You can post a new quote at most once every 15 seconds (the host can set 0 to 60), so each quote is a considered estimate rather than a reflex; pulling a quote is always allowed. A quote that would cross someone else's price is rejected: trade with them instead.

**Scoring.** Round P&L = cash + position x settlement. Positions are capped at 10 lots long or short and reset each round. Scores add up across rounds.

**Round types** (the host picks 1 to 6 rounds in any order; the default is all four):

| Round | Twist | Lesson |
|---|---|---|
| Price discovery | Plain rules above | Prices pool information no single person has |
| Makers vs takers | A third of the room are market makers: no private cards, quotes at most 2 wide, a 1 coin rebate per lot filled. Everyone else is a taker with cards who can only trade against makers. | Adverse selection |
| News shocks | Two surprise news events at random times change how the contract settles (face cards double, aces high, red cards void, +15, -20, or two extra hidden cards) | Public news moves prices at once |
| Insider | One random player secretly starts with 5 private cards | Spotting informed flow |

**No fair value is shown.** Players work out the fair value themselves from the cards they can see (a full deck totals 364, so each unseen card is worth on average what is left of the deck divided by the cards left). The projector shows trades only. The exact fair values appear in the review once the round settles. A host who is not also playing sees the public fair value on the host screen.

## Decision review

At the end of each round every player sees:

- **Every trade** with its EV then (your fair value minus the price, times lots, signed, plus any rebate) and what it actually made at settlement. Fills on your resting quote are classed as earning the spread, a stale-quote pick-off (your fair value moved after you posted), or a mispriced quote.
- **Quotes** that did not contain your own fair value, unless you were deliberately skewing to cut inventory.
- **Stale quotes**: a reveal or shock moved your fair value outside your quote and you did not pull or move it within 15 seconds.
- **Missed edges**: right after new information, someone's quote was at least 3 coins through your fair value and you did not take it within 30 seconds.
- **Inventory**: ending 8 or more lots long or short.

The summary splits P&L exactly: **P&L = decision edge + information luck**, where decision edge is what your trades were worth given what you knew and information luck is what the cards you could not see did to you. The host sees a table of every player ranked by decision edge.

## Run it

```bash
npm install
npm run dev          # server on :3000, client on :5173 (set API_PORT if 3000 is taken)
npm test             # engine, review, persistence tests
npm run build && npm start
```

Without `DATABASE_URL` it uses an embedded PGlite database in `./data/pglite`. With `DATABASE_URL` it uses Postgres. Tables are prefixed `fc_` so it can share a database with Dice Market.

Routes: `/` landing, `/join/CODE`, `/play/CODE` player, `/host/CODE` host (needs the host credential stored on the creating device), `/screen/CODE` projector.

Test mode (tick the box when creating a room) adds bots and a button that skips to the next reveal.

## Deploy (Railway)

The `fair-cards` service lives in the same Railway project as Dice Market and shares its Postgres:

```bash
cd fair-cards
npx -y @railway/cli up --service fair-cards
```

`DATABASE_URL` on the service references `${{Postgres.DATABASE_URL}}`. One replica only: rooms are held in memory and persisted on every change, so a restart resumes every unfinished room.

## How it is built

- `src/shared/cards.ts`: cards, value rules, shocks, exact fair value.
- `src/shared/review.ts`: the decision review analyzer (pure).
- `src/server/engine.ts`: pure game engine; commands, information schedule, trading, settlement.
- `src/server/manager.ts`: per-room serialized commands, optimistic revision check, append-only event log, idempotent receipts.
- `src/server/bots.ts`: test-mode bots.
- `src/client/*`: React player, host and projector screens.
