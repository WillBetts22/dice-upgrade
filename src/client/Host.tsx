import QRCode from 'qrcode';
import { useEffect, useState } from 'react';
import { HOST_SCRIPT, MAX_PLAYERS, MAX_ROUNDS, MIN_PLAYERS, MIN_ROUNDS, projectedSessionMinutes } from '../shared/rules.js';
import type { PhaseDurations } from '../shared/rules.js';
import type { Snapshot } from '../shared/types.js';
import { joinRoom } from './Landing.js';
import { Tape } from './Market.js';
import { LeaderboardTable, UpgradeStats } from './Player.js';
import { ConnBanner, Countdown, PHASE_LABEL, Toasts, playerName, upName, useClient } from './common.js';
import { type ClientState, type GameClient, creds } from './net.js';

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
        <div className="grid2">
          <PlayersCard s={s} client={client} state={state} />
          <div className="stack">
            {s.round && s.phase === 'market' && <Exposure s={s} />}
            {(s.phase === 'results' || s.phase === 'finished') && s.completedRounds.length > 0 && <UpgradeStats s={s} />}
            <div className="card">
              <h3>Host explanation script (about 5 minutes)</h3>
              <div className="script small">{HOST_SCRIPT}</div>
            </div>
          </div>
        </div>
        {s.round && <Tape s={s} limit={15} />}
        {s.completedRounds.length > 0 && <LeaderboardTable s={s} />}
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
  const traders = s.players.filter((p) => p.role === 'player').length;
  const timed = ['market', 'selection', 'reveal', 'results'].includes(s.phase);
  return (
    <div className="card stack">
      <div className="spread">
        <div>
          <div className="small muted">Phase</div>
          <h2 style={{ margin: 0 }}>
            {PHASE_LABEL[s.phase]}
            {s.round ? ` · round ${s.roundNumber} of ${s.config.rounds}` : ''}
          </h2>
        </div>
        {timed && <Countdown s={s} offset={state.offset} />}
      </div>
      <div className="small muted">
        Server time {new Date(Date.now() + state.offset).toLocaleTimeString()} · connection {state.conn}
      </div>
      <div className="row">
        {s.phase === 'lobby' && (
          <button className="btn primary big" disabled={traders < MIN_PLAYERS} onClick={() => client.command({ kind: 'startSession' })}>
            Start with {traders} player{traders === 1 ? '' : 's'}
          </button>
        )}
        {timed && !s.paused && (
          <button className="btn" onClick={() => client.command({ kind: 'pauseRoom' })}>
            Pause
          </button>
        )}
        {s.paused && (
          <button className="btn primary" onClick={() => client.command({ kind: 'resumeRoom' })}>
            Resume
          </button>
        )}
        {s.phase === 'results' && !s.paused && (
          <button className="btn primary" onClick={() => client.command({ kind: 'advanceResults' })}>
            {s.completedRounds.length < s.config.rounds ? 'Start next round now' : 'Finish session'}
          </button>
        )}
        {s.config.devMode && timed && !s.paused && (
          <button className="btn ghost" onClick={() => client.command({ kind: 'devSkipPhase' })}>
            Skip phase (test mode)
          </button>
        )}
      </div>
      {s.phase === 'lobby' && traders < MIN_PLAYERS && <p className="small muted">Need at least {MIN_PLAYERS} players. Target event size is 20 to 30.</p>}
      {s.phase === 'market' && <p className="small muted">The market cannot be ended early outside test mode. Pausing blocks trading and keeps the remaining time.</p>}
    </div>
  );
}

