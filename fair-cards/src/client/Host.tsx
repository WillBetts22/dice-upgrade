import QRCode from 'qrcode';
import { useEffect, useState } from 'react';
import {
  DEFAULT_REVEAL_EVERY_MS,
  DEFAULT_SHOCK_COUNT,
  DURATION_BOUNDS,
  HOST_SCRIPT,
  MAX_PLAYERS,
  MAX_ROUNDS,
  maxRevealEveryMs,
  MIN_PLAYERS,
  MIN_ROUNDS,
  projectedMinutes,
  QUOTE_COOLDOWN_BOUNDS,
  REVEAL_EVERY_BOUNDS,
  ROUND_TYPE_IDS,
  ROUND_TYPES,
  type RoundType,
  CLUES_PER_REVEAL_BOUNDS,
  DEFAULT_CLUES_PER_REVEAL,
  DEFAULT_PRIVATE_PER_REVEAL,
  DEFAULT_PRIVATE_START,
  MARKETS,
  PRIVATE_PER_REVEAL_BOUNDS,
  PRIVATE_START_BOUNDS,
  SHOCK_COUNT_BOUNDS,
  STAGE_COUNT,
} from '../shared/rules.js';
import type { Snapshot } from '../shared/types.js';
import { PriceChart } from './Chart.js';
import { ConnBanner, ContractCards, Countdown, f1, fmtClock, PHASE_LABEL, playerName, ROLE_LABEL, RuleLine, roundTitle, ShockBanner, Standings, Toasts, useClient } from './common.js';
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
              {s.round.marketIds.map((m) => {
                const mk = s.round!.markets[m]!;
                return (
                  <div key={m} className="stack">
                    {s.round!.marketIds.length > 1 && <h3 style={{ margin: 0 }}>{MARKETS[m].name}</h3>}
                    <div className="strip">
                      <div className="stat">
                        <div className="k">Public FV</div>
                        <div className="v">{f1(mk.publicFv)}</div>
                      </div>
                      <div className="stat">
                        <div className="k">Last</div>
                        <div className="v">{mk.lastPrice ?? '-'}</div>
                      </div>
                      <div className="stat">
                        <div className="k">Volume</div>
                        <div className="v">{mk.volume}</div>
                      </div>
                      <div className="stat">
                        <div className="k">Quoting</div>
                        <div className="v">{s.host?.quoting[m] ?? 0}</div>
                      </div>
                      {mk.settlement !== null && (
                        <div className="stat">
                          <div className="k">Settled</div>
                          <div className="v">{mk.settlement}</div>
                        </div>
                      )}
                    </div>
                    <PriceChart s={s} offset={state.offset} m={m} />
                  </div>
                );
              })}
              {s.round.insiderId && <p>The insider was {playerName(s, s.round.insiderId)}.</p>}
            </div>
            <div className="stack">
              <Positions s={s} />
              {s.round.marketIds.map((m) => (
                <Tape key={m} s={s} m={m} limit={8} />
              ))}
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

/** A value with minus and plus buttons. */
function Stepper({ label, value, show, step, min, max, onSet, hint }: { label: string; value: number; show: (v: number) => string; step: number; min: number; max: number; onSet: (v: number) => void; hint?: string }) {
  const snap = (v: number) => Math.min(max, Math.max(min, v));
  return (
    <div className="stepper">
      <div style={{ flex: 1 }}>
        <div>{label}</div>
        {hint && <div className="small muted">{hint}</div>}
      </div>
      <button className="btn small ghost" aria-label={`Less: ${label}`} disabled={value <= min} onClick={() => onSet(snap(value - step))}>
        -
      </button>
      <span className="stepper-v">{show(value)}</span>
      <button className="btn small ghost" aria-label={`More: ${label}`} disabled={value >= max} onClick={() => onSet(snap(value + step))}>
        +
      </button>
    </div>
  );
}

const clock = (ms: number) => (ms < 60_000 ? `${ms / 1000} s` : fmtClock(ms));

