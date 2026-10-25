import { MAX_WIDTH, POSITION_LIMIT, ROUND_TYPE_IDS, ROUND_TYPES } from '../shared/rules.js';

export function RulesSummary() {
  return (
    <div className="stack">
      <h2>How to play</h2>
      <ol className="small">
        <li>Each round the server secretly deals 10 cards. The contract settles at their sum: ace 1, number cards face value, J 11, Q 12, K 13. The average is 70.</li>
        <li>You get a private card at the start and two more over the round. Public cards are revealed a quarter, half and three quarters of the way through (2, then 4, then 7 cards). The rest show at settlement.</li>
        <li>
          Quote a bid and an ask at most {MAX_WIDTH} apart. Others can buy from your ask or sell to your bid. You can only trade with others while your own two-sided quote is live.
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
