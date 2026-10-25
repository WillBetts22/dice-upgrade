import { POSITION_LIMIT, ROUND_TYPES } from '../shared/rules.js';
import type { Snapshot } from '../shared/types.js';
import { PriceChart } from './Chart.js';
import { Card, ConnBanner, ContractCards, f1, playerName, ROLE_LABEL, RuleLine, roundTitle, ShockBanner, Standings, Toasts, TopBar, useClient, useNow } from './common.js';
import { Book, QuotePanel, Tape } from './Market.js';
import { creds } from './net.js';
import { RoundReview, SessionReport } from './Review.js';
import { RulesSummary } from './Rules.js';

export function PlayerPage({ code }: { code: string }) {
  const token = creds.get('player', code);
  const [client, state] = useClient(code, token, false);
  const s = state.snapshot;
  if (!token) {
    return (
      <div className="wrap stack">
        <h1>Room {code}</h1>
        <p>
          You have not joined this room on this device. <a href={`/join/${code}`}>Join it</a>.
        </p>
      </div>
    );
  }
  if (!s) {
    return (
      <div className="wrap">
        <ConnBanner state={state} />
        <p>Connecting...</p>
      </div>
    );
  }
  const myName = playerName(s, s.you.playerId);
  return (
    <>
      <TopBar state={state} title={s.you.kind === 'player' ? myName : `Watching ${code}`} />
      <div className="wrap stack">
        <ConnBanner state={state} />
        {s.you.kind !== 'player' && <div className="banner warn">You are watching. This device has no player seat in room {code}.</div>}
        {s.phase === 'lobby' && <Lobby s={s} />}
        {s.phase === 'briefing' && <Briefing s={s} />}
        {s.phase === 'market' && s.round && (
          <div className="grid2">
            <div className="stack">
              <InfoCard s={s} />
              {s.me && <QuotePanel key={s.round.number} s={s} client={client} />}
            </div>
            <div className="stack">
              <Book s={s} client={client} />
              <div className="card">
                <PriceChart s={s} offset={state.offset} myFv={s.me?.fv} />
              </div>
              <Tape s={s} />
            </div>
          </div>
        )}
        {s.phase === 'results' && <Results s={s} offset={state.offset} />}
        {s.phase === 'finished' && (
          <>
            <h1>Session over</h1>
            <Standings s={s} />
            {s.you.playerId && <SessionReport s={s} playerId={s.you.playerId} />}
          </>
        )}
      </div>
      <Toasts state={state} />
    </>
  );
}

function Lobby({ s }: { s: Snapshot }) {
  const me = s.players.find((p) => p.id === s.you.playerId);
  return (
    <div className="stack">
      <div className="card">
        <h2>{me?.spectator ? 'You are watching this session' : "You're in. Waiting for the host to start."}</h2>
        <p className="small muted">
          {s.players.filter((p) => !p.spectator).length} players: {s.players.filter((p) => !p.spectator).map((p) => p.name).join(', ')}
        </p>
        <p className="small">
          Rounds: {s.config.roundTypes.map((t) => ROUND_TYPES[t].name).join(', ')}.
        </p>
      </div>
      <div className="card">
        <RulesSummary />
      </div>
    </div>
  );
}

function Briefing({ s }: { s: Snapshot }) {
  const r = s.round!;
  const t = ROUND_TYPES[r.type];
  const me = s.me;
  return (
    <div className="card stack">
      <h1>{roundTitle(s)}</h1>
      <p>
        <strong>Lesson:</strong> {t.lesson}
      </p>
      <p>{t.rules}</p>
      {me && (
        <div className="banner warn">
          Your role: <span className="role">{ROLE_LABEL[me.role]}</span>
          {me.role === 'maker' && ' You see no private cards. Quote at most 2 wide and earn a rebate on every fill. Watch who trades with you.'}
          {me.role === 'taker' && ' You get private cards. You cannot quote; pick off makers whose prices are wrong.'}
          {me.isInsider && ' You are the insider: you start with 5 private cards. Use them without being obvious.'}
        </div>
      )}
      <p className="small muted">The market opens when the timer ends.</p>
    </div>
  );
}

