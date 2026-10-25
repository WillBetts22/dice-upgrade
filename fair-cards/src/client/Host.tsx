import QRCode from 'qrcode';
import { useEffect, useState } from 'react';
import { HOST_SCRIPT, MAX_PLAYERS, MAX_ROUNDS, MIN_PLAYERS, MIN_ROUNDS, projectedMinutes, ROUND_TYPE_IDS, ROUND_TYPES, type RoundType } from '../shared/rules.js';
import type { Snapshot } from '../shared/types.js';
import { PriceChart } from './Chart.js';
import { ConnBanner, ContractCards, Countdown, f1, PHASE_LABEL, playerName, ROLE_LABEL, RuleLine, roundTitle, ShockBanner, Standings, Toasts, useClient } from './common.js';
import { joinRoom } from './Landing.js';
import { Tape } from './Market.js';
import { type ClientState, creds, type GameClient } from './net.js';

import { HostReviewTable } from './Review.js';

export function HostPage({ code }: { code: string }) {
  const token = creds.get('host', code);
  if (!token) {
    return (
      <div className="wrap stack">
        <h1>Room {code}</h1>
        <div className="banner bad">This device does not hold the host credential for this room. A room code alone never grants host controls.</div>
        <a href={`/screen/${code}`}>Open the projector view</a>
      </div>
    );
  }
  return <HostApp code={code} token={token} />;
}

function HostApp({ code, token }: { code: string; token: string }) {
  const [client, state] = useClient(code, token, true);
  const s = state.snapshot;
  if (!s) return <div className="wrap"><ConnBanner state={state} /><p>Connecting...</p></div>;
  if (s.you.kind !== 'host') return <div className="wrap"><div className="banner bad">Host credential rejected.</div></div>;
  return (
    <>
      <div className="wrap stack">
        <ConnBanner state={state} />
        <div className="grid2">
          <RoomCard s={s} />
          <Controls s={s} client={client} state={state} />
        </div>
        {s.phase === 'lobby' && <LobbySetup s={s} client={client} />}
        {s.round && s.phase !== 'lobby' && (
          <div className="grid2">
            <div className="card stack">
              <h3>{roundTitle(s)}</h3>
              <ShockBanner s={s} />
              <ContractCards s={s} />
              <RuleLine rule={s.round.rule} />
              <div className="strip">
                <div className="stat">
                  <div className="k">Public FV</div>
                  <div className="v">{f1(s.round.publicFv)}</div>
                </div>
                <div className="stat">
                  <div className="k">Last</div>
                  <div className="v">{s.round.lastPrice ?? '-'}</div>
                </div>
                <div className="stat">
                  <div className="k">Volume</div>
                  <div className="v">{s.round.volume}</div>
                </div>
                <div className="stat">
                  <div className="k">Quoting</div>
                  <div className="v">{s.host?.quoting ?? 0}</div>
                </div>
              </div>
              {s.round.settlement !== null && <p>Settled at <strong>{s.round.settlement}</strong>{s.round.insiderId && `; the insider was ${playerName(s, s.round.insiderId)}`}.</p>}
              <PriceChart s={s} offset={state.offset} />
            </div>
            <div className="stack">
              <Positions s={s} />
              <Tape s={s} limit={10} />
            </div>
          </div>
        )}
        <PlayersCard s={s} client={client} />
        <Standings s={s} />
        {(s.phase === 'results' || s.phase === 'finished') && <HostReviewTable s={s} />}
        <div className="card">
          <h3>Host explanation script (about 5 minutes)</h3>
          <div className="script small">{HOST_SCRIPT}</div>
        </div>
      </div>
      <Toasts state={state} />
    </>
  );
}

function RoomCard({ s }: { s: Snapshot }) {
  const [qr, setQr] = useState<string | null>(null);
  const url = `${location.origin}/join/${s.code}`;
  useEffect(() => {
    QRCode.toDataURL(url, { margin: 1, width: 360 }).then(setQr, () => setQr(null));
  }, [url]);
  return (
    <div className="card row" style={{ alignItems: 'flex-start', gap: 16 }}>
      {qr && <img className="qr" src={qr} alt={`QR code to join room ${s.code}`} />}
      <div className="stack">
        <div className="small muted">Room code</div>
        <div className="code-big">{s.code}</div>
        <div className="small">
          Join at <strong>{location.host}/join/{s.code}</strong>
        </div>
        <div className="row small">
          <a href={`/screen/${s.code}`} target="_blank" rel="noreferrer">
            Projector view
          </a>
          {s.config.devMode && <span className="badge">test mode</span>}
        </div>
      </div>
    </div>
  );
}

