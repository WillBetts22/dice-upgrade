import { useState } from 'react';
import type { PlayerRoundReview, ReviewItem, Verdict } from '../shared/review.js';
import type { Snapshot } from '../shared/types.js';
import { playerName, upName } from './common.js';

const money = (x: number) => `${x >= 0 ? '+' : '−'}${Math.abs(x).toFixed(2)}`;

const VERDICT_LABEL: Record<Verdict, string> = { good: 'good', ok: 'neutral', bad: 'costly', info: 'note' };

function Ev({ v }: { v: number | null }) {
  if (v === null) return <span className="muted">–</span>;
  return <span className={v > 1 ? 'pos' : v < -1 ? 'neg' : ''}>{money(v)}</span>;
}

function ItemRow({ it }: { it: ReviewItem }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <tr onClick={() => setOpen((x) => !x)} style={{ cursor: 'pointer' }}>
        <td className="small muted">{new Date(it.at).toLocaleTimeString([], { minute: '2-digit', second: '2-digit' })}</td>
        <td>
          <span className={`badge ${it.verdict === 'good' ? 'top' : it.verdict === 'bad' ? 'owes' : ''}`}>{VERDICT_LABEL[it.verdict]}</span> {it.title}
        </td>
        <td className="num">
          <Ev v={it.evExAnte} />
        </td>
        <td className="num">
          <Ev v={it.evExPost} />
        </td>
      </tr>
      {open && (
        <tr>
          <td />
          <td colSpan={3} className="small">
            <p>{it.detail}</p>
            {it.better && (
              <p>
                <strong>Better:</strong> {it.better}
              </p>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

function QuietRows({ items }: { items: ReviewItem[] }) {
  const [open, setOpen] = useState(false);
  const unfilled = items.filter((i) => i.kind === 'unfilled').length;
  const cancels = items.length - unfilled;
  return (
    <>
      <tr onClick={() => setOpen((x) => !x)} style={{ cursor: 'pointer' }}>
        <td />
        <td className="muted">
          {open ? 'Hide' : 'Show'} {unfilled} unfilled order{unfilled === 1 ? '' : 's'} and {cancels} cancel{cancels === 1 ? '' : 's'} (no effect on your score)
        </td>
        <td />
        <td />
      </tr>
      {open && items.map((it, i) => <ItemRow key={`q${i}`} it={it} />)}
    </>
  );
}

/** Decomposition card: score = start value + trading EV − equipment loss + dice luck. */
export function ReviewSummary({ r }: { r: PlayerRoundReview }) {
  const s = r.summary;
  return (
    <table>
      <tbody>
        <tr>
          <td>Starting value (100 coins + expected value of your starting card)</td>
          <td className="num">{s.startValue.toFixed(2)}</td>
        </tr>
        <tr>
          <td>Trading EV (sum of the trades below)</td>
          <td className="num">
            <Ev v={s.tradingEV} />
          </td>
        </tr>
        <tr>
          <td>Equipment loss vs your best possible pair{s.bestPossiblePair.length ? ` (${s.bestPossiblePair.map(upName).join(' + ')})` : ''}</td>
          <td className="num">
            <Ev v={-s.equipmentLoss} />
          </td>
        </tr>
        <tr>
          <td>Dice luck (actual payout − expected {s.expectedPayoutEquipped.toFixed(2)})</td>
          <td className="num">
            <Ev v={s.luck} />
          </td>
        </tr>
        <tr>
          <td>
            <strong>Round score</strong>
          </td>
          <td className="num">
            <strong>{s.score}</strong>
          </td>
        </tr>
      </tbody>
    </table>
  );
}

export function RoundReview({ r, title }: { r: PlayerRoundReview; title?: string }) {
  const trades = r.items.filter((i) => i.evExPost !== null);
  // Unfilled orders and cancels change nothing; fold them into one row.
  const quiet = r.items.filter((i) => i.kind === 'unfilled' || i.kind === 'cancel');
  const main = r.items.filter((i) => i.kind !== 'unfilled' && i.kind !== 'cancel');
  const best = trades.reduce<ReviewItem | null>((a, b) => (!a || (b.evExPost ?? 0) > (a.evExPost ?? 0) ? b : a), null);
  const worst = trades.reduce<ReviewItem | null>((a, b) => (!a || (b.evExPost ?? 0) < (a.evExPost ?? 0) ? b : a), null);
  return (
    <div className="card stack">
      <h3>{title ?? `Decision review, round ${r.roundNumber}`}</h3>
      <ReviewSummary r={r} />
      {best && worst && best !== worst && (
        <p className="small">
          Best decision: <strong>{best.title}</strong>. Costliest: <strong>{worst.title}</strong>.
        </p>
      )}
      {r.items.length === 0 ? (
        <p className="muted small">No decisions to review this round.</p>
      ) : (
        <div className="scroll-x">
          <table>
            <thead>
              <tr>
                <th>Time</th>
                <th>Decision (tap for detail)</th>
                <th title="Using only what was known when you decided">EV then</th>
                <th title="Using the final round high">EV final</th>
              </tr>
            </thead>
            <tbody>
              {main.map((it, i) => (
                <ItemRow key={i} it={it} />
              ))}
              {quiet.length > 0 && <QuietRows items={quiet} />}
            </tbody>
          </table>
        </div>
      )}
      <p className="small muted">
        EV is expected coins under the strategy guide's model: dice value at exact expected payouts, short deductions at the round high. Dice
        luck is separate, so a good decision can still lose coins on the roll.
      </p>
    </div>
  );
}

/** End-of-session report: one player's reviews for every round plus totals. */
export function SessionReport({ s, playerId }: { s: Snapshot; playerId: string }) {
  const mine = (s.reviews ?? []).filter((r) => r.playerId === playerId).sort((a, b) => a.roundNumber - b.roundNumber);
  if (!mine.length) return null;
  const sum = (f: (r: PlayerRoundReview) => number) => mine.reduce((a, r) => a + f(r), 0);
  const allItems = mine.flatMap((r) => r.items.map((it) => ({ ...it, round: r.roundNumber })));
  const bad = allItems.filter((i) => i.verdict === 'bad').sort((a, b) => (a.evExPost ?? 0) - (b.evExPost ?? 0)).slice(0, 3);
  return (
    <div className="stack">
      <div className="card stack">
        <h2>Your decision report{s.you.kind === 'host' ? `: ${playerName(s, playerId)}` : ''}</h2>
        <div className="strip">
          <div className="stat">
            <div className="k">Trading EV</div>
            <div className="v">
              <Ev v={sum((r) => r.summary.tradingEV)} />
            </div>
          </div>
          <div className="stat">
            <div className="k">Equipment loss</div>
            <div className="v">
              <Ev v={-sum((r) => r.summary.equipmentLoss)} />
            </div>
          </div>
          <div className="stat">
            <div className="k">Dice luck</div>
            <div className="v">
              <Ev v={sum((r) => r.summary.luck)} />
            </div>
          </div>
          <div className="stat">
            <div className="k">Decisions rated costly</div>
            <div className="v">{allItems.filter((i) => i.verdict === 'bad').length}</div>
          </div>
        </div>
        {bad.length > 0 && (
          <div>
            <h3>Biggest lessons</h3>
            <ul>
              {bad.map((b, i) => (
                <li key={i}>
                  Round {b.round}: {b.title}. {b.better}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
      {mine.map((r) => (
        <RoundReview key={r.roundId} r={r} />
      ))}
    </div>
  );
}

/** Host view after the session: every player's decomposition, then drill into one. */
export function HostReviewTable({ s }: { s: Snapshot }) {
  const [pick, setPick] = useState<string | null>(null);
  const reviews = s.reviews ?? [];
  if (!reviews.length) return null;
  const ids = [...new Set(reviews.map((r) => r.playerId))];
  const rows = ids
    .map((id) => {
      const rs = reviews.filter((r) => r.playerId === id);
      const t = (f: (r: PlayerRoundReview) => number) => rs.reduce((a, r) => a + f(r), 0);
      return { id, trading: t((r) => r.summary.tradingEV), equip: t((r) => r.summary.equipmentLoss), luck: t((r) => r.summary.luck), score: t((r) => r.summary.score) };
    })
    .sort((a, b) => b.trading - a.trading);
  return (
    <div className="card stack">
      <h3>Decision quality (all players)</h3>
      <p className="small muted">Sorted by trading EV: who made the best decisions, separate from dice luck. Tap a player to open their report.</p>
      <div className="scroll-x">
        <table>
          <thead>
            <tr>
              <th>Player</th>
              <th>Trading EV</th>
              <th>Equipment loss</th>
              <th>Dice luck</th>
              <th>Total score</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} onClick={() => setPick(r.id)} style={{ cursor: 'pointer' }}>
                <td>{playerName(s, r.id)}</td>
                <td className="num">
                  <Ev v={r.trading} />
                </td>
                <td className="num">
                  <Ev v={-r.equip} />
                </td>
                <td className="num">
                  <Ev v={r.luck} />
                </td>
                <td className="num">{r.score}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {pick && <SessionReport s={s} playerId={pick} />}
    </div>
  );
}
