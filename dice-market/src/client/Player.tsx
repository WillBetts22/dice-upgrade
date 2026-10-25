import { useEffect, useState } from 'react';
import { CATALOG, type UpgradeId } from '../shared/catalog.js';
import { MAX_PLAYERS, projectedSessionMinutes } from '../shared/rules.js';
import type { Snapshot } from '../shared/types.js';
import { DiceReveal } from './Dice.js';
import { joinRoom } from './Landing.js';
import { BookView, ExposureStrip, Holdings, Inventory, OpenOrders, OrderForm, Tape, previewEquipment } from './Market.js';
import { RulesSummary } from './Rules.js';
import { RoundReview, SessionReport } from './Review.js';
import { ConnBanner, Countdown, Qty, Toasts, TopBar, navigate, upName, useClient } from './common.js';
import { type GameClient, type ClientState, creds } from './net.js';

export function PlayerPage({ code }: { code: string }) {
  const [token, setToken] = useState(() => creds.get('player', code));
  if (!token) return <JoinInline code={code} onJoined={() => setToken(creds.get('player', code))} />;
  return <PlayerApp code={code} token={token} />;
}

function JoinInline({ code, onJoined }: { code: string; onJoined: () => void }) {
  const [name, setName] = useState('');
  const [err, setErr] = useState<string | null>(null);
  return (
    <form
      className="wrap stack"
      onSubmit={async (e) => {
        e.preventDefault();
        try {
          await joinRoom(code, name);
          onJoined();
        } catch (x: any) {
          setErr(x.message);
        }
      }}
    >
      <h1>Join room {code}</h1>
      {err && <div className="banner bad">{err}</div>}
      <div>
        <label htmlFor="nm">Display name</label>
        <input id="nm" type="text" value={name} onChange={(e) => setName(e.target.value)} maxLength={20} required autoFocus />
      </div>
      <button className="btn primary big" disabled={!name.trim()}>
        Join
      </button>
    </form>
  );
}

function PlayerApp({ code, token }: { code: string; token: string }) {
  const [client, state] = useClient(code, token, false);
  const s = state.snapshot;
  if (!s) {
    return (
      <div className="wrap stack">
        <ConnBanner state={state} />
        <p className="muted">Loading room {code}...</p>
        {state.error && (
          <button className="btn" onClick={() => navigate('/')}>
            Back
          </button>
        )}
      </div>
    );
  }
  const me = s.players.find((p) => p.id === s.you.playerId);
  return (
    <>
      <TopBar state={state} title={me ? me.name : 'Spectating'} right={<span className="small muted">Room {s.code}</span>} />
      <div className="wrap stack">
        <ConnBanner state={state} />
        {s.you.kind === 'spectator' && s.phase !== 'lobby' && (
          <div className="banner warn">You joined after the roster froze, so you are spectating this session.</div>
        )}
        <PhaseView s={s} client={client} state={state} />
      </div>
      <Toasts state={state} />
    </>
  );
}

function PhaseView({ s, client, state }: { s: Snapshot; client: GameClient; state: ClientState }) {
  switch (s.phase) {
    case 'lobby':
      return <Lobby s={s} client={client} state={state} />;
    case 'market':
      return <MarketView s={s} client={client} />;
    case 'settling':
    case 'selection':
      return <Selection s={s} client={client} state={state} />;
    case 'reveal':
      return <Reveal s={s} />;
    case 'results':
      return <Results s={s} />;
    case 'finished':
      return <Finished s={s} />;
  }
}

