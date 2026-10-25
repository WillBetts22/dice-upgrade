import { useMemo, useState } from 'react';
import { CATALOG, UPGRADE_IDS, type UpgradeId } from '../shared/catalog.js';
import { CLOSEOUT_FALLBACK_PRICE, MAX_DEDUCTION_PER_ROUND, MAX_PRICE, MAX_SHORT_UNITS, MIN_PRICE } from '../shared/rules.js';
import type { PrivateAccount, PublicOrder, Side, Snapshot, Trade } from '../shared/types.js';
import { Qty, playerName, upName } from './common.js';
import type { GameClient } from './net.js';

export function ExposureStrip({ a, s }: { a: PrivateAccount; s: Snapshot }) {
  return (
    <div className="strip" aria-label="Your balances">
      <div className="stat">
        <div className="k">Cash</div>
        <div className="v">{a.cash}</div>
      </div>
      <div className="stat">
        <div className="k">Reserved for bids</div>
        <div className="v">{a.reservedForBids}</div>
      </div>
      <div className="stat">
        <div className="k">Spendable</div>
        <div className="v">{a.spendable}</div>
      </div>
      <div className={`stat ${a.owedUnits ? 'warn' : ''}`}>
        <div className="k">Owed units</div>
        <div className="v">
          {a.owedUnits}
          <span className="small muted"> / {MAX_SHORT_UNITS} max</span>
        </div>
      </div>
      <div className={`stat ${a.estimatedDeduction ? 'warn' : ''}`}>
        <div className="k">Est. final deduction{a.estimateProvisional ? ' (provisional)' : ''}</div>
        <div className="v">{a.estimatedDeduction}</div>
      </div>
      <div className="stat">
        <div className="k">Worst-case deduction limit</div>
        <div className="v small" style={{ fontSize: '1rem' }}>
          {MAX_DEDUCTION_PER_ROUND} per round
        </div>
      </div>
      {s.phase === 'market' && a.worstCaseShortUnits > a.owedUnits && (
        <div className="stat warn" style={{ gridColumn: '1 / -1' }}>
          <div className="k">If all your asks fill</div>
          <div className="small">
            you would owe {a.worstCaseShortUnits} unit{a.worstCaseShortUnits === 1 ? '' : 's'} (limit {MAX_SHORT_UNITS}).
          </div>
        </div>
      )}
    </div>
  );
}

function sortedBook(orders: PublicOrder[]) {
  const asks = orders.filter((o) => o.side === 'ask').sort((a, b) => a.price - b.price || a.seq - b.seq);
  const bids = orders.filter((o) => o.side === 'bid').sort((a, b) => b.price - a.price || a.seq - b.seq);
  return { asks, bids };
}

