import { MAX_WIDTH, POSITION_LIMIT, ROUND_TYPE_IDS, ROUND_TYPES } from '../shared/rules.js';

export function RulesSummary() {
  return (
    <div className="stack">
      <h2>How to play</h2>
      <ol className="small">
        <li>Each round the server secretly deals 10 cards. The contract settles at their sum: ace 1, number cards face value, J 11, Q 12, K 13. The average is 70.</li>
        <li>You get a private card at the start and two more over the round. Public cards are revealed at regular intervals the host sets (2, then 4, then 7 cards). The rest show at settlement.</li>
        <li>
          Quote a bid and an ask at most {MAX_WIDTH} apart. Others can buy from your ask or sell to your bid. You can only trade with others while your own two-sided quote is live. A bid at or above someone's ask buys from them at their price (an ask at or below a bid sells to it), and the rest of your quote stays up.
        </li>
        <li>
          Nobody tells you the fair value: work it out from the cards you can see. Each card you cannot see is worth, on average, what is left of the deck divided by the cards left.
        </li>
        <li>Score each round = cash + position x settlement. Positions are limited to {POSITION_LIMIT} lots long or short and reset each round.</li>
        <li>After each round, your decision review shows the expected value of every trade and quote given what you knew, and what would have been better.</li>
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