function Controls({ s, client, state }: { s: Snapshot; client: GameClient; state: ClientState }) {
  const traders = s.players.filter((p) => !p.spectator).length;
  const timed = ['briefing', 'market', 'results'].includes(s.phase);
  return (
    <div className="card stack">
      <div className="spread">
        <div>
          <div className="small muted">Phase</div>
          <h2 style={{ margin: 0 }}>
            {PHASE_LABEL[s.phase]}
            {s.round ? ` · round ${s.round.number} of ${s.config.roundTypes.length}` : ''}
          </h2>
        </div>
        {timed && <Countdown s={s} offset={state.offset} />}
      </div>
      <div className="row">
        {s.phase === 'lobby' && (
          <button className="btn primary big" disabled={traders < MIN_PLAYERS} onClick={() => client.command({ kind: 'start' })}>
            Start with {traders} player{traders === 1 ? '' : 's'}
          </button>
        )}
        {timed && !s.paused && (
          <button className="btn" onClick={() => client.command({ kind: 'pause' })}>
            Pause
          </button>
        )}
        {s.paused && (
          <button className="btn primary" onClick={() => client.command({ kind: 'resume' })}>
            Resume
          </button>
        )}
        {s.phase === 'briefing' && !s.paused && (
          <button className="btn primary" onClick={() => client.command({ kind: 'advance' })}>
            Open the market now
          </button>
        )}
        {s.phase === 'results' && !s.paused && (
          <button className="btn primary" onClick={() => client.command({ kind: 'advance' })}>
            {s.round && s.round.number < s.config.roundTypes.length ? 'Next round now' : 'Finish session'}
          </button>
        )}
        {s.config.devMode && s.phase === 'market' && !s.paused && (
          <button className="btn ghost" onClick={() => client.command({ kind: 'skip' })}>
            Skip to next reveal (test mode)
          </button>
        )}
      </div>
      {s.phase === 'lobby' && traders < MIN_PLAYERS && <p className="small muted">Need at least {MIN_PLAYERS} players. Works best with 8 to 30.</p>}
      {s.phase === 'market' && <p className="small muted">The market runs on its timer. Pausing blocks trading and freezes the clock and the reveal schedule.</p>}
    </div>
  );
}