function InfoCard({ s }: { s: Snapshot }) {
  const r = s.round!;
  const me = s.me;
  const pos = me?.position ?? 0;
  const pnlAtFv = me && me.fv !== null ? me.cash + pos * me.fv : null;
  const now = useNow(1000);
  const uptimePct = me && r.startedAt ? Math.min(100, Math.round((me.uptimeMs / Math.max(1, Math.min(now, r.endsAt ?? now) - r.startedAt)) * 100)) : null;
  return (
    <div className="card stack">
      <div className="spread">
        <h3 style={{ margin: 0 }}>{roundTitle(s)}</h3>
        {me && <span className="badge">{ROLE_LABEL[me.role]}</span>}
      </div>
      <ShockBanner s={s} />
      <div>
        <div className="small muted">
          Contract: {r.publicCards.length} of {r.contractSize} cards public
        </div>
        <ContractCards s={s} mine={me?.privateCards} />
        <RuleLine rule={r.rule} />
      </div>
      {me && (
        <div>
          <div className="small muted">Your private cards {me.isInsider && '(insider)'}</div>
          <div className="cards">
            {me.privateCards.length ? me.privateCards.map((c) => <Card key={c} id={c} rule={r.rule} mine />) : <span className="small muted">None{me.role === 'maker' ? ': makers trade blind' : ''}</span>}
          </div>
        </div>
      )}
      <div className="strip">
        {me?.fv != null && (
          <div className="stat">
            <div className="k">Your fair value</div>
            <div className="v">{f1(me.fv)}</div>
          </div>
        )}
        {r.publicFv !== null && (
          <div className="stat">
            <div className="k">Public fair value</div>
            <div className="v">{f1(r.publicFv)}</div>
          </div>
        )}
        <div className="stat">
          <div className="k">Last trade</div>
          <div className="v">{r.lastPrice ?? '-'}</div>
        </div>
        {me && (
          <div className={`stat ${Math.abs(pos) >= POSITION_LIMIT - 2 ? 'warn' : ''}`}>
            <div className="k">Position</div>
            <div className={`v ${pos > 0 ? 'pos' : pos < 0 ? 'neg' : ''}`}>
              {pos > 0 ? `+${pos}` : pos} <span className="small muted">/ {POSITION_LIMIT}</span>
            </div>
          </div>
        )}
        {me && (
          <div className="stat">
            <div className="k">Cash</div>
            <div className="v">{me.cash}</div>
          </div>
        )}
        {pnlAtFv !== null && (
          <div className="stat">
            <div className="k">P&L at your FV</div>
            <div className={`v ${pnlAtFv > 0 ? 'pos' : pnlAtFv < 0 ? 'neg' : ''}`}>{f1(pnlAtFv)}</div>
          </div>
        )}
        {me && me.role !== 'taker' && uptimePct !== null && (
          <div className="stat">
            <div className="k">Quoting uptime</div>
            <div className="v">{uptimePct}%</div>
          </div>
        )}
      </div>
      {me?.fv != null && (
        <p className="small muted">
          Fair value = known cards + each hidden card at the average of the cards you have not seen. Score = cash + position x settlement.
        </p>
      )}
    </div>
  );
}

function Results({ s, offset }: { s: Snapshot; offset: number }) {
  const r = s.round!;
  const res = s.results.find((x) => x.number === r.number);
  const mine = s.reviews.find((x) => x.roundNumber === r.number && x.playerId === s.you.playerId);
  const pnl = res && s.you.playerId ? res.pnl[s.you.playerId] : undefined;
  return (
    <div className="stack">
      <div className="card stack">
        <h1>
          Settled at {r.settlement}
          {pnl !== undefined && (
            <span className={pnl > 0 ? 'pos' : pnl < 0 ? 'neg' : ''} style={{ marginLeft: 16 }}>
              you {pnl >= 0 ? '+' : ''}
              {pnl}
            </span>
          )}
        </h1>
        <ContractCards s={s} mine={s.me?.privateCards} />
        <RuleLine rule={r.rule} />
        {r.insiderId && <p>The insider was {r.insiderId === s.you.playerId ? 'you' : playerName(s, r.insiderId)}.</p>}
        <PriceChart s={s} offset={offset} />
      </div>
      {mine && <RoundReview r={mine} s={s} />}
      <Standings s={s} />
    </div>
  );
}