function Lobby({ s, client, state }: { s: Snapshot; client: GameClient; state: ClientState }) {
  const me = s.players.find((p) => p.id === s.you.playerId);
  const traders = s.players.filter((p) => p.role === 'player');
  return (
    <div className="grid2">
      <div className="stack">
        <div className="card stack">
          <h2>Waiting for the host to start</h2>
          <p>
            {s.config.rounds} round{s.config.rounds > 1 ? 's' : ''} · about {projectedSessionMinutes(s.config.rounds, s.config.durations)} minutes including a
            5 minute explanation.
          </p>
          {me && me.role === 'player' && (
            <button className={`btn big ${me.ready ? '' : 'primary'}`} onClick={() => client.command({ kind: 'setReady', ready: !me.ready }, { toast: false })}>
              {me.ready ? 'Ready ✓ (tap to undo)' : "I'm ready"}
            </button>
          )}
        </div>
        <div className="card">
          <h3>
            Players ({traders.length}/{MAX_PLAYERS})
          </h3>
          <ul>
            {s.players.map((p) => (
              <li key={p.id}>
                <span className={`dot ${state.connected.has(p.id) || p.isBot ? 'on' : ''}`} />
                {p.name}
                {p.id === s.you.playerId ? ' (you)' : ''} {p.isHost && <span className="badge">host</span>} {p.ready && <span className="badge top">ready</span>}{' '}
                {p.role === 'spectator' && <span className="badge">spectator</span>}
              </li>
            ))}
          </ul>
        </div>
      </div>
      <div className="card">
        <RulesSummary />
      </div>
    </div>
  );
}

function MarketView({ s, client }: { s: Snapshot; client: GameClient }) {
  const round = s.round!;
  const [tab, setTab] = useState<UpgradeId | 'holdings'>(round.pool[0]);
  const a = s.account;
  const canTrade = !!a && s.phase === 'market' && !s.paused;
  const type = tab === 'holdings' ? null : tab;
  return (
    <div className="stack">
      {a && <ExposureStrip a={a} s={s} />}
      <div className="tabs" role="tablist">
        {round.pool.map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)}>
            {upName(t)}
            {a && a.positions[t] !== 0 && <span className={a.positions[t] > 0 ? 'pos' : 'neg'}> {a.positions[t] > 0 ? `+${a.positions[t]}` : a.positions[t]}</span>}
          </button>
        ))}
        <button role="tab" aria-selected={tab === 'holdings'} onClick={() => setTab('holdings')}>
          Holdings
        </button>
      </div>
      {type ? (
        <div className="grid2">
          <div className="stack">
            <div className="card stack">
              <div className="spread">
                <h2 style={{ margin: 0 }}>{upName(type)}</h2>
              </div>
              <UpgradeEffect type={type} />
              <BookView s={s} type={type} client={client} myId={s.you.playerId} canTrade={canTrade} />
            </div>
          </div>
          <div className="stack">
            {a && <OrderForm key={type} s={s} type={type} a={a} client={client} />}
            {a && <OpenOrders s={s} a={a} client={client} />}
            {a && <Inventory s={s} a={a} />}
          </div>
        </div>
      ) : (
        <Holdings s={s} myId={s.you.playerId} />
      )}
      <Tape s={s} />
    </div>
  );
}

function UpgradeEffect({ type }: { type: UpgradeId }) {
  return <p className="small">{CATALOG[type].effect}</p>;
}