function LobbySetup({ s, client }: { s: Snapshot; client: GameClient }) {
  const [hostName, setHostName] = useState('');
  const hostPlayer = s.players.find((p) => p.isHost);
  const c = s.config;
  const setTypes = (roundTypes: RoundType[]) => client.command({ kind: 'setConfig', roundTypes }, { toast: false });
  return (
    <div className="grid2">
      <div className="card stack">
        <h3>Session settings (locked at start)</h3>
        <p className="small muted">Projected: about {projectedMinutes(c.roundTypes.length, c)} minutes including a 5 minute explanation.</p>
        {c.roundTypes.map((t, i) => (
          <div key={i} className="row">
            <span style={{ width: 70 }}>Round {i + 1}</span>
            <select
              value={t}
              style={{ flex: 1, width: 'auto' }}
              onChange={(e) => {
                const next = c.roundTypes.slice();
                next[i] = e.target.value as RoundType;
                setTypes(next);
              }}
            >
              {ROUND_TYPE_IDS.map((id) => (
                <option key={id} value={id}>
                  {ROUND_TYPES[id].name}
                </option>
              ))}
            </select>
            <button className="btn small ghost" disabled={c.roundTypes.length <= MIN_ROUNDS} onClick={() => setTypes(c.roundTypes.filter((_, j) => j !== i))}>
              Remove
            </button>
          </div>
        ))}
        <button className="btn small" disabled={c.roundTypes.length >= MAX_ROUNDS} onClick={() => setTypes([...c.roundTypes, 'discovery'])}>
          Add a round
        </button>
        <div className="row">
          <label htmlFor="cool" style={{ margin: 0, flex: 1 }}>
            Seconds between a player's quote updates
          </label>
          <input
            id="cool"
            type="number"
            min={0}
            max={60}
            defaultValue={c.quoteCooldownMs / 1000}
            style={{ width: 90 }}
            onBlur={(e) => client.command({ kind: 'setConfig', quoteCooldownMs: Math.round(Number(e.target.value) * 1000) })}
          />
        </div>
        <p className="small muted">Players never see fair values during the market; they work them out. The review after each round shows the exact numbers.</p>
        <details>
          <summary>Phase durations</summary>
          <div className="row" style={{ marginTop: 8 }}>
            {(
              [
                ['briefingMs', 'Briefing'],
                ['marketMs', 'Market'],
                ['resultsMs', 'Results'],
              ] as const
            ).map(([k, label]) => (
              <div key={k} style={{ flex: '1 1 110px' }}>
                <label>{label} (seconds)</label>
                <input type="number" defaultValue={c[k] / 1000} min={5} onBlur={(e) => client.command({ kind: 'setConfig', [k]: Math.round(Number(e.target.value) * 1000) })} />
              </div>
            ))}
          </div>
          <p className="small muted">Public reveals happen at a quarter, half and three quarters of the market.</p>
        </details>
      </div>
      <div className="card stack">
        <h3>Play as well?</h3>
        {hostPlayer ? (
          <p>
            You are playing as <strong>{hostPlayer.name}</strong>.{' '}
            <a href={`/play/${s.code}`} target="_blank" rel="noreferrer">
              Open your player screen
            </a>
          </p>
        ) : (
          <form
            className="row"
            onSubmit={async (e) => {
              e.preventDefault();
              try {
                await joinRoom(s.code, hostName, creds.get('host', s.code)!);
                client.toast(true, 'You joined as a player.');
              } catch (x: any) {
                client.toast(false, x.message);
              }
            }}
          >
            <input type="text" placeholder="Your display name" value={hostName} onChange={(e) => setHostName(e.target.value)} maxLength={20} style={{ flex: 1 }} />
            <button className="btn" disabled={!hostName.trim()}>
              Join as player
            </button>
          </form>
        )}
        <p className="small muted">If you play, live positions are hidden from your host screen until each round settles.</p>
        {s.config.devMode && (
          <button className="btn" onClick={() => client.command({ kind: 'addBots', count: 5 })}>
            Add 5 bots (test mode)
          </button>
        )}
      </div>
    </div>
  );
}

function PlayersCard({ s, client }: { s: Snapshot; client: GameClient }) {
  const active = s.players.filter((p) => !p.spectator);
  return (
    <div className="card">
      <h3>
        Players {active.length}/{MAX_PLAYERS} · {s.players.filter((p) => p.connected).length} connected
      </h3>
      <div className="scroll-x">
        <table>
          <tbody>
            {s.players.map((p) => (
              <tr key={p.id}>
                <td>
                  <span className={`dot ${p.connected ? 'on' : ''}`} />
                  {p.name} {p.isHost && <span className="badge">host</span>} {p.isBot && <span className="badge">bot</span>}
                  {p.spectator && <span className="badge">spectator</span>}
                </td>
                <td className="small">{s.round?.roles[p.id] ? ROLE_LABEL[s.round.roles[p.id]] : ''}</td>
                <td style={{ textAlign: 'right' }}>
                  {s.phase === 'lobby' && (
                    <button className="btn small ghost" onClick={() => client.command({ kind: 'removePlayer', playerId: p.id })}>
                      Remove
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Positions({ s }: { s: Snapshot }) {
  const rows = (s.host?.positions ?? []).slice().sort((a, b) => Math.abs(b.position) - Math.abs(a.position));
  return (
    <div className="card">
      <h3>Positions</h3>
      {!rows.length ? (
        <p className="small muted">Hidden while you are also playing, until the round settles.</p>
      ) : (
        <table>
          <tbody>
            {rows.slice(0, 12).map((p) => (
              <tr key={p.playerId}>
                <td>{playerName(s, p.playerId)}</td>
                <td className={`num ${p.position > 0 ? 'pos' : p.position < 0 ? 'neg' : ''}`}>{p.position > 0 ? `+${p.position}` : p.position}</td>
                <td className="small">{p.live ? <span className="live">quoting</span> : <span className="muted">no quote</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