export function BookView({ s, type, client, myId, canTrade }: { s: Snapshot; type: UpgradeId; client: GameClient | null; myId: string | null; canTrade: boolean }) {
  const orders = s.round!.books[type] ?? [];
  const { asks, bids } = sortedBook(orders);
  const u = s.round!.upgrades[type];
  const take = (o: PublicOrder, qty: number) =>
    client?.command({ kind: 'acceptQuote', orderId: o.id, expectedRemaining: o.remaining, qty });
  const row = (o: PublicOrder) => {
    const mine = o.playerId === myId;
    return (
      <div key={o.id} className={`lvl ${o.side}`}>
        <span className="p num">{o.price}</span>
        <span className={mine ? 'mine' : ''}>{mine ? 'You' : playerName(s, o.playerId)}</span>
        <span className="num">×{o.remaining}</span>
        <span className="row" style={{ justifyContent: 'flex-end' }}>
          {mine ? (
            canTrade && (
              <button className="btn small ghost" onClick={() => client?.command({ kind: 'cancelOrder', orderId: o.id })}>
                Cancel
              </button>
            )
          ) : (
            canTrade && (
              <>
                <button className={`btn small ${o.side === 'ask' ? 'buy' : 'sell'}`} onClick={() => take(o, 1)} title={o.side === 'ask' ? 'Buy one at this price' : 'Sell one at this price'}>
                  {o.side === 'ask' ? 'Buy' : 'Sell'} 1
                </button>
                {o.remaining > 1 && (
                  <button className={`btn small ${o.side === 'ask' ? 'buy' : 'sell'}`} onClick={() => take(o, 2)}>
                    2
                  </button>
                )}
              </>
            )
          )}
        </span>
      </div>
    );
  };
  const bestBid = bids[0]?.price;
  const bestAsk = asks[0]?.price;
  return (
    <div className="stack">
      <div className="strip">
        <div className="stat">
          <div className="k">Best bid</div>
          <div className="v" style={{ color: 'var(--buy)' }}>{bestBid ?? '–'}</div>
        </div>
        <div className="stat">
          <div className="k">Best ask</div>
          <div className="v" style={{ color: 'var(--sell)' }}>{bestAsk ?? '–'}</div>
        </div>
        <div className="stat">
          <div className="k">Last trade</div>
          <div className="v">{u?.lastPrice ?? '–'}</div>
        </div>
        <div className="stat">
          <div className="k">Round high</div>
          <div className="v" style={{ color: 'var(--high)' }}>{u?.highPrice ?? '–'}</div>
        </div>
        <div className="stat">
          <div className="k">Starting supply</div>
          <div className="v">{u?.initialSupply ?? 0}</div>
        </div>
      </div>
      <p className="small muted">
        <strong>Asks</strong> are offers to sell (lowest first). <strong>Bids</strong> are offers to buy (highest first). Buttons
        trade against that exact quote at its price.
      </p>
      <div className="book" aria-label={`${upName(type)} order book`}>
        {[...asks].reverse().map(row)}
        <div className="mid">{asks.length || bids.length ? `spread ${bestAsk && bestBid ? bestAsk - bestBid : '–'}` : 'No quotes yet. Post the first price.'}</div>
        {bids.map(row)}
      </div>
    </div>
  );
}

export function OrderForm({ s, type, a, client }: { s: Snapshot; type: UpgradeId; a: PrivateAccount; client: GameClient }) {
  // Local state: live updates never overwrite what the player is typing.
  const [side, setSide] = useState<Side>('bid');
  const [price, setPrice] = useState('');
  const [qty, setQty] = useState(1);
  const [busy, setBusy] = useState(false);
  const p = Number(price);
  const valid = Number.isInteger(p) && p >= MIN_PRICE && p <= MAX_PRICE;
  const myAsks = (s.round!.books[type] ?? []).filter((o) => o.playerId === a.playerId && o.side === 'ask').reduce((x, o) => x + o.remaining, 0);
  const q = a.positions[type] ?? 0;
  const owedIfFills = Math.max(0, myAsks + qty - q);
  const owedNow = Math.max(0, myAsks - q);
  const newShort = side === 'ask' ? owedIfFills - owedNow : 0;
  const high = s.round!.upgrades[type]?.highPrice;
  const ref = high ?? (side === 'ask' && valid ? p : CLOSEOUT_FALLBACK_PRICE);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    setBusy(true);
    const r = await client.command({ kind: 'placeLimitOrder', type, side, price: p, qty });
    setBusy(false);
    if (r.ok) setPrice('');
  };

  return (
    <form className="card stack" onSubmit={submit} aria-label="Post an order">
      <div className="spread">
        <h3 style={{ margin: 0 }}>Trade {upName(type)}</h3>
        <span className="small">
          You hold <Qty q={q} />
        </span>
      </div>
      <div className="seg side" role="group" aria-label="Buy or sell">
        <button type="button" className="b" aria-pressed={side === 'bid'} onClick={() => setSide('bid')}>
          Buy (bid)
        </button>
        <button type="button" className="s" aria-pressed={side === 'ask'} onClick={() => setSide('ask')}>
          Sell (ask)
        </button>
      </div>
      <div className="row" style={{ alignItems: 'flex-end' }}>
        <div style={{ flex: '1 1 140px' }}>
          <label htmlFor="price">{side === 'bid' ? 'Buy at most (coins each)' : 'Sell for at least (coins each)'}</label>
          <input id="price" type="number" inputMode="numeric" min={MIN_PRICE} max={MAX_PRICE} step={1} value={price} onChange={(e) => setPrice(e.target.value)} placeholder={`${MIN_PRICE}-${MAX_PRICE}`} />
        </div>
        <div>
          <label>Quantity</label>
          <div className="seg" role="group" aria-label="Quantity">
            {[1, 2].map((n) => (
              <button type="button" key={n} aria-pressed={qty === n} onClick={() => setQty(n)}>
                {n}
              </button>
            ))}
          </div>
        </div>
      </div>
      {side === 'bid' && valid && (
        <p className="small muted">
          Reserves up to {p * qty} coins while it rests. You have {a.spendable} spendable.
          {q < 0 ? ` Buying covers what you owe first.` : ''}
        </p>
      )}
      {side === 'ask' && newShort > 0 && (
        <div className="notice">
          If this fills you will owe {owedIfFills} unit{owedIfFills === 1 ? '' : 's'} of {upName(type)}
          {a.owedUnits ? '' : ''}. Unless you buy back, the estimated deduction is {owedIfFills} × {ref} = {owedIfFills * ref} coins
          {high == null ? ' (provisional: no trade yet, so the sale itself sets the reference price)' : ' at the current round high'}. The
          charge uses the round high at close, which can rise.
        </div>
      )}
      <button className={`btn big ${side === 'bid' ? 'buy' : 'sell'}`} disabled={!valid || busy || s.phase !== 'market' || s.paused}>
        {side === 'bid' ? `Buy ${qty} at most ${valid ? p : '…'}` : `Sell ${qty} for at least ${valid ? p : '…'}`}
      </button>
    </form>
  );
}