function Selection({ s, client, state }: { s: Snapshot; client: GameClient; state: ClientState }) {
  const a = s.account;
  const round = s.round!;
  const [chosen, setChosen] = useState<UpgradeId[] | null>(null);
  const current = chosen ?? a?.equipment ?? [];
  useEffect(() => {
    if (a?.equipmentSubmitted && chosen === null) setChosen(a.equipment);
  }, [a?.equipmentSubmitted]);
  if (!a) {
    return (
      <div className="card">
        <h2>Players are choosing upgrades</h2>
        <Countdown s={s} offset={state.offset} />
      </div>
    );
  }
  const owned = round.pool.filter((t) => a.positions[t] > 0);
  const toggle = (t: UpgradeId) => {
    const next = current.includes(t) ? current.filter((x) => x !== t) : current.length >= 2 ? [current[1], t] : [...current, t];
    setChosen(next);
    void client.command({ kind: 'selectEquipment', types: next }, { toast: false });
  };
  const preview = previewEquipment(round.pool, a, current);
  return (
    <div className="grid2">
      <div className="stack">
        <div className="card stack">
          <div className="spread">
            <h2 style={{ margin: 0 }}>Choose up to two upgrades</h2>
            <Countdown s={s} offset={state.offset} big={false} />
          </div>
          <p className="small muted">
            Tap to equip. If time runs out, your picks are kept and empty slots are filled from what you own, in catalog order. Only
            owned upgrades count; owed units never give an effect.
          </p>
          {owned.length === 0 ? (
            <p>You do not own any active upgrades this round, so you roll five plain dice.</p>
          ) : (
            <div className="pick">
              {round.pool.map((t) => (
                <button key={t} aria-pressed={current.includes(t)} disabled={a.positions[t] <= 0 || s.phase !== 'selection' || s.paused} onClick={() => toggle(t)}>
                  <strong>{upName(t)}</strong> <Qty q={a.positions[t]} />
                  <div className="small muted">{catalogEffect(t)}</div>
                </button>
              ))}
            </div>
          )}
          <div className="slots">
            {[0, 1].map((i) => (
              <div key={i} className={`slot ${preview[i] ? 'filled' : ''}`}>
                <div className="small muted">Slot {i + 1}{!current[i] && preview[i] ? ' (auto)' : ''}</div>
                {preview[i] ? <strong>{upName(preview[i])}</strong> : <span className="muted small">empty</span>}
              </div>
            ))}
          </div>
          <p className="small muted">{a.equipmentSubmitted ? 'Saved.' : 'Starting upgrade preselected if you still own it.'}</p>
        </div>
      </div>
      <SettlementReceipt s={s} />
    </div>
  );
}

function catalogEffect(t: UpgradeId) {
  return CATALOG[t].effect;
}

