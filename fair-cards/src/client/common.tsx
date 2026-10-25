import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { cardLabel, cardValue, isRed, ruleSummary, SHOCKS, type ValueRule } from '../shared/cards.js';
import type { Clue } from '../shared/clues.js';
import { type MarketId, MARKETS, ROUND_TYPES } from '../shared/rules.js';
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

export function Card({ id, rule, mine, big, fresh, product }: { id: number | null; rule?: ValueRule; mine?: boolean; big?: boolean; fresh?: boolean; product?: boolean }) {
  const tag = product && <span className="ptag" title="Product card">P</span>;
  if (id === null) return <div className={`pcard hidden ${big ? 'big' : ''} ${product ? 'prod' : ''}`}>?{tag}</div>;
  const v = rule ? cardValue(id, rule) : null;
  return (
    <div className={`pcard ${isRed(id) ? 'red' : ''} ${mine ? 'mine' : ''} ${big ? 'big' : ''} ${fresh ? 'new' : ''} ${product ? 'prod' : ''}`} title={`${v !== null ? `worth ${v}` : ''}${product ? ' (product card)' : ''}`.trim() || undefined}>
      {cardLabel(id)}
      {v !== null && <span className="v">{v}</span>}
      {tag}
    </div>
  );
}

/** The contract: public cards, then question marks for the hidden ones; product cards carry a P. */
export function ContractCards({ s, big, mine = [] }: { s: Snapshot; big?: boolean; mine?: number[] }) {
  const r = s.round!;
  const shown = r.contract ?? r.publicCards;
  const hidden = Math.max(0, r.contractSize - shown.length);
  const prod = new Set(r.productKnown);
  const hiddenProduct = Math.max(0, r.productCount - shown.filter((c) => prod.has(c)).length);
  return (
    <div className="cards" aria-label="Contract cards">
      {shown.map((c) => (
        <Card key={c} id={c} rule={r.rule} big={big} mine={mine.includes(c)} product={prod.has(c)} />
      ))}
      {Array.from({ length: hidden }, (_, i) => (
        <Card key={`h${i}`} id={null} big={big} product={i < hiddenProduct} />
      ))}
    </div>
  );
}

/** Tabs to switch between the markets running this round. */
export function MarketTabs({ s, value, onChange }: { s: Snapshot; value: MarketId; onChange: (m: MarketId) => void }) {
  const ids = s.round?.marketIds ?? ['sum'];
  if (ids.length < 2) return null;
  return (
    <div className="seg tabs" role="tablist">
      {ids.map((m) => {
        const b = s.me?.books[m];
        return (
          <button key={m} role="tab" aria-selected={value === m} aria-pressed={value === m} onClick={() => onChange(m)}>
            {MARKETS[m].name}
            {b && b.position !== 0 && <span className="small"> ({b.position > 0 ? `+${b.position}` : b.position})</span>}
            {b && s.me!.role !== 'taker' && !(b.quote && b.quote.bidSize > 0 && b.quote.askSize > 0) && s.phase === 'market' && <span className="small notlive"> no quote</span>}
          </button>
        );
      })}
    </div>
  );
}

export function ClueList({ clues }: { clues: Clue[] }) {
  if (!clues.length) return null;
  return (
    <div>
      <div className="small muted">Your private clues (face values: A=1 ... K=13; news does not change them)</div>
      <ul className="clues">
        {clues.map((c) => (
          <li key={c.id}>
            <span className={`badge mk-${c.market}`}>{MARKETS[c.market].short}</span> {c.text}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function RuleLine({ rule }: { rule: ValueRule }) {
  const parts = ruleSummary(rule);
  return <span className="small">{parts.length ? `Rule now: ${parts.join(', ')}` : 'A=1 ... K=13. Sum market: all cards. Product market: the P cards.'}</span>;
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
