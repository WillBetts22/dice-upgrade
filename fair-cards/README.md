# Fair Cards

A live market-making game for 2 to 30 people. Everyone trades one contract whose value is hidden; each player holds a piece of the information, more arrives over time, and the price finds the answer. After every round each player gets a review of every decision: what it was worth given what they knew, and what would have been better.

## Rules

**The contracts.** Each round the server secretly deals 10 cards from a standard deck: ace 1, number cards face value, J 11, Q 12, K 13. There are two markets on the same cards (the host can turn the second off):

| Market | Pays | Before anything is revealed | Max width | Max size | Position limit |
|---|---|---|---|---|---|
| Sum | sum of all 10 cards | exactly 70 | 4 | 5 | 10 |
| Product | product of the 3 marked product cards (P) | about 337 (median 210, skewed) | 40 | 3 | 3 |

Players switch between the markets with tabs. Each market has its own quote, positions and P&L; a round's score is both added together. The same piece of information can be worth a lot in one market and little in the other, so players have to work out both fair values and trade where their edge is.

**Personal clues.** Besides private cards, each player gets private clues: true statements about the hidden cards, different for everyone, such as "the 10 cards add up to a multiple of 6", "the product has exactly 2 distinct prime factors" or "the highest product card is a 9". Clues use face values and are not changed by news. The host sets how many private cards (at the open and at each of the first two reveals) and how many clues each player gets.

**Information.** By default the market lasts 8 minutes and new information lands every 2 minutes:

| When (default) | Each player privately gets | Revealed to everyone |
|---|---|---|
| Open | 1 card, 1 clue | none |
| 2:00 | +1 card, +1 clue | 2 cards |
| 4:00 | +1 card, +1 clue | 4 cards total |
| 6:00 | none | 7 cards total |
| Close (8:00) | | all 10, settlement |

**Host timing controls** (plus and minus buttons in the lobby): briefing length, market length, results length, time between reveals (15 s to 7:30; a longer gap stretches the market so the last reveal still leaves 15 s to trade), news shocks per news round (1 to 6, spread evenly with some randomness and kept clear of reveals), and time between a player's quote updates (0 to 60 s).

Private cards are spread so each card is seen by roughly the same number of people, with the cards that stay hidden longest dealt first. Alone you know a little; together the room knows nearly everything.

**Quoting.** Every player posts a two-sided quote: a bid (you buy at) and an ask (you sell at), at most 4 apart, 1 to 5 lots each side. Anyone can buy from your ask or sell to your bid. You can only trade with others while your own two-sided quote is live, so everyone is a market maker. A quote through someone else's price trades at once at their price, best price first, like a limit order on a real exchange: bid 74 into an ask of 69 and you buy at 69, up to their size, and the rest of your quote rests in the book. The host can optionally limit how often each player posts a new quote (off by default, up to 60 s); pulling a quote is always allowed.

**Scoring.** Round P&L = cash + position x settlement. Positions are capped at 10 lots long or short and reset each round. Scores add up across rounds.

**Round types** (the host picks 1 to 6 rounds in any order; the default is all four):

| Round | Twist | Lesson |
|---|---|---|
| Price discovery | Plain rules above | Prices pool information no single person has |
| Makers vs takers | A third of the room are market makers: no private cards, quotes at most 2 wide, a 1 coin rebate per lot filled. Everyone else is a taker with cards who can only trade against makers. | Adverse selection |
| News shocks | Surprise news events (2 by default, host sets 1 to 6) at random times change how the contract settles (face cards double, aces high, red cards void, +15, -20, or two extra hidden cards) | Public news moves prices at once |
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

- `src/shared/cards.ts`: cards, value rules, shocks, exact sum and product fair values.
- `src/shared/clues.ts`: clue generation and fair values given clues (exact without clues; a Metropolis walk over hidden hands consistent with every clue otherwise).
- `src/shared/review.ts`: the decision review analyzer (pure).
- `src/server/engine.ts`: pure game engine; commands, information schedule, trading, settlement.
- `src/server/manager.ts`: per-room serialized commands, optimistic revision check, append-only event log, idempotent receipts.
- `src/server/bots.ts`: test-mode bots.
- `src/client/*`: React player, host and projector screens.
