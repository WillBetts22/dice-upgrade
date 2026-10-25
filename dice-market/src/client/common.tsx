import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { CATALOG, type UpgradeId } from '../shared/catalog.js';
import type { Phase } from '../shared/rules.js';
import type { Snapshot } from '../shared/types.js';
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

export function remainingMs(s: Snapshot, offset: number, now: number): number | null {
  if (s.paused) return s.pausedRemainingMs;
  if (s.phaseDeadline === null) return null;
  return Math.max(0, s.phaseDeadline - (now + offset));
}

export function fmtClock(ms: number | null): string {
  if (ms === null) return '--:--';
  const total = Math.ceil(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

export function Countdown({ s, offset, big = true }: { s: Snapshot; offset: number; big?: boolean }) {
  const now = useNow();
  const ms = remainingMs(s, offset, now);
  return (
    <span className={`${big ? 'timer' : 'num'} ${ms !== null && ms < 30_000 && !s.paused ? 'low' : ''}`} aria-live="off">
      {fmtClock(ms)}
    </span>
  );
}

export const PHASE_LABEL: Record<Phase, string> = {
  lobby: 'Lobby',
  market: 'Market open',
  settling: 'Settling',
  selection: 'Choose upgrades',
  reveal: 'Dice reveal',
  results: 'Results',
  finished: 'Finished',
};

export const upName = (t: UpgradeId | string) => CATALOG[t as UpgradeId]?.name ?? t;

export function playerName(s: Snapshot, id: string): string {
  return s.players.find((p) => p.id === id)?.name ?? '?';
}

/** Signed quantity rendered with words, signs and color. */
export function Qty({ q }: { q: number }) {
  if (q > 0) return <span className="pos">+{q} owned</span>;
  if (q < 0) return <span className="neg">owes {-q}</span>;
  return <span className="muted">0</span>;
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
          {state.conn === 'connecting' ? 'Connecting to the game server...' : 'Connection lost. Reconnecting... Your orders stay on the book.'}
        </div>
      )}
      {s?.paused && (
        <div className="banner warn" role="alert">
          The host has paused the game. Trading and selection are blocked until it resumes.
        </div>
      )}
      {state.error && <div className="banner bad">{state.error}</div>}
    </>
  );
}

export function TopBar({ state, title, right }: { state: ClientState; title: string; right?: React.ReactNode }) {
  const s = state.snapshot;
  return (
    <div className="topbar">
      <div className="inner">
        <div className="row">
          <strong>{title}</strong>
          {s && <span className="phase-pill">{PHASE_LABEL[s.phase]}{s.round ? ` · round ${s.roundNumber}/${s.config.rounds}` : ''}</span>}
        </div>
        <div className="row">
          {right}
          {s && s.phase !== 'lobby' && s.phase !== 'finished' && <Countdown s={s} offset={state.offset} />}
        </div>
      </div>
    </div>
  );
}

export function navigate(path: string) {
  history.pushState(null, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
}
