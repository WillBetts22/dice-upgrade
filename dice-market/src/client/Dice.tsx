import { useEffect, useState } from 'react';
import type { DiceResultRecord } from '../shared/types.js';
import { upName } from './common.js';

function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/** Animates a stored result. Replay re-animates the same numbers; nothing is ever rerolled. */
export function DiceReveal({ rec, startedAt }: { rec: DiceResultRecord; startedAt?: number }) {
  const [reduced, setReduced] = useState(prefersReducedMotion);
  const [play, setPlay] = useState(0);
  const [stage, setStage] = useState(reduced ? 3 : 0);
  const r = rec.resolution;
  const hasReroll = r.rerollIndices.length > 0;

  useEffect(() => {
    if (reduced) {
      setStage(3);
      return;
    }
    setStage(0);
    const ts = [setTimeout(() => setStage(1), 1100), setTimeout(() => setStage(hasReroll ? 2 : 3), 1900), setTimeout(() => setStage(3), hasReroll ? 2900 : 1900)];
    return () => ts.forEach(clearTimeout);
  }, [play, reduced, hasReroll, startedAt]);

  const faces = stage >= 2 ? r.finalDice : r.originalDice;
  return (
    <div className="stack">
      <div className="dice" aria-label="Your dice" style={{ paddingBottom: 32 }}>
        {faces.map((f, i) => {
          const target = r.rerollIndices.includes(i);
          const cls = ['die', stage === 0 ? 'rolling' : '', stage >= 1 && target ? 'rerolled' : '', stage >= 2 && f === 6 ? 'six' : ''].join(' ');
          // One stacked label per die so "was N" and "= 5 pts" never overlap.
          const tags: string[] = [];
          if (stage >= 1 && target) tags.push(stage >= 2 ? `was ${r.originalDice[i]}` : 'reroll');
          if (stage >= 3 && r.equipment.includes('loaded_dice') && f === 1) tags.push('= 5 pts');
          return (
            <div key={i} className={cls}>
              {stage === 0 ? '?' : f}
              {tags.length > 0 && (
                <span className="tag">
                  {tags.map((t) => (
                    <span key={t}>{t}</span>
                  ))}
                </span>
              )}
            </div>
          );
        })}
      </div>
      {stage >= 3 && (
        <table>
          <tbody>
            <tr>
              <td>Points</td>
              <td className="num">{r.effectivePoints.join(' + ')} = {r.pointTotal}</td>
            </tr>
            <tr>
              <td>Base payout (5 per point)</td>
              <td className="num">{r.basePayout}</td>
            </tr>
            {r.floorAdjustment > 0 && (
              <tr>
                <td>Safety Net floor</td>
                <td className="num">+{r.floorAdjustment}</td>
              </tr>
            )}
            {r.sixBonus > 0 && (
              <tr>
                <td>Six Hunter</td>
                <td className="num">+{r.sixBonus}</td>
              </tr>
            )}
            {r.jackpotBonus > 0 && (
              <tr>
                <td>Jackpot</td>
                <td className="num">+{r.jackpotBonus}</td>
              </tr>
            )}
            <tr>
              <td>
                <strong>Dice payout</strong>
              </td>
              <td className="num">
                <strong>{r.payout}</strong>
              </td>
            </tr>
          </tbody>
        </table>
      )}
      <div className="row small">
        <span className="muted">Equipped: {r.equipment.length ? r.equipment.map(upName).join(', ') : 'nothing'}</span>
        <button className="btn small" onClick={() => setPlay((x) => x + 1)} disabled={reduced}>
          Replay
        </button>
        <label className="row" style={{ margin: 0 }}>
          <input type="checkbox" checked={reduced} onChange={(e) => setReduced(e.target.checked)} /> Reduced motion
        </label>
      </div>
    </div>
  );
}

export function DiceRow({ rec }: { rec: DiceResultRecord }) {
  const r = rec.resolution;
  return (
    <div className="dice" style={{ gap: 4 }}>
      {r.finalDice.map((f, i) => (
        <div key={i} className={`die small ${r.rerollIndices.includes(i) ? 'rerolled' : ''} ${f === 6 ? 'six' : ''}`}>
          {f}
        </div>
      ))}
    </div>
  );
}