export function OpenOrders({ s, a, client }: { s: Snapshot; a: PrivateAccount; client: GameClient }) {
  const mine = Object.values(s.round!.books)
    .flat()
    .filter((o) => o.playerId === a.playerId)
    .sort((x, y) => x.seq - y.seq);
  return (
    <div className="card">
      <h3>Your open orders ({mine.length}/12)</h3>
      {mine.length === 0 ? (
        <p className="muted small">None. Orders you post that do not fill right away rest here.</p>
      ) : (
        <table>
          <tbody>
            {mine.map((o) => (
              <tr key={o.id}>
                <td>{upName(o.type)}</td>
                <td className={o.side === 'bid' ? 'pos' : 'neg'}>{o.side === 'bid' ? 'Buy' : 'Sell'}</td>
                <td className="num">
                  {o.remaining} @ {o.price}
                </td>
                <td style={{ textAlign: 'right' }}>
                  <button className="btn small ghost" onClick={() => client.command({ kind: 'cancelOrder', orderId: o.id })} disabled={s.phase !== 'market'}>
                    Cancel
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/** Mirrors the server's timeout rule: chosen (or starting) types first, then owned types in catalog order. */
export function previewEquipment(pool: UpgradeId[], a: PrivateAccount, chosen?: UpgradeId[]): UpgradeId[] {
  const base = chosen ?? (a.positions[a.startingUpgrade] > 0 ? [a.startingUpgrade] : []);
  const kept = base.filter((t) => pool.includes(t) && a.positions[t] > 0).slice(0, 2);
  for (const t of UPGRADE_IDS) {
    if (kept.length >= 2) break;
    if (pool.includes(t) && a.positions[t] > 0 && !kept.includes(t)) kept.push(t);
  }
  return kept;
}

export function Inventory({ s, a }: { s: Snapshot; a: PrivateAccount }) {
  return (
    <div className="card">
      <h3>Your upgrades</h3>
      <table>
        <tbody>
          {s.round!.pool.map((t) => (
            <tr key={t}>
              <td>
                {upName(t)}
                {t === a.startingUpgrade && <span className="badge" style={{ marginLeft: 6 }}>starting</span>}
              </td>
              <td style={{ textAlign: 'right' }}>
                <Qty q={a.positions[t]} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <h3 style={{ marginTop: 12 }}>Equipment slots</h3>
      <div className="slots">
        {[0, 1].map((i) => {
          const t = previewEquipment(s.round!.pool, a)[i];
          return (
            <div key={i} className={`slot ${t ? 'filled' : ''}`}>
              <div className="small muted">Slot {i + 1}</div>
              {t ? <strong>{upName(t)}</strong> : <span className="muted small">empty</span>}
            </div>
          );
        })}
      </div>
      <p className="small muted" style={{ marginTop: 6 }}>
        You choose your final two after the market closes. Only owned (positive) upgrades can be equipped; extra copies do nothing.
      </p>
    </div>
  );
}

export function Tape({ s, limit = 30, filter }: { s: Snapshot; limit?: number; filter?: UpgradeId | null }) {
  const trades = s.round!.tape.filter((t) => !filter || t.type === filter).slice(-limit).reverse();
  return (
    <div className="card">
      <h3>Trade tape</h3>
      {trades.length === 0 ? (
        <p className="muted small">No trades yet.</p>
      ) : (
        <div className="scroll-x">
          <table>
            <thead>
              <tr>
                <th>Time</th>
                <th>Upgrade</th>
                <th>Price</th>
                <th>Qty</th>
                <th>Buyer</th>
                <th>Seller</th>
              </tr>
            </thead>
            <tbody>
              {trades.map((t: Trade) => (
                <tr key={t.id}>
                  <td className="small muted">{new Date(t.createdAt).toLocaleTimeString([], { minute: '2-digit', second: '2-digit' })}</td>
                  <td>{upName(t.type)}</td>
                  <td>
                    <strong>{t.price}</strong> {t.raisedHigh && <span className="badge high">new high</span>}
                  </td>
                  <td>{t.qty}</td>
                  <td>{playerName(s, t.buyerId)}</td>
                  <td>{playerName(s, t.sellerId)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function Holdings({ s, myId }: { s: Snapshot; myId: string | null }) {
  const [filter, setFilter] = useState<UpgradeId | null>(null);
  const round = s.round!;
  const types = filter ? [filter] : round.pool;
  const rows = useMemo(() => {
    const ids = Object.keys(round.holdings);
    if (!filter) return ids.sort((a, b) => playerName(s, a).localeCompare(playerName(s, b)));
    return ids.sort((a, b) => (round.holdings[b][filter] ?? 0) - (round.holdings[a][filter] ?? 0));
  }, [round.holdings, filter, s]);
  const topLong: Record<string, number> = {};
  for (const t of round.pool) topLong[t] = Math.max(0, ...Object.values(round.holdings).map((h) => h[t] ?? 0));
  return (
    <div className="card stack">
      <div className="spread">
        <h3 style={{ margin: 0 }}>Holdings (public)</h3>
        <select value={filter ?? ''} onChange={(e) => setFilter((e.target.value || null) as UpgradeId | null)} style={{ width: 'auto' }} aria-label="Filter by upgrade">
          <option value="">All upgrades</option>
          {round.pool.map((t) => (
            <option key={t} value={t}>
              {CATALOG[t].name}
            </option>
          ))}
        </select>
      </div>
      <p className="small muted">Exact net quantities for every player. "owes" means they sold units they did not have.</p>
      <div className="scroll-x">
        <table>
          <thead>
            <tr>
              <th>Player</th>
              {types.map((t) => (
                <th key={t}>{upName(t)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((pid) => (
              <tr key={pid}>
                <td className={pid === myId ? 'mine' : ''}>{pid === myId ? `${playerName(s, pid)} (you)` : playerName(s, pid)}</td>
                {types.map((t) => {
                  const q = round.holdings[pid][t] ?? 0;
                  return (
                    <td key={t}>
                      <Qty q={q} /> {q > 0 && q === topLong[t] && <span className="badge top">top</span>}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="small muted">
        Owed right now:{' '}
        {round.pool
          .map((t) => `${upName(t)} ${Object.values(round.holdings).reduce((x, h) => x + Math.max(0, -(h[t] ?? 0)), 0)}`)
          .join(' · ')}
      </div>
    </div>
  );
}