function SettlementReceipt({ s }: { s: Snapshot }) {
  const a = s.account!;
  return (
    <div className="card stack">
      <h2>Settlement receipt</h2>
      {a.settlement.length === 0 ? (
        <p>You had no uncovered shorts. No deduction.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Upgrade</th>
              <th>Units owed</th>
              <th>Round high</th>
              <th>Deduction</th>
            </tr>
          </thead>
          <tbody>
            {a.settlement.map((l) => (
              <tr key={l.type}>
                <td>{upName(l.type)}</td>
                <td>{l.units}</td>
                <td>
                  {l.closeoutPrice}
                  {l.fallbackPrice ? ' (fallback)' : ''}
                </td>
                <td className="neg">−{l.deduction}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <table>
        <tbody>
          <tr>
            <td>Trading cash (unchanged by settlement)</td>
            <td className="num">{a.cash}</td>
          </tr>
          <tr>
            <td>Total short deduction (taken from score)</td>
            <td className="num">{a.shortDeductions}</td>
          </tr>
        </tbody>
      </table>
      <p className="small muted">The bank supplied the units you owed. Buyers keep what they bought.</p>
    </div>
  );
}

function Reveal({ s }: { s: Snapshot }) {
  const rec = s.you.playerId ? s.round!.dice?.[s.you.playerId] : undefined;
  return (
    <div className="grid2">
      <div className="card stack">
        <h2>Your roll</h2>
        {rec ? <DiceReveal rec={rec} /> : <p className="muted">Watch the projector for everyone's dice.</p>}
      </div>
      {rec && (
        <div className="card">
          <h2>Round score</h2>
          <ScoreTable trading={rec.tradingCash} payout={rec.resolution.payout} deductions={rec.shortDeductions} score={rec.score} />
        </div>
      )}
    </div>
  );
}

function ScoreTable({ trading, payout, deductions, score }: { trading: number; payout: number; deductions: number; score: number }) {
  return (
    <table>
      <tbody>
        <tr>
          <td>Trading cash</td>
          <td className="num">{trading}</td>
        </tr>
        <tr>
          <td>+ Dice payout</td>
          <td className="num">{payout}</td>
        </tr>
        <tr>
          <td>− Short deductions</td>
          <td className="num">{deductions}</td>
        </tr>
        <tr>
          <td>
            <strong>Round score</strong>
          </td>
          <td className="num">
            <strong>{score}</strong>
          </td>
        </tr>
        <tr>
          <td className="small muted">Net trading result (cash − 100 starting − deductions)</td>
          <td className="num small">{trading - 100 - deductions}</td>
        </tr>
      </tbody>
    </table>
  );
}

function Results({ s }: { s: Snapshot }) {
  const last = s.completedRounds[s.completedRounds.length - 1];
  const mine = last?.players.find((p) => p.playerId === s.you.playerId);
  const row = s.leaderboard.rows.find((r) => r.playerId === s.you.playerId);
  const more = s.completedRounds.length < s.config.rounds;
  return (
    <div className="stack">
      <div className="grid2">
        {mine && (
          <div className="card stack">
            <h2>Round {last.number} result</h2>
            <ScoreTable trading={mine.tradingCash} payout={mine.dicePayout} deductions={mine.shortDeductions} score={mine.roundScore} />
            <p className="small">Equipped: {mine.equipment.length ? mine.equipment.map(upName).join(', ') : 'nothing'}</p>
            {row && (
              <p>
                Overall: <strong>{row.total}</strong> · rank <strong>{row.rank}</strong> of {s.leaderboard.rows.length}
              </p>
            )}
          </div>
        )}
        {last && <UpgradeStats s={s} />}
      </div>
      {(() => {
        const rv = (s.reviews ?? []).find((r) => r.playerId === s.you.playerId && r.roundNumber === last?.number);
        return rv ? <RoundReview r={rv} /> : null;
      })()}
      {more && <div className="banner warn">Next round starts soon with fresh coins and a new set of upgrades. Reconsider your prices and avoid uncovered shorts.</div>}
      <LeaderboardTable s={s} />
    </div>
  );
}

export function UpgradeStats({ s }: { s: Snapshot }) {
  const last = s.completedRounds[s.completedRounds.length - 1];
  return (
    <div className="card">
      <h3>Market summary, round {last.number}</h3>
      <table>
        <thead>
          <tr>
            <th>Upgrade</th>
            <th>High</th>
            <th>Last</th>
            <th>Volume</th>
            <th>Short closeouts</th>
          </tr>
        </thead>
        <tbody>
          {last.upgrades.map((u) => (
            <tr key={u.type}>
              <td>{upName(u.type)}</td>
              <td>{u.highPrice ?? '–'}</td>
              <td>{u.lastPrice ?? '–'}</td>
              <td>{u.volume}</td>
              <td>{u.shortCloseouts}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function LeaderboardTable({ s }: { s: Snapshot }) {
  return (
    <div className="card scroll-x">
      <h3>Leaderboard</h3>
      <table>
        <thead>
          <tr>
            <th>Rank</th>
            <th>Player</th>
            {s.completedRounds.map((r) => (
              <th key={r.number}>R{r.number}</th>
            ))}
            <th>Total</th>
          </tr>
        </thead>
        <tbody>
          {s.leaderboard.rows.map((r) => (
            <tr key={r.playerId} className={r.playerId === s.you.playerId ? 'mine' : ''}>
              <td>{r.rank}</td>
              <td>{r.name}</td>
              {r.perRound.map((x, i) => (
                <td key={i} className={x !== null && x < 0 ? 'neg' : ''}>
                  {x ?? '–'}
                </td>
              ))}
              <td className={r.total < 0 ? 'neg' : ''}>
                <strong>{r.total}</strong>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Finished({ s }: { s: Snapshot }) {
  const row = s.leaderboard.rows.find((r) => r.playerId === s.you.playerId);
  return (
    <div className="stack">
      <div className="card">
        <h2>Game over</h2>
        {row && (
          <p>
            You finished <strong>#{row.rank}</strong> with <strong>{row.total}</strong> points across {s.completedRounds.length} round
            {s.completedRounds.length > 1 ? 's' : ''}.
          </p>
        )}
        <p className="small muted">Dice luck affects results; this ranking is not a risk-adjusted skill measure.</p>
      </div>
      <LeaderboardTable s={s} />
      {s.you.playerId && <SessionReport s={s} playerId={s.you.playerId} />}
    </div>
  );
}

