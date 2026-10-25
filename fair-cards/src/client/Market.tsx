import { useEffect, useState } from 'react';
import { MAKER_WIDTH, MAX_QUOTE_SIZE, MAX_WIDTH, POSITION_LIMIT } from '../shared/rules.js';
import type { QuoteView, Snapshot } from '../shared/types.js';
import { f1, playerName } from './common.js';
import type { GameClient } from './net.js';

function canTrade(s: Snapshot): boolean {
  const me = s.me;
  if (!me || s.phase !== 'market' || s.paused) return false;
  if (me.role === 'taker') return true;
  return !!me.quote && me.quote.bidSize > 0 && me.quote.askSize > 0;
}

export function QuotePanel({ s, client }: { s: Snapshot; client: GameClient }) {
  const me = s.me!;
  const width = me.role === 'maker' ? MAKER_WIDTH : MAX_WIDTH;
  const fv = me.fv;
  const seed = me.quote ? [me.quote.bid, me.quote.ask] : fv !== null ? [Math.round(fv) - Math.floor(width / 2), Math.round(fv) - Math.floor(width / 2) + width] : [68, 68 + width];
  const [bid, setBid] = useState(seed[0]);
  const [ask, setAsk] = useState(seed[1]);
  const [size, setSize] = useState(me.quote?.size ?? 2);
  const [touched, setTouched] = useState(false);
  // Follow the server quote until the player starts editing.
  useEffect(() => {
    if (!touched && me.quote) {
      setBid(me.quote.bid);
      setAsk(me.quote.ask);
    }
  }, [me.quote?.id]);

  if (me.role === 'taker') {
    return (
      <div className="card">
        <h3>You are a taker</h3>
        <p className="small">You do not quote this round. Buy from a maker's ask or sell to a maker's bid when their price is wrong given your cards.</p>
      </div>
    );
  }
  const q = me.quote;
  const live = !!q && q.bidSize > 0 && q.askSize > 0;
  const shift = (d: number) => {
    setTouched(true);
    setBid((b) => b + d);
    setAsk((a) => a + d);
  };
  const center = () => {
    if (fv === null) return;
    setTouched(true);
    const skew = Math.round(-0.3 * me.position);
    const b = Math.round(fv) + skew - Math.floor(width / 2);
    setBid(b);
    setAsk(b + width);
  };
  const post = async (b = bid, a = ask) => {
    const r = await client.command({ kind: 'setQuote', bid: b, ask: a, size });
    if (r.ok) setTouched(false);
  };
  const disabled = s.phase !== 'market' || s.paused;
  const tooWide = ask - bid > width;
  return (
    <div className="card stack">
      <div className="spread">
        <h3 style={{ margin: 0 }}>Your quote</h3>
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
          <label htmlFor="bid">Bid (you buy at)</label>
          <input id="bid" type="number" inputMode="numeric" value={bid} onChange={(e) => (setTouched(true), setBid(Number(e.target.value)))} />
        </div>
        <div>
          <label htmlFor="ask">Ask (you sell at)</label>
          <input id="ask" type="number" inputMode="numeric" value={ask} onChange={(e) => (setTouched(true), setAsk(Number(e.target.value)))} />
        </div>
        <div>
          <label htmlFor="size">Size</label>
          <select id="size" value={size} onChange={(e) => setSize(Number(e.target.value))}>
            {Array.from({ length: MAX_QUOTE_SIZE }, (_, i) => i + 1).map((n) => (
              <option key={n}>{n}</option>
            ))}
          </select>
        </div>
      </div>
      {tooWide && <div className="notice">At most {width} wide this round.</div>}
      <div className="row">
        <div className="stepper">
          <button className="btn" onClick={() => shift(-1)} aria-label="Move both prices down 1">
            -1
          </button>
          <button className="btn" onClick={() => shift(1)} aria-label="Move both prices up 1">
            +1
          </button>
        </div>
        {fv !== null && (
          <button className="btn" onClick={center} title="Centers on your fair value, shaded against your position">
            Center on {f1(fv)}
          </button>
        )}
        <button className="btn primary" disabled={disabled || tooWide} onClick={() => post()}>
          {q ? 'Update quote' : 'Post quote'}
        </button>
        {q && (
          <button className="btn ghost" disabled={disabled} onClick={() => client.command({ kind: 'pullQuote' })}>
            Pull
          </button>
        )}
      </div>
      <p className="small muted">
        Width {ask - bid} of max {width}. Others can buy from your ask or sell to your bid. A quote that crosses someone else's price is rejected: trade with them instead.
      </p>
    </div>
  );
}

function QuoteRow({ s, q, side, qty, client, allowed }: { s: Snapshot; q: QuoteView; side: 'bid' | 'ask'; qty: number; client: GameClient; allowed: boolean }) {
  const me = s.you.playerId === q.playerId;
  const px = side === 'ask' ? q.ask : q.bid;
  const avail = side === 'ask' ? q.askAvail : q.bidAvail;
  const shown = side === 'ask' ? q.askSize : q.bidSize;
  const pos = s.me?.position ?? 0;
  const room = side === 'ask' ? POSITION_LIMIT - pos : POSITION_LIMIT + pos;
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
          onClick={() => client.command({ kind: 'trade', targetId: q.playerId, side: side === 'ask' ? 'buy' : 'sell', qty: n, price: px })}
        >
          {side === 'ask' ? 'Buy' : 'Sell'} {Math.max(n, 0)}
        </button>
      )}
    </div>
  );
}

export function Book({ s, client, limit = 10 }: { s: Snapshot; client: GameClient; limit?: number }) {
  const [qty, setQty] = useState(1);
  const [all, setAll] = useState(false);
  const r = s.round!;
  const allowed = canTrade(s);
  const asks = r.quotes.filter((q) => q.askSize > 0).sort((a, b) => a.ask - b.ask || a.postedAt - b.postedAt);
  const bids = r.quotes.filter((q) => q.bidSize > 0).sort((a, b) => b.bid - a.bid || a.postedAt - b.postedAt);
  const n = all ? Infinity : limit;
  return (
    <div className="card stack">
      <div className="spread">
        <h3 style={{ margin: 0 }}>Quotes</h3>
        <div className="row small">
          Lots per click
          <div className="seg">
            {[1, 2, 3, 5].map((k) => (
              <button key={k} aria-pressed={qty === k} onClick={() => setQty(k)} style={{ minHeight: 34, padding: '4px 10px' }}>
                {k}
              </button>
            ))}
          </div>
        </div>
      </div>
      {!allowed && s.phase === 'market' && s.me && <div className="notice">Post a live two-sided quote to unlock trading with others.</div>}
      <div className="quotes">
        <div className="stack" style={{ gap: 4 }}>
          <div className="small muted">Asks: buy from them</div>
          {asks.slice(0, n).map((q) => (
            <QuoteRow key={q.playerId} s={s} q={q} side="ask" qty={qty} client={client} allowed={allowed} />
          ))}
          {!asks.length && <div className="small muted">No asks</div>}
        </div>
        <div className="stack" style={{ gap: 4 }}>
          <div className="small muted">Bids: sell to them</div>
          {bids.slice(0, n).map((q) => (
            <QuoteRow key={q.playerId} s={s} q={q} side="bid" qty={qty} client={client} allowed={allowed} />
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

export function Tape({ s, limit = 12 }: { s: Snapshot; limit?: number }) {
  const t = s.round?.trades ?? [];
  const me = s.you.playerId;
  return (
    <div className="card">
      <h3>
        Trades <span className="small muted">volume {s.round?.volume ?? 0}</span>
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
