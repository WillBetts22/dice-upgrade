import { useEffect, useState } from 'react';
import { type MarketId, MARKETS } from '../shared/rules.js';
import type { QuoteView, Snapshot } from '../shared/types.js';
import { playerName, useNow } from './common.js';
import type { GameClient } from './net.js';

function canTrade(s: Snapshot, m: MarketId): boolean {
  const me = s.me;
  if (!me || s.phase !== 'market' || s.paused) return false;
  if (me.role === 'taker') return true;
  const q = me.books[m]?.quote;
  return !!q && q.bidSize > 0 && q.askSize > 0;
}

export function QuotePanel({ s, client, offset, m }: { s: Snapshot; client: GameClient; offset: number; m: MarketId }) {
  const me = s.me!;
  const spec = MARKETS[m];
  const mine = me.books[m]!;
  const width = me.role === 'maker' ? spec.makerWidth : spec.maxWidth;
  const step = m === 'product' ? 10 : 1;
  const now = useNow(250) + offset;
  const waitMs = mine.nextQuoteAt !== null ? Math.max(0, mine.nextQuoteAt - now) : 0;
  const seed = mine.quote ? [mine.quote.bid, mine.quote.ask] : [spec.startMid - Math.floor(width / 2), spec.startMid - Math.floor(width / 2) + width];
  const [bid, setBid] = useState(seed[0]);
  const [ask, setAsk] = useState(seed[1]);
  const [size, setSize] = useState(Math.min(mine.quote?.size ?? 2, spec.maxSize));
  const [touched, setTouched] = useState(false);
  // Follow the server quote until the player starts editing.
  useEffect(() => {
    if (!touched && mine.quote) {
      setBid(mine.quote.bid);
      setAsk(mine.quote.ask);
    }
  }, [mine.quote?.id]);

  if (me.role === 'taker') {
    return (
      <div className="card">
        <h3>You are a taker ({spec.short.toLowerCase()} market)</h3>
        <p className="small">You do not quote this round. Buy from a maker's ask or sell to a maker's bid when their price is wrong given your cards.</p>
      </div>
    );
  }
  const q = mine.quote;
  const live = !!q && q.bidSize > 0 && q.askSize > 0;
  const shift = (d: number) => {
    setTouched(true);
    setBid((b) => b + d);
    setAsk((a) => a + d);
  };
  const post = async (b = bid, a = ask) => {
    const r = await client.command({ kind: 'setQuote', market: m, bid: b, ask: a, size });
    if (r.ok) setTouched(false);
  };
  const disabled = s.phase !== 'market' || s.paused;
  const tooWide = ask - bid > width;
  return (
    <div className="card stack">
      <div className="spread">
        <h3 style={{ margin: 0 }}>Your {spec.short.toLowerCase()} quote</h3>
        {q ? (
          <span className={live ? 'live' : 'notlive'}>
            {live ? 'LIVE' : 'ONE SIDE FILLED, requote to trade'} {q.bid} / {q.ask} ({q.bidSize} x {q.askSize})
          </span>
        ) : (
          <span className="notlive">NO QUOTE: you cannot trade</span>
        )}
      </div>
      <div className="quote-box">
        <div>
          <label htmlFor={`bid-${m}`}>Bid (you buy at)</label>
          <input id={`bid-${m}`} type="number" inputMode="numeric" value={bid} onChange={(e) => (setTouched(true), setBid(Number(e.target.value)))} />
        </div>
        <div>
          <label htmlFor={`ask-${m}`}>Ask (you sell at)</label>
          <input id={`ask-${m}`} type="number" inputMode="numeric" value={ask} onChange={(e) => (setTouched(true), setAsk(Number(e.target.value)))} />
        </div>
        <div>
          <label htmlFor={`size-${m}`}>Size</label>
          <select id={`size-${m}`} value={size} onChange={(e) => setSize(Number(e.target.value))}>
            {Array.from({ length: spec.maxSize }, (_, i) => i + 1).map((n) => (
              <option key={n}>{n}</option>
            ))}
          </select>
        </div>
      </div>
      {tooWide && <div className="notice">At most {width} wide this round.</div>}
      <div className="row">
        <div className="stepper">
          <button className="btn" onClick={() => shift(-step)} aria-label={`Move both prices down ${step}`}>
            -{step}
          </button>
          <button className="btn" onClick={() => shift(step)} aria-label={`Move both prices up ${step}`}>
            +{step}
          </button>
        </div>
        <button className="btn primary" disabled={disabled || tooWide || waitMs > 0} onClick={() => post()}>
          {waitMs > 0 ? `Next update in ${Math.ceil(waitMs / 1000)} s` : q ? 'Update quote' : 'Post quote'}
        </button>
        {q && (
          <button className="btn ghost" disabled={disabled} onClick={() => client.command({ kind: 'pullQuote', market: m })}>
            Pull
          </button>
        )}
      </div>
      <p className="small muted">
        Width {ask - bid} of max {width}, up to {spec.maxSize} lots, position limit {spec.positionLimit}.{s.config.quoteCooldownMs > 0 && ` You can post a new quote once every ${Math.round(s.config.quoteCooldownMs / 1000)} s; pulling is always allowed.`} A bid at or above someone's ask buys from them at their price (and an ask at or below a bid sells to it); the rest of your quote stays up.
      </p>
    </div>
  );
}