function LobbySetup({ s, client }: { s: Snapshot; client: GameClient }) {
  const [hostName, setHostName] = useState('');
  const hostPlayer = s.players.find((p) => p.isHost);
  const d = s.config.durations;
  const setDur = (k: keyof PhaseDurations, seconds: number) => client.command({ kind: 'setConfig', durations: { [k]: Math.round(seconds * 1000) } });
  return (
    <div className="grid2">
      <div className="card stack">
        <h3>Session settings (locked at start)</h3>
        <div>
          <label htmlFor="r">Rounds</label>
          <select id="r" value={s.config.rounds} onChange={(e) => client.command({ kind: 'setConfig', rounds: Number(e.target.value) })}>
            {Array.from({ length: MAX_ROUNDS - MIN_ROUNDS + 1 }, (_, i) => i + MIN_ROUNDS).map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </div>
        <p>
          Projected session: <strong>{projectedSessionMinutes(s.config.rounds, d)} minutes</strong> (5 minute explanation + {s.config.rounds} ×{' '}
          {(d.marketMs + d.selectionMs + d.revealMs + d.resultsMs) / 60000} minute rounds)
        </p>
        <details>
          <summary>Phase durations</summary>
          <div className="row" style={{ marginTop: 8 }}>
            {(
              [
                ['marketMs', 'Market'],
                ['selectionMs', 'Selection'],
                ['revealMs', 'Reveal'],
                ['resultsMs', 'Results'],
              ] as [keyof PhaseDurations, string][]
            ).map(([k, label]) => (
              <div key={k} style={{ flex: '1 1 110px' }}>
                <label>{label} (seconds)</label>
                <input type="number" defaultValue={d[k] / 1000} min={10} onBlur={(e) => setDur(k, Number(e.target.value))} />
              </div>
            ))}
          </div>
        </details>
      </div>
      <div className="card stack">
        <h3>Play as well?</h3>
        {hostPlayer ? (
          <p>
            You are playing as <strong>{hostPlayer.name}</strong> and count toward the {MAX_PLAYERS}.{' '}
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
        <p className="small muted">Otherwise you stay a spectator and only run the room.</p>
        {s.config.devMode && (
          <button className="btn" onClick={() => client.command({ kind: 'devAddBots', count: 5 })}>
            Add 5 bots (test mode)
          </button>
        )}
      </div>
    </div>
  );
}

function PlayersCard({ s, client, state }: { s: Snapshot; client: GameClient; state: ClientState }) {
  const traders = s.players.filter((p) => p.role === 'player');
  const ready = traders.filter((p) => p.ready).length;
  return (
    <div className="card">
      <h3>
        Players {traders.length}/{MAX_PLAYERS} · {ready} ready · {traders.filter((p) => state.connected.has(p.id) || p.isBot).length} connected
      </h3>
      <div className="scroll-x">
        <table>
          <tbody>
            {s.players.map((p) => (
              <tr key={p.id}>
                <td>
                  <span className={`dot ${state.connected.has(p.id) || p.isBot ? 'on' : ''}`} />
                  {p.name} {p.isHost && <span className="badge">host</span>} {p.isBot && <span className="badge">bot</span>}
                  {p.role === 'spectator' && <span className="badge">spectator</span>}
                </td>
                <td>{s.phase === 'lobby' ? (p.ready ? 'ready' : '') : state.connected.has(p.id) || p.isBot ? 'online' : 'offline (auto-plays)'}</td>
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

function Exposure({ s }: { s: Snapshot }) {
  const h = s.host!;
  return (
    <div className="card">
      <h3>Exposure summary</h3>
      <p className="small">
        Units owed by type:{' '}
        {s.round!.pool.map((t) => `${upName(t)} ${h.owedByType[t] ?? 0}`).join(' · ')}
      </p>
      {h.exposure.length === 0 ? (
        <p className="small muted">Nobody is short right now.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Player</th>
              <th>Owes</th>
              <th>Est. deduction</th>
            </tr>
          </thead>
          <tbody>
            {h.exposure.map((e) => (
              <tr key={e.playerId}>
                <td>{playerName(s, e.playerId)}</td>
                <td className="neg">{e.owedUnits}</td>
                <td>{e.estimatedDeduction}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
