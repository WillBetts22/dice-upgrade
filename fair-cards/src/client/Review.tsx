import { useState } from 'react';
import type { MarketReview, PlayerRoundReview, ReviewItem, Verdict } from '../shared/review.js';
import { type MarketId, MARKET_IDS, MARKETS, ROUND_TYPES } from '../shared/rules.js';
import type { Snapshot } from '../shared/types.js';
import { f1, playerName, signed } from './common.js';

const VERDICT_LABEL: Record<Verdict, string> = { good: 'good', ok: 'neutral', bad: 'bad', missed: 'missed', info: 'note' };

function Ev({ v }: { v: number | null }) {
  if (v === null) return <span className="muted">-</span>;
  return <span className={v >= 1 ? 'pos' : v <= -1 ? 'neg' : ''}>{signed(v)}</span>;
}

function ItemRow({ it, start }: { it: ReviewItem; start: number }) {
  const [open, setOpen] = useState(it.verdict === 'bad' || it.verdict === 'missed');
  const t = Math.max(0, Math.round((it.at - start) / 1000));
  return (
    <>
      <tr onClick={() => setOpen((x) => !x)} style={{ cursor: 'pointer' }}>
        <td className="small muted">
          {Math.floor(t / 60)}:{String(t % 60).padStart(2, '0')}
        </td>
        <td>
          <span className={`badge verdict-${it.verdict}`}>{VERDICT_LABEL[it.verdict]}</span> {it.title}
        </td>
        <td className="num">
          <Ev v={it.evThen} />
        </td>
        <td className="num">
          <Ev v={it.evFinal} />
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

function GoodQuotes({ items, start }: { items: ReviewItem[]; start: number }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <tr onClick={() => setOpen((x) => !x)} style={{ cursor: 'pointer' }}>
        <td />
        <td className="muted">
          {open ? 'Hide' : 'Show'} {items.length} well-placed quote{items.length === 1 ? '' : 's'} and quick updates
        </td>
        <td />
        <td />
      </tr>
      {open && items.map((it, i) => <ItemRow key={`g${i}`} it={it} start={start} />)}
    </>
  );
}

export function RoundReview({ r, s, title }: { r: PlayerRoundReview; s: Snapshot; title?: string }) {
  const ids = MARKET_IDS.filter((m) => r.markets[m]);
  const type = s.results.find((x) => x.number === r.roundNumber)?.type;
  const sm = r.summary;
  return (
    <div className="card stack">
      <h3>{title ?? `Decision review, round ${r.roundNumber}${type ? `: ${ROUND_TYPES[type].name}` : ''}`}</h3>
      {ids.length > 1 && (
        <>
          <div className="strip">
            <div className="stat">
              <div className="k">Round P&L</div>
              <div className="v">
                <Ev v={sm.pnl} />
              </div>
            </div>
            <div className="stat">
              <div className="k">Decision edge</div>
              <div className="v">
                <Ev v={sm.decisionEdge} />
              </div>
            </div>
            <div className="stat">
              <div className="k">Info luck</div>
              <div className="v">
                <Ev v={sm.infoLuck} />
              </div>
            </div>
            {ids.map((m) => (
              <div className="stat" key={m}>
                <div className="k">{MARKETS[m].short} P&L</div>
                <div className="v">
                  <Ev v={r.markets[m]!.summary.pnl} />
                </div>
              </div>
            ))}
          </div>
          <p className="small">
            Both markets together: P&L {signed(sm.pnl)} = decision edge {signed(sm.decisionEdge)} + information luck {signed(sm.infoLuck)}. Where did your edge come from?{' '}
            {ids.map((m) => `${MARKETS[m].short} ${signed(r.markets[m]!.summary.decisionEdge)}`).join(', ')}.
          </p>
        </>
      )}
      {ids.map((m) => (
        <MarketSection key={m} mr={r.markets[m]!} m={m} start={r.startedAt} heading={ids.length > 1} />
      ))}
      <p className="small muted">
        EV then uses your exact fair value from the cards and clues you held at that moment. Good decisions can still lose money when hidden cards go against you; that is information luck, not a mistake.
      </p>
    </div>
  );
}

function MarketSection({ mr, m, start, heading }: { mr: MarketReview; m: MarketId; start: number; heading: boolean }) {
  const sm = mr.summary;
  const roundStart = start;
  const quiet = mr.items.filter((i) => i.kind === 'quote' && i.verdict === 'good');
  const main = mr.items.filter((i) => !(i.kind === 'quote' && i.verdict === 'good'));
  const fills = mr.items.filter((i) => i.evThen !== null && ['buy', 'sell', 'fill_buy', 'fill_sell'].includes(i.kind));
  const best = fills.reduce<ReviewItem | null>((a, b) => (!a || b.evThen! > a.evThen! ? b : a), null);
  const worst = fills.reduce<ReviewItem | null>((a, b) => (!a || b.evThen! < a.evThen! ? b : a), null);
  return (
    <div className="stack">
      {heading && <h3 style={{ marginBottom: 0 }}>{MARKETS[m].name}</h3>}
      <div className="strip">
        <div className="stat">
          <div className="k">P&L</div>
          <div className="v">
            <Ev v={sm.pnl} />
          </div>
        </div>
        <div className="stat">
          <div className="k">Decision edge</div>
          <div className="v">
            <Ev v={sm.decisionEdge} />
          </div>
        </div>
        <div className="stat">
          <div className="k">Info luck</div>
          <div className="v">
            <Ev v={sm.infoLuck} />
          </div>
        </div>
        {sm.uptime !== null && (
          <div className="stat">
            <div className="k">Quoting uptime</div>
            <div className="v">{Math.round(sm.uptime * 100)}%</div>
          </div>
        )}
        <div className="stat">
          <div className="k">Good / bad</div>
          <div className="v">
            <span className="pos">{sm.goodCount}</span> / <span className="neg">{sm.badCount}</span>
          </div>
        </div>
      </div>
      <p className="small">
        P&L {signed(sm.pnl)} = decision edge {signed(sm.decisionEdge)} (what your trades were worth given what you knew
        {sm.rebates ? `, including ${sm.rebates} in rebates` : ''}) + information luck {signed(sm.infoLuck)} (cards you could not see). Taking prices earned{' '}
        {signed(sm.aggressiveEdge)}; your resting quote earned {signed(sm.passiveEdge)}. You ended {sm.finalPosition === 0 ? 'flat' : `${sm.finalPosition > 0 ? 'long' : 'short'} ${Math.abs(sm.finalPosition)}`}{' '}
        with fair value {f1(sm.fvAtClose)}; it settled at {sm.settlement}.
      </p>
      {best && worst && best !== worst && (
        <p className="small">
          Best decision: <strong>{best.title}</strong> ({signed(best.evThen!)}). Worst: <strong>{worst.title}</strong> ({signed(worst.evThen!)}).
        </p>
      )}
      {mr.items.length === 0 ? (
        <p className="muted small">No decisions in this market. You did not quote or trade.</p>
      ) : (
        <div className="scroll-x">
          <table>
            <thead>
              <tr>
                <th>Time</th>
                <th>Decision (tap for why)</th>
                <th title="Expected value given only what you knew at that moment">EV then</th>
                <th title="What it actually made at settlement">Made</th>
              </tr>
            </thead>
            <tbody>
              {main.map((it, i) => (
                <ItemRow key={i} it={it} start={roundStart} />
              ))}
              {quiet.length > 0 && <GoodQuotes items={quiet} start={roundStart} />}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function SessionReport({ s, playerId }: { s: Snapshot; playerId: string }) {
  const mine = s.reviews.filter((r) => r.playerId === playerId).sort((a, b) => a.roundNumber - b.roundNumber);
  if (!mine.length) return null;
  const sum = (f: (r: PlayerRoundReview) => number) => mine.reduce((a, r) => a + f(r), 0);
  const all = mine.flatMap((r) =>
    MARKET_IDS.flatMap((m) => (r.markets[m]?.items ?? []).map((it) => ({ ...it, round: r.roundNumber, title: Object.keys(r.markets).length > 1 ? `${MARKETS[m].short}: ${it.title}` : it.title }))),
  );
  const lessons = all
    .filter((i) => (i.verdict === 'bad' || i.verdict === 'missed') && i.better)
    .sort((a, b) => (a.evThen ?? -2) - (b.evThen ?? -2))
    .slice(0, 4);
  const wins = all
    .filter((i) => i.verdict === 'good' && i.evThen !== null)
    .sort((a, b) => b.evThen! - a.evThen!)
    .slice(0, 3);
  return (
    <div className="stack">
      <div className="card stack">
        <h2>{s.you.kind === 'host' ? `Decision report: ${playerName(s, playerId)}` : 'Your decision report'}</h2>
        <div className="strip">
          <div className="stat">
            <div className="k">Total P&L</div>
            <div className="v">
              <Ev v={sum((r) => r.summary.pnl)} />
            </div>
          </div>
          <div className="stat">
            <div className="k">Decision edge</div>
            <div className="v">
              <Ev v={sum((r) => r.summary.decisionEdge)} />
            </div>
          </div>
          <div className="stat">
            <div className="k">Info luck</div>
            <div className="v">
              <Ev v={sum((r) => r.summary.infoLuck)} />
            </div>
          </div>
          <div className="stat">
            <div className="k">Bad calls</div>
            <div className="v">{all.filter((i) => i.verdict === 'bad').length}</div>
          </div>
        </div>
        {wins.length > 0 && (
          <div>
            <h3>What went well</h3>
            <ul>
              {wins.map((b, i) => (
                <li key={i}>
                  Round {b.round}: {b.title} ({signed(b.evThen!)})
                </li>
              ))}
            </ul>
          </div>
        )}
        {lessons.length > 0 && (
          <div>
            <h3>Biggest lessons</h3>
            <ul>
              {lessons.map((b, i) => (
                <li key={i}>
                  Round {b.round}: {b.title}. {b.better}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
      {mine.map((r) => (
        <RoundReview key={r.roundNumber} r={r} s={s} />
      ))}
    </div>
  );
}

export function HostReviewTable({ s }: { s: Snapshot }) {
  const [pick, setPick] = useState<string | null>(null);
  if (!s.reviews.length) return null;
  const ids = [...new Set(s.reviews.map((r) => r.playerId))];
  const rows = ids
    .map((id) => {
      const rs = s.reviews.filter((r) => r.playerId === id);
      const t = (f: (r: PlayerRoundReview) => number) => rs.reduce((a, r) => a + f(r), 0);
      const up = rs.flatMap((r) => Object.values(r.markets).map((x) => x!.summary.uptime)).filter((u): u is number => u !== null);
      return {
        id,
        edge: t((r) => r.summary.decisionEdge),
        luck: t((r) => r.summary.infoLuck),
        pnl: t((r) => r.summary.pnl),
        bad: t((r) => r.summary.badCount),
        uptime: up.length ? up.reduce((a, u) => a + u, 0) / up.length : null,
      };
    })
    .sort((a, b) => b.edge - a.edge);
  return (
    <div className="card stack">
      <h3>Decision quality (all players)</h3>
      <p className="small muted">Sorted by decision edge: who traded best given what they knew, separate from card luck. Tap a player for their report.</p>
      <div className="scroll-x">
        <table>
          <thead>
            <tr>
              <th>Player</th>
              <th className="num">Decision edge</th>
              <th className="num">Info luck</th>
              <th className="num">P&L</th>
              <th className="num">Bad calls</th>
              <th className="num">Uptime</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} onClick={() => setPick(r.id)} style={{ cursor: 'pointer' }} className={pick === r.id ? 'mine' : ''}>
                <td>{playerName(s, r.id)}</td>
                <td className="num">
                  <Ev v={r.edge} />
                </td>
                <td className="num">
                  <Ev v={r.luck} />
                </td>
                <td className="num">{r.pnl}</td>
                <td className="num">{r.bad}</td>
                <td className="num">{r.uptime === null ? '-' : `${Math.round(r.uptime * 100)}%`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {pick && <SessionReport key={pick} s={s} playerId={pick} />}
    </div>
  );
}
