import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { cardLabel, cardValue, isRed, ruleSummary, SHOCKS, type ValueRule } from '../shared/cards.js';
import { ROUND_TYPES } from '../shared/rules.js';
import type { Phase, Role, Snapshot } from '../shared/types.js';
import { type ClientState, GameClient } from './net.js';

export function useClient(code: string, token: string | null, asHost: boolean): [GameClient, ClientState] {
  const client = useMemo(() => new GameClient(code, token, asHost), [code, token, asHost]);
  useEffect(() => () => client.close(), [client]);
  const state = useSyncExternalStore(client.subscribe, client.getState);
  return [client, state];
}

export function useNow(intervalMs = 250): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

export function fmtClock(ms: number | null): string {
  if (ms === null) return '--:--';
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

export function remainingMs(s: Snapshot, offset: number, now: number): number | null {
  if (s.paused) return s.pausedRemainingMs;
  if (s.phaseDeadline === null) return null;
  return Math.max(0, s.phaseDeadline - (now + offset));
}

export function Countdown({ s, offset }: { s: Snapshot; offset: number }) {
  const now = useNow();
  const ms = remainingMs(s, offset, now);
  return <span className={`timer ${ms !== null && ms < 30_000 && !s.paused ? 'low' : ''}`}>{fmtClock(ms)}</span>;
}

export function NextInfo({ s, offset }: { s: Snapshot; offset: number }) {
  const now = useNow();
  const at = s.round?.nextInfoAt;
  if (!at || s.phase !== 'market' || s.paused) return null;
  return <span className="small muted">next reveal in {fmtClock(at - (now + offset))}</span>;
}

export const PHASE_LABEL: Record<Phase, string> = {
  lobby: 'Lobby',
  briefing: 'Briefing',
  market: 'Market open',
  results: 'Results',
  finished: 'Finished',
};

export const ROLE_LABEL: Record<Role, string> = { trader: 'Trader', maker: 'Market maker', taker: 'Taker' };

export function playerName(s: Snapshot, id: string | null | undefined): string {
  return s.players.find((p) => p.id === id)?.name ?? '?';
}

export const f1 = (x: number | null | undefined) => (x === null || x === undefined ? '-' : (Math.round(x * 10) / 10).toFixed(1));
export const signed = (x: number) => `${x >= 0 ? '+' : '-'}${Math.abs(x).toFixed(1)}`;

export function Card({ id, rule, mine, big, fresh }: { id: number | null; rule?: ValueRule; mine?: boolean; big?: boolean; fresh?: boolean }) {
  if (id === null) return <div className={`pcard hidden ${big ? 'big' : ''}`}>?</div>;
  const v = rule ? cardValue(id, rule) : null;
  return (
    <div className={`pcard ${isRed(id) ? 'red' : ''} ${mine ? 'mine' : ''} ${big ? 'big' : ''} ${fresh ? 'new' : ''}`} title={v !== null ? `worth ${v}` : undefined}>
      {cardLabel(id)}
      {v !== null && <span className="v">{v}</span>}
    </div>
  );
}

/** The contract: public cards, then question marks for the hidden ones. */
export function ContractCards({ s, big, mine = [] }: { s: Snapshot; big?: boolean; mine?: number[] }) {
  const r = s.round!;
  const shown = r.contract ?? r.publicCards;
  const hidden = Math.max(0, r.contractSize - shown.length);
  return (
    <div className="cards" aria-label="Contract cards">
      {shown.map((c) => (
        <Card key={c} id={c} rule={r.rule} big={big} mine={mine.includes(c)} />
      ))}
      {Array.from({ length: hidden }, (_, i) => (
        <Card key={`h${i}`} id={null} big={big} />
      ))}
    </div>
  );
}

export function RuleLine({ rule }: { rule: ValueRule }) {
  const parts = ruleSummary(rule);
  return <span className="small">{parts.length ? `Rule now: ${parts.join(', ')}` : 'A=1 ... K=13, settles at the sum'}</span>;
}

export function ShockBanner({ s }: { s: Snapshot }) {
  const shocks = s.round?.shocks ?? [];
  if (!shocks.length) return null;
  const last = shocks[shocks.length - 1];
  return (
    <div className="shock" role="alert">
      News: {SHOCKS[last.id].label}. {SHOCKS[last.id].description}
      {shocks.length > 1 && <div className="small">Earlier: {shocks.slice(0, -1).map((x) => SHOCKS[x.id].label).join(', ')}</div>}
    </div>
  );
}

export function roundTitle(s: Snapshot): string {
  if (!s.round) return '';
  return `Round ${s.round.number} of ${s.config.roundTypes.length}: ${ROUND_TYPES[s.round.type].name}`;
}

export function Toasts({ state }: { state: ClientState }) {
  return (
    <div className="toasts" role="status" aria-live="polite">
      {state.toasts.map((t) => (
        <div key={t.id} className={`toast ${t.ok ? '' : 'bad'}`}>
          {t.text}
        </div>
      ))}
    </div>
  );
}

export function ConnBanner({ state }: { state: ClientState }) {
  const s = state.snapshot;
  return (
    <>
      {state.conn !== 'open' && (
        <div className="banner bad" role="alert">
          {state.conn === 'connecting' ? 'Connecting to the game server...' : 'Connection lost. Reconnecting... Your quote stays up.'}
        </div>
      )}
      {s?.paused && (
        <div className="banner warn" role="alert">
          The host has paused the game. Trading is blocked until it resumes.
        </div>
      )}
      {state.error && <div className="banner bad">{state.error}</div>}
    </>
  );
}

export function TopBar({ state, title }: { state: ClientState; title: string }) {
  const s = state.snapshot;
  return (
    <div className="topbar">
      <div className="inner">
        <div className="row">
          <strong>{title}</strong>
          {s && <span className="phase-pill">{PHASE_LABEL[s.phase]}{s.round ? ` · round ${s.round.number}/${s.config.roundTypes.length}` : ''}</span>}
          {s && <NextInfo s={s} offset={state.offset} />}
        </div>
        <div className="row">{s && s.phase !== 'lobby' && s.phase !== 'finished' && <Countdown s={s} offset={state.offset} />}</div>
      </div>
    </div>
  );
}

export function navigate(path: string) {
  history.pushState(null, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

export function Standings({ s }: { s: Snapshot }) {
  const rows = s.players.filter((p) => !p.spectator).sort((a, b) => b.total - a.total);
  if (!s.results.length) return null;
  return (
    <div className="card">
      <h3>Standings</h3>
      <div className="scroll-x">
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>Player</th>
              {s.results.map((r) => (
                <th key={r.number} className="num">
                  R{r.number}
                </th>
              ))}
              <th className="num">Total</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p, i) => (
              <tr key={p.id} className={p.id === s.you.playerId ? 'mine' : ''}>
                <td>{i + 1}</td>
                <td>{p.name}</td>
                {s.results.map((r) => (
                  <td key={r.number} className={`num ${(r.pnl[p.id] ?? 0) > 0 ? 'pos' : (r.pnl[p.id] ?? 0) < 0 ? 'neg' : ''}`}>
                    {r.pnl[p.id] ?? '-'}
                  </td>
                ))}
                <td className="num">
                  <strong>{p.total}</strong>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