function TimingSetup({ s, client }: { s: Snapshot; client: GameClient }) {
  const c = s.config;
  const set = (cmd: Omit<Extract<Parameters<GameClient['command']>[0], { kind: 'setConfig' }>, 'kind'>) => client.command({ kind: 'setConfig', ...cmd }, { toast: false });
  const reveal = Math.min(c.revealEveryMs ?? DEFAULT_REVEAL_EVERY_MS, maxRevealEveryMs(c.marketMs));
  const shocks = c.shockCount ?? DEFAULT_SHOCK_COUNT;
  const hasNews = c.roundTypes.includes('shocks');
  const revealTimes = Array.from({ length: STAGE_COUNT - 1 }, (_, k) => fmtClock((k + 1) * reveal)).join(', ');
  return (
    <div className="card stack">
      <h3>Timing</h3>
      <Stepper label="Briefing before each round" value={c.briefingMs} show={clock} step={5_000} min={DURATION_BOUNDS.briefingMs[0]} max={DURATION_BOUNDS.briefingMs[1]} onSet={(v) => set({ briefingMs: v })} />
      <Stepper label="Market length" value={c.marketMs} show={clock} step={30_000} min={DURATION_BOUNDS.marketMs[0]} max={DURATION_BOUNDS.marketMs[1]} onSet={(v) => set({ marketMs: v })} />
      <Stepper label="Results and review after each round" value={c.resultsMs} show={clock} step={15_000} min={DURATION_BOUNDS.resultsMs[0]} max={DURATION_BOUNDS.resultsMs[1]} onSet={(v) => set({ resultsMs: v })} />
      <Stepper
        label="New information every"
        hint={`Reveals at ${revealTimes}; the market closes at ${fmtClock(c.marketMs)}. A longer gap stretches the market if needed.`}
        value={reveal}
        show={clock}
        step={15_000}
        min={REVEAL_EVERY_BOUNDS[0]}
        max={REVEAL_EVERY_BOUNDS[1]}
        onSet={(v) => set({ revealEveryMs: v })}
      />
      <Stepper
        label="News shocks per news round"
        hint={hasNews ? `About one every ${clock(Math.round(c.marketMs / (shocks + 1) / 1000) * 1000)}, at random times.` : 'Only used in news shock rounds; add one above.'}
        value={shocks}
        show={(v) => String(v)}
        step={1}
        min={SHOCK_COUNT_BOUNDS[0]}
        max={SHOCK_COUNT_BOUNDS[1]}
        onSet={(v) => set({ shockCount: v })}
      />
      <Stepper
        label="Time between a player's quote updates"
        hint="Pulling a quote is always allowed."
        value={c.quoteCooldownMs}
        show={(v) => (v === 0 ? 'off' : clock(v))}
        step={5_000}
        min={QUOTE_COOLDOWN_BOUNDS[0]}
        max={QUOTE_COOLDOWN_BOUNDS[1]}
        onSet={(v) => set({ quoteCooldownMs: v })}
      />
    </div>
  );
}

function InfoSetup({ s, client }: { s: Snapshot; client: GameClient }) {
  const c = s.config;
  const set = (cmd: Omit<Extract<Parameters<GameClient['command']>[0], { kind: 'setConfig' }>, 'kind'>) => client.command({ kind: 'setConfig', ...cmd }, { toast: false });
  const start = c.privateStart ?? DEFAULT_PRIVATE_START;
  const per = c.privatePerReveal ?? DEFAULT_PRIVATE_PER_REVEAL;
  const clues = c.cluesPerReveal ?? DEFAULT_CLUES_PER_REVEAL;
  const product = c.productMarket ?? false;
  return (
    <div className="card stack">
      <h3>Markets and personal information</h3>
      <div className="stepper">
        <div style={{ flex: 1 }}>
          <div>Product market</div>
          <div className="small muted">A second market on the product of 3 marked cards. Players switch between the two.</div>
        </div>
        <div className="seg">
          <button aria-pressed={product} onClick={() => set({ productMarket: true })}>
            On
          </button>
          <button aria-pressed={!product} onClick={() => set({ productMarket: false })}>
            Off
          </button>
        </div>
      </div>
      <Stepper label="Private cards at the open" value={start} show={String} step={1} min={PRIVATE_START_BOUNDS[0]} max={PRIVATE_START_BOUNDS[1]} onSet={(v) => set({ privateStart: v })} />
      <Stepper label="Private cards at each of the first two reveals" value={per} show={String} step={1} min={PRIVATE_PER_REVEAL_BOUNDS[0]} max={PRIVATE_PER_REVEAL_BOUNDS[1]} onSet={(v) => set({ privatePerReveal: v })} />
      <Stepper
        label="Private clues at the open and each of the first two reveals"
        hint={product ? 'Each clue is about the sum or the product, at random, like "the sum is a multiple of 6".' : 'Clues about the sum, like "the sum is a multiple of 6".'}
        value={clues}
        show={String}
        step={1}
        min={CLUES_PER_REVEAL_BOUNDS[0]}
        max={CLUES_PER_REVEAL_BOUNDS[1]}
        onSet={(v) => set({ cluesPerReveal: v })}
      />
      <p className="small muted">
        Each player ends up with {start + 2 * per} private card{start + 2 * per === 1 ? '' : 's'} and {3 * clues} clue{3 * clues === 1 ? '' : 's'}, all different from their neighbours'. The insider gets 4 extra cards; market makers get nothing.
      </p>
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
        <p className="small muted">Players never see fair values during the market; they work them out. The review after each round shows the exact numbers.</p>
      </div>
      <TimingSetup s={s} client={client} />
      <InfoSetup s={s} client={client} />
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
  const multi = (s.round?.marketIds.length ?? 1) > 1;
  const rows = (s.host?.positions ?? []).slice().sort((a, b) => Math.abs(b.position) / MARKETS[b.market].positionLimit - Math.abs(a.position) / MARKETS[a.market].positionLimit);
  return (
    <div className="card">
      <h3>Positions</h3>
      {!rows.length ? (
        <p className="small muted">Hidden while you are also playing, until the round settles.</p>
      ) : (
        <table>
          <tbody>
            {rows.slice(0, 12).map((p) => (
              <tr key={`${p.market}-${p.playerId}`}>
                <td>
                  {playerName(s, p.playerId)}
                  {multi && <span className="small muted"> {MARKETS[p.market].short.toLowerCase()}</span>}
                </td>
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
