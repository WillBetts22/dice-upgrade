import { CATALOG } from '../shared/catalog.js';
import type { Snapshot } from '../shared/types.js';
import { DiceRow } from './Dice.js';
import { LeaderboardTable, UpgradeStats } from './Player.js';
import { RulesSummary } from './Rules.js';
import { ConnBanner, Countdown, PHASE_LABEL, playerName, upName, useClient } from './common.js';

/** Read-only big-screen view. Uses a spectator connection: no credentials needed. */
export function ProjectorPage({ code }: { code: string }) {
  const [, state] = useClient(code, null, false);
  const s = state.snapshot;
  if (!s) return <div className="wrap"><ConnBanner state={state} /></div>;
  return (
    <div className="wrap stack" style={{ maxWidth: 1600 }}>
      <ConnBanner state={state} />
      <div className="spread">
        <div>
          <div className="small muted">Join at {location.host}/join/{s.code}</div>
          <div className="code-big" style={{ fontSize: '2.2rem' }}>{s.code}</div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div className="phase-pill">{PHASE_LABEL[s.phase]}{s.round ? ` · round ${s.roundNumber}/${s.config.rounds}` : ''}</div>
          <div>{s.phase !== 'lobby' && s.phase !== 'finished' && <Countdown s={s} offset={state.offset} />}</div>
        </div>
      </div>
      <Body s={s} />
    </div>
  );
}

function Body({ s }: { s: Snapshot }) {
  if (s.phase === 'lobby') {
    return (
      <div className="grid2">
        <div className="card">
          <h2>{s.players.filter((p) => p.role === 'player').length} players joined</h2>
          <p>{s.players.map((p) => p.name).join(' · ')}</p>
        </div>
        <div className="card"><RulesSummary /></div>
      </div>
    );
  }
  const round = s.round!;
  if (s.phase === 'market' || s.phase === 'settling' || s.phase === 'selection') {
    return (
      <div className="stack">
        <div className="proj-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))' }}>
          {round.pool.map((t) => {
            const book = round.books[t] ?? [];
            const bids = book.filter((o) => o.side === 'bid').map((o) => o.price);
            const asks = book.filter((o) => o.side === 'ask').map((o) => o.price);
            const u = round.upgrades[t];
            return (
              <div key={t} className="card">
                <h2>{CATALOG[t].name}</h2>
                <p className="small muted">{CATALOG[t].effect}</p>
                <div className="strip">
                  <div className="stat"><div className="k">Bid</div><div className="v" style={{ color: 'var(--buy)' }}>{bids.length ? Math.max(...bids) : '–'}</div></div>
                  <div className="stat"><div className="k">Ask</div><div className="v" style={{ color: 'var(--sell)' }}>{asks.length ? Math.min(...asks) : '–'}</div></div>
                  <div className="stat"><div className="k">Last</div><div className="v">{u.lastPrice ?? '–'}</div></div>
                  <div className="stat"><div className="k">High</div><div className="v" style={{ color: 'var(--high)' }}>{u.highPrice ?? '–'}</div></div>
                </div>
                <p className="small">Supply {u.initialSupply} · volume {u.volume} · owed now {Object.values(round.holdings).reduce((x, h) => x + Math.max(0, -(h[t] ?? 0)), 0)}</p>
              </div>
            );
          })}
        </div>
        {s.phase !== 'market' && <div className="banner warn">Market closed. Players are choosing upgrades ({round.submittedCount} saved).</div>}
        <div className="card">
          <h3>Latest trades</h3>
          <table>
            <tbody>
              {round.tape.slice(-8).reverse().map((t) => (
                <tr key={t.id}>
                  <td>{upName(t.type)}</td>
                  <td><strong>{t.price}</strong> × {t.qty} {t.raisedHigh && <span className="badge high">new high</span>}</td>
                  <td>{playerName(s, t.buyerId)} bought from {playerName(s, t.sellerId)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  }
  if (s.phase === 'reveal' && round.dice) {
    // All players resolve at once in a compact grid.
    const recs = Object.values(round.dice).sort((a, b) => b.score - a.score);
    return (
      <div className="proj-grid">
        {recs.map((r) => (
          <div key={r.playerId} className="card">
            <div className="spread"><strong>{playerName(s, r.playerId)}</strong><span className="num">{r.resolution.payout}</span></div>
            <DiceRow rec={r} />
            <div className="small muted">{r.resolution.equipment.map(upName).join(' + ') || 'no upgrades'}</div>
            <div className="small">Score <strong>{r.score}</strong>{r.shortDeductions ? <span className="neg"> (−{r.shortDeductions} short)</span> : null}</div>
          </div>
        ))}
      </div>
    );
  }
  return (
    <div className="stack">
      {s.completedRounds.length > 0 && <UpgradeStats s={s} />}
      <LeaderboardTable s={s} />
    </div>
  );
}
