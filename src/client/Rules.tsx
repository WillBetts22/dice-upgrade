import { CATALOG, type UpgradeId, UPGRADE_IDS } from '../shared/catalog.js';
import { FAIRNESS_NOTE, MAX_DEDUCTION_PER_ROUND, MAX_PRICE, MAX_SHORT_UNITS, STARTING_CASH } from '../shared/rules.js';

export function RulesSummary({ pool }: { pool?: UpgradeId[] }) {
  const types = pool ?? UPGRADE_IDS;
  return (
    <div className="stack">
      <h2>How it works</h2>
      <ul>
        <li>Everyone starts each round with {STARTING_CASH} coins and one upgrade.</li>
        <li>At the end you roll five dice and earn 5 coins per point. Up to two different upgrades you own change the result.</li>
        <li>
          Your score = remaining coins + dice winnings − any uncovered short deductions. Scores can be negative and add up across
          rounds.
        </li>
        <li>
          During the market, post prices to buy (a <strong>bid</strong>) or sell (an <strong>ask</strong>), or accept someone else's
          price. Prices are 1 to {MAX_PRICE} coins.
        </li>
        <li>
          You can sell an upgrade you do not have. Then you <strong>owe</strong> it. Buy it back before time runs out, or that
          upgrade's highest traded price this round is deducted from your score for each unit owed. You can owe at most{' '}
          {MAX_SHORT_UNITS} units in total, so the most you can lose this way is {MAX_DEDUCTION_PER_ROUND} per round.
        </li>
        <li>The Holdings tab shows who owns and who owes each upgrade.</li>
        <li>{FAIRNESS_NOTE}</li>
      </ul>
      <h3>{pool ? 'Upgrades active this round' : 'The upgrade catalog'}</h3>
      <table>
        <tbody>
          {types.map((t) => (
            <tr key={t}>
              <td style={{ width: '32%' }}>
                <strong>{CATALOG[t].name}</strong>
              </td>
              <td className="small">{CATALOG[t].effect}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
