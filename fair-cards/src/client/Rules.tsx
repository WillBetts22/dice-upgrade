import { MARKETS, ROUND_TYPE_IDS, ROUND_TYPES } from '../shared/rules.js';

export function RulesSummary() {
  const sum = MARKETS.sum;
  const prod = MARKETS.product;
  return (
    <div className="stack">
      <h2>How to play</h2>
      <ol className="small">
        <li>Each round the server secretly deals 10 cards: ace 1, number cards face value, J 11, Q 12, K 13.</li>
        <li>
          <strong>Sum market:</strong> pays the sum of all 10 cards (about 70 on average). <strong>Product market</strong> (if the host turns it on): 3 of the 10 are marked
          product cards (P), and it pays their product (about 337 on average, but usually less: half the time under 210). Switch between the two with the tabs. Each market has its
          own quote, position and score; your round score is both added together.
        </li>
        <li>
          You get private cards and private clues (like "the sum is a multiple of 6" or "the product has 3 prime factors") at the start and over the round; how many is up to the
          host. Public cards are revealed at regular intervals (2, then 4, then 7 cards). The rest show at settlement. Your information may be worth more in one market than the
          other: trade where your edge is.
        </li>
        <li>
          Quote a bid and an ask: at most {sum.maxWidth} apart and {sum.maxSize} lots in the sum market, at most {prod.maxWidth} apart and {prod.maxSize} lots in the product
          market. Others can buy from your ask or sell to your bid. You can only trade with others in a market while your own two-sided quote there is live. A bid at or above
          someone's ask buys from them at their price (an ask at or below a bid sells to it), and the rest of your quote stays up.
        </li>
        <li>Nobody tells you the fair value: work it out from the cards and clues you have.</li>
        <li>
          Score in each market = cash + position x settlement. Positions are limited to {sum.positionLimit} lots in the sum market and {prod.positionLimit} in the product market,
          and reset each round.
        </li>
        <li>After each round, your decision review shows the expected value of every trade and quote in each market given what you knew, and what would have been better.</li>
      </ol>
      <h3>Round types</h3>
      <ul className="small">
        {ROUND_TYPE_IDS.map((t) => (
          <li key={t}>
            <strong>{ROUND_TYPES[t].name}:</strong> {ROUND_TYPES[t].rules}
          </li>
        ))}
      </ul>
    </div>
  );
}
