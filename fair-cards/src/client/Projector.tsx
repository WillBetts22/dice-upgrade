import { ROUND_TYPES } from '../shared/rules.js';
import { PriceChart } from './Chart.js';
import { ConnBanner, ContractCards, Countdown, f1, NextInfo, PHASE_LABEL, playerName, RuleLine, roundTitle, ShockBanner, Standings, useClient } from './common.js';

export function ProjectorPage({ code }: { code: string }) {
  const [, state] = useClient(code, null, false);
  const s = state.snapshot;
  if (!s) return <div className="wrap"><ConnBanner state={state} /><p>Connecting...</p></div>;
  const r = s.round;
  const asks = (r?.quotes ?? []).filter((q) => q.askSize > 0).sort((a, b) => a.ask - b.ask);
  const bids = (r?.quotes ?? []).filter((q) => q.bidSize > 0).sort((a, b) => b.bid - a.bid);
  return (
    <div className="wrap stack" style={{ maxWidth: 1400 }}>
      <ConnBanner state={state} />
      <div className="spread">
        <div>
          <h1 style={{ fontSize: '2rem' }}>{r ? roundTitle(s) : 'Fair Cards'}</h1>
          <div className="row">
            <span className="phase-pill">{PHASE_LABEL[s.phase]}</span>
            <span className="small">
              Join at <strong>{location.host}/join/{s.code}</strong>
            </span>
            <NextInfo s={s} offset={state.offset} />
          </div>
        </div>
        {s.phase !== 'lobby' && s.phase !== 'finished' && <Countdown s={s} offset={state.offset} />}
      </div>
      {s.phase === 'lobby' && (
        <div className="card">
          <div className="code-big">{s.code}</div>
          <p>{s.players.filter((p) => !p.spectator).map((p) => p.name).join(', ') || 'Waiting for players...'}</p>
        </div>
      )}
      {s.phase === 'briefing' && r && (
        <div className="card stack">
          <p style={{ fontSize: '1.4rem' }}>
            <strong>Lesson:</strong> {ROUND_TYPES[r.type].lesson}
          </p>
          <p style={{ fontSize: '1.2rem' }}>{ROUND_TYPES[r.type].rules}</p>
          {r.type === 'makers' && (
            <p>
              Makers:{' '}
              {Object.entries(r.roles)
                .filter(([, role]) => role === 'maker')
                .map(([id]) => playerName(s, id))
                .join(', ')}
            </p>
          )}
        </div>
      )}
      {r && (s.phase === 'market' || s.phase === 'results') && (
        <div className="grid2">
          <div className="card stack">
            <ShockBanner s={s} />
            <ContractCards s={s} big />
            <RuleLine rule={r.rule} />
            <PriceChart s={s} offset={state.offset} height={300} />
          </div>
          <div className="stack">
            <div className="card">
              <div className="spread">
                <div>
                  <div className="small muted">{r.settlement !== null ? 'Settlement' : 'Last trade'}</div>
                  <div className="proj-price">{r.settlement ?? r.lastPrice ?? '-'}</div>
                </div>
                {r.publicFv !== null && (
                  <div>
                    <div className="small muted">Public fair value</div>
                    <div className="proj-price" style={{ color: 'var(--muted)' }}>
                      {f1(r.publicFv)}
                    </div>
                  </div>
                )}
              </div>
              <p className="small muted">Volume {r.volume} lots</p>
            </div>
            {s.phase === 'market' && (
              <div className="card quotes">
                <div className="stack" style={{ gap: 4 }}>
                  <div className="small muted">Best asks</div>
                  {asks.slice(0, 6).map((q) => (
                    <div key={q.playerId} className="qrow ask">
                      <span className="who">{playerName(s, q.playerId)}</span>
                      <span className="p">{q.ask}</span>
                      <span className="small">x{q.askSize}</span>
                    </div>
                  ))}
                </div>
                <div className="stack" style={{ gap: 4 }}>
                  <div className="small muted">Best bids</div>
                  {bids.slice(0, 6).map((q) => (
                    <div key={q.playerId} className="qrow bid">
                      <span className="who">{playerName(s, q.playerId)}</span>
                      <span className="p">{q.bid}</span>
                      <span className="small">x{q.bidSize}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {s.phase === 'results' && r.insiderId && <div className="card">The insider was {playerName(s, r.insiderId)}.</div>}
            {s.phase === 'results' && <Standings s={s} />}
          </div>
        </div>
      )}
      {s.phase === 'finished' && <Standings s={s} />}
    </div>
  );
}