function QuoteRow({ s, q, side, qty, client, allowed, m }: { s: Snapshot; q: QuoteView; side: 'bid' | 'ask'; qty: number; client: GameClient; allowed: boolean; m: MarketId }) {
  const me = s.you.playerId === q.playerId;
  const px = side === 'ask' ? q.ask : q.bid;
  const avail = side === 'ask' ? q.askAvail : q.bidAvail;
  const shown = side === 'ask' ? q.askSize : q.bidSize;
  const pos = s.me?.books[m]?.position ?? 0;
  const lim = MARKETS[m].positionLimit;
  const room = side === 'ask' ? lim - pos : lim + pos;
  const n = Math.min(qty, avail, room);
  return (
    <div className={`qrow ${side} ${me ? 'me' : ''}`}>
      <span className="who">
        {me ? 'You' : playerName(s, q.playerId)}
        {s.round?.roles[q.playerId] === 'maker' && <span className="badge">MM</span>}
      </span>
      <span className="p">
        {px} <span className="small muted">x{shown}</span>
      </span>
      {me ? (
        <span />
      ) : (
        <button
          className={`btn small ${side === 'ask' ? 'buy' : 'sell'}`}
          disabled={!allowed || n < 1}
          onClick={() => client.command({ kind: 'trade', market: m, targetId: q.playerId, side: side === 'ask' ? 'buy' : 'sell', qty: n, price: px })}
        >
          {side === 'ask' ? 'Buy' : 'Sell'} {Math.max(n, 0)}
        </button>
      )}
    </div>
  );
}

export function Book({ s, client, m, limit = 10 }: { s: Snapshot; client: GameClient; m: MarketId; limit?: number }) {
  const [qty, setQty] = useState(1);
  const [all, setAll] = useState(false);
  const r = s.round!.markets[m]!;
  const allowed = canTrade(s, m);
  const asks = r.quotes.filter((q) => q.askSize > 0).sort((a, b) => a.ask - b.ask || a.postedAt - b.postedAt);
  const bids = r.quotes.filter((q) => q.bidSize > 0).sort((a, b) => b.bid - a.bid || a.postedAt - b.postedAt);
  const n = all ? Infinity : limit;
  return (
    <div className="card stack">
      <div className="spread">
        <h3 style={{ margin: 0 }}>{MARKETS[m].short} quotes</h3>
        <div className="row small">
          Lots per click
          <div className="seg">
            {[1, 2, 3, 5].filter((k) => k <= MARKETS[m].maxSize).map((k) => (
              <button key={k} aria-pressed={qty === k} onClick={() => setQty(k)} style={{ minHeight: 34, padding: '4px 10px' }}>
                {k}
              </button>
            ))}
          </div>
        </div>
      </div>
      {!allowed && s.phase === 'market' && s.me && <div className="notice">Post a live two-sided {MARKETS[m].short.toLowerCase()} quote to unlock trading with others in this market.</div>}
      <div className="quotes">
        <div className="stack" style={{ gap: 4 }}>
          <div className="small muted">Asks: buy from them</div>
          {asks.slice(0, n).map((q) => (
            <QuoteRow key={q.playerId} s={s} q={q} side="ask" qty={qty} client={client} allowed={allowed} m={m} />
          ))}
          {!asks.length && <div className="small muted">No asks</div>}
        </div>
        <div className="stack" style={{ gap: 4 }}>
          <div className="small muted">Bids: sell to them</div>
          {bids.slice(0, n).map((q) => (
            <QuoteRow key={q.playerId} s={s} q={q} side="bid" qty={qty} client={client} allowed={allowed} m={m} />
          ))}
          {!bids.length && <div className="small muted">No bids</div>}
        </div>
      </div>
      {(asks.length > limit || bids.length > limit) && (
        <button className="btn ghost small" onClick={() => setAll((x) => !x)}>
          {all ? 'Show fewer' : `Show all ${Math.max(asks.length, bids.length)}`}
        </button>
      )}
    </div>
  );
}

export function Tape({ s, m, limit = 12 }: { s: Snapshot; m: MarketId; limit?: number }) {
  const mk = s.round?.markets[m];
  const t = mk?.trades ?? [];
  const me = s.you.playerId;
  return (
    <div className="card">
      <h3>
        {MARKETS[m].short} trades <span className="small muted">volume {mk?.volume ?? 0}</span>
      </h3>
      {t.length === 0 ? (
        <p className="small muted">No trades yet.</p>
      ) : (
        <table>
          <tbody>
            {t
              .slice(-limit)
              .reverse()
              .map((x) => (
                <tr key={x.id} className={x.buyerId === me || x.sellerId === me ? 'mine' : ''}>
                  <td className="small muted">{new Date(x.at).toLocaleTimeString([], { minute: '2-digit', second: '2-digit' })}</td>
                  <td className="num">
                    <strong>{x.price}</strong> x{x.qty}
                  </td>
                  <td className="small">
                    {x.aggressorId === x.buyerId
                      ? `${playerName(s, x.buyerId)} bought from ${playerName(s, x.sellerId)}`
                      : `${playerName(s, x.sellerId)} sold to ${playerName(s, x.buyerId)}`}
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
