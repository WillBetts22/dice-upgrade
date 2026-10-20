import { describe, expect, it } from 'vitest';
import {
  acceptQuote,
  assertAccountInvariants,
  cancelOrder,
  placeLimitOrder,
  privateAccount,
  reservedForBids,
  worstCaseShortUnits,
} from '../src/server/engine/market.js';
import type { RoundState } from '../src/server/engine/state.js';
import { POOL, apply, makeRound, totalCash, totalSupply } from './helpers.js';

const bid = (type: string, price: number, qty = 1) => ({ type, side: 'bid', price, qty });
const ask = (type: string, price: number, qty = 1) => ({ type, side: 'ask', price, qty });

function place(round: RoundState, pid: string, o: any) {
  return apply(round, (d, c) => placeLimitOrder(d, pid, o, c));
}

function checkAll(round: RoundState) {
  for (const pid of Object.keys(round.accounts)) assertAccountInvariants(round, pid);
}

describe('matching', () => {
  it('executes at the resting price: bid 20 vs resting ask 15 trades at 15', () => {
    let r = makeRound({ a: { extra_die: 1 }, b: {} });
    r = place(r, 'a', ask('extra_die', 15)).round;
    const res = place(r, 'b', bid('extra_die', 20));
    expect(res.result!.trades).toHaveLength(1);
    expect(res.result!.trades[0].price).toBe(15);
    expect(res.round.accounts.b.cash).toBe(85);
    expect(res.round.accounts.a.cash).toBe(115);
  });

  it('new ask at 12 vs resting bid 18 trades at 18', () => {
    let r = makeRound({ a: {}, b: { extra_die: 1 } });
    r = place(r, 'a', bid('extra_die', 18)).round;
    const res = place(r, 'b', ask('extra_die', 12));
    expect(res.result!.trades[0].price).toBe(18);
  });

  it('uses price priority then time priority', () => {
    let r = makeRound({ a: { extra_die: 1 }, b: { extra_die: 1 }, c: { extra_die: 1 }, d: {} });
    r = place(r, 'a', ask('extra_die', 14)).round;
    r = place(r, 'b', ask('extra_die', 12)).round;
    r = place(r, 'c', ask('extra_die', 12)).round;
    const res = place(r, 'd', bid('extra_die', 20, 2));
    const t = res.result!.trades;
    expect(t.map((x) => [x.sellerId, x.price])).toEqual([
      ['b', 12],
      ['c', 12],
    ]);
    expect(Object.values(res.round.openOrders).map((o) => o.playerId)).toEqual(['a']);
  });

  it('supports partial fills and leaves the remainder resting', () => {
    let r = makeRound({ a: { extra_die: 1 }, b: {} });
    r = place(r, 'a', ask('extra_die', 10)).round;
    const res = place(r, 'b', bid('extra_die', 11, 2));
    expect(res.result!.trades).toHaveLength(1);
    const rest = Object.values(res.round.openOrders);
    expect(rest).toHaveLength(1);
    expect(rest[0]).toMatchObject({ playerId: 'b', side: 'bid', price: 11, remaining: 1 });
    expect(reservedForBids(res.round, 'b')).toBe(11);
    expect(privateAccount(res.round, 'b')!.spendable).toBe(100 - 10 - 11);
  });

  it('partially fills a resting order', () => {
    let r = makeRound({ a: { extra_die: 2 }, b: {} });
    r = place(r, 'a', ask('extra_die', 10, 2)).round;
    const res = place(r, 'b', bid('extra_die', 10, 1));
    expect(Object.values(res.round.openOrders)[0].remaining).toBe(1);
  });
});

describe('validation', () => {
  it('rejects invalid inputs', () => {
    const r = makeRound({ a: {} });
    for (const o of [
      bid('extra_die', 0),
      bid('extra_die', 51),
      bid('extra_die', 10.5),
      bid('extra_die', 10, 3),
      bid('extra_die', 10, 0),
      bid('jackpot', 10), // inactive type
      { type: 'extra_die', side: 'buy', price: 10, qty: 1 },
      bid('extra_die', '10' as any),
    ]) {
      const res = place(r, 'a', o);
      expect(res.error, JSON.stringify(o)).toBeDefined();
      expect(res.round).toBe(r);
    }
  });

  it('rejects non-traders', () => {
    const r = makeRound({ a: {} });
    expect(place(r, 'ghost', bid('extra_die', 10)).error.code).toBe('not_trader');
  });

  it('enforces bid cash commitments', () => {
    let r = makeRound({ a: {} });
    r = place(r, 'a', bid('extra_die', 50, 2)).round; // reserves 100
    expect(privateAccount(r, 'a')!.spendable).toBe(0);
    expect(place(r, 'a', bid('second_chance', 1)).error.code).toBe('insufficient_cash');
    const cancelled = apply(r, (d, c) => cancelOrder(d, 'a', Object.keys(d.openOrders)[0], c)).round;
    expect(privateAccount(cancelled, 'a')!.spendable).toBe(100);
  });

  it('caps open orders at 12', () => {
    let r = makeRound({ a: {} });
    for (let i = 0; i < 12; i++) r = place(r, 'a', bid(POOL[i % 4], 1)).round;
    expect(Object.keys(r.openOrders)).toHaveLength(12);
    expect(place(r, 'a', bid('extra_die', 1)).error.code).toBe('order_limit');
  });

  it('blocks self trades before mutation and gives an instruction', () => {
    let r = makeRound({ a: { extra_die: 1 }, b: {} });
    r = place(r, 'a', ask('extra_die', 15)).round;
    const res = place(r, 'a', bid('extra_die', 16));
    expect(res.error.code).toBe('self_cross');
    expect(res.error.message).toMatch(/Cancel that quote first/);
    expect(res.round.trades).toHaveLength(0);
    expect(res.round.upgrades.extra_die.highPrice).toBeNull();
  });

  it('blocks self-cross even when a better external quote exists', () => {
    let r = makeRound({ a: { extra_die: 1 }, b: { extra_die: 1 }, c: {} });
    r = place(r, 'b', ask('extra_die', 10)).round;
    r = place(r, 'a', ask('extra_die', 15)).round;
    expect(place(r, 'a', bid('extra_die', 16)).error.code).toBe('self_cross');
  });

  it('only the owner can cancel', () => {
    let r = makeRound({ a: {}, b: {} });
    r = place(r, 'a', bid('extra_die', 5)).round;
    const id = Object.keys(r.openOrders)[0];
    expect(apply(r, (d, c) => cancelOrder(d, 'b', id, c)).error.code).toBe('forbidden');
  });
});

describe('shorts and exposure', () => {
  it('overlapping asks use the short allowance (spec section 5 example)', () => {
    let r = makeRound({ a: {}, b: {}, c: { extra_die: 1 } });
    r = place(r, 'a', ask('extra_die', 12)).round;
    r = place(r, 'a', ask('second_chance', 20)).round;
    expect(privateAccount(r, 'a')!.spendable).toBe(100);
    expect(worstCaseShortUnits(r, 'a')).toBe(2);
    expect(place(r, 'a', ask('loaded_dice', 30)).error.code).toBe('short_limit');

    r = place(r, 'b', bid('extra_die', 12)).round; // fills a's ask at 12
    expect(r.accounts.a.cash).toBe(112);
    expect(r.accounts.a.positions.extra_die).toBe(-1);
    expect(worstCaseShortUnits(r, 'a')).toBe(2);

    const other = Object.values(r.openOrders).find((o) => o.playerId === 'a')!;
    r = apply(r, (d, c) => cancelOrder(d, 'a', other.id, c)).round;
    expect(worstCaseShortUnits(r, 'a')).toBe(1);

    r = place(r, 'c', ask('extra_die', 9)).round;
    r = place(r, 'a', bid('extra_die', 9)).round;
    expect(r.accounts.a.cash).toBe(103);
    expect(r.accounts.a.positions.extra_die).toBe(0);
  });

  it('two asks against one owned unit count as one potential short', () => {
    let r = makeRound({ a: { extra_die: 1 } });
    r = place(r, 'a', ask('extra_die', 20)).round;
    r = place(r, 'a', ask('extra_die', 21)).round;
    expect(worstCaseShortUnits(r, 'a')).toBe(1);
    r = place(r, 'a', ask('extra_die', 22)).round;
    expect(worstCaseShortUnits(r, 'a')).toBe(2);
    expect(place(r, 'a', ask('extra_die', 23)).error.code).toBe('short_limit');
  });

  it('cap holds under an adversarial sequence of fills and reposts', () => {
    let r = makeRound({ a: {}, b: {}, c: {} });
    const seq: [string, any][] = [
      ['a', ask('extra_die', 5, 2)],
      ['b', bid('extra_die', 5, 1)],
      ['a', ask('second_chance', 5, 1)],
      ['a', ask('loaded_dice', 5, 1)],
      ['c', bid('extra_die', 5, 1)],
      ['a', ask('extra_die', 5, 1)],
      ['a', ask('six_hunter', 50, 2)],
    ];
    for (const [pid, o] of seq) {
      r = place(r, pid, o).round;
      checkAll(r);
      expect(worstCaseShortUnits(r, 'a')).toBeLessThanOrEqual(2);
    }
  });

  it('covering a short requires spendable cash at the trade price', () => {
    let r = makeRound({ a: {}, b: {}, c: { extra_die: 1 } });
    r = place(r, 'a', ask('extra_die', 12)).round;
    r = place(r, 'b', bid('extra_die', 12)).round;
    r = place(r, 'a', bid('second_chance', 50, 2)).round; // spendable 12
    r = place(r, 'c', ask('extra_die', 13)).round;
    const res = apply(r, (d, c) => acceptQuote(d, 'a', { orderId: Object.values(d.openOrders).find((o) => o.playerId === 'c')!.id, expectedRemaining: 1, qty: 1 }, c));
    expect(res.error.code).toBe('insufficient_cash');
    expect(res.round.accounts.a.positions.extra_die).toBe(-1);
  });
});

describe('quote acceptance', () => {
  it('rejects stale quotes by id and expected remaining', () => {
    let r = makeRound({ a: { extra_die: 2 }, b: {} });
    r = place(r, 'a', ask('extra_die', 10, 2)).round;
    const id = Object.keys(r.openOrders)[0];
    expect(apply(r, (d, c) => acceptQuote(d, 'b', { orderId: id, expectedRemaining: 1, qty: 1 }, c)).error.code).toBe('stale_quote');
    expect(apply(r, (d, c) => acceptQuote(d, 'b', { orderId: 'nope', expectedRemaining: 1, qty: 1 }, c)).error.code).toBe('stale_quote');
    const ok = apply(r, (d, c) => acceptQuote(d, 'b', { orderId: id, expectedRemaining: 2, qty: 1 }, c));
    expect(ok.error).toBeUndefined();
    expect(ok.round.openOrders[id].remaining).toBe(1);
  });

  it('may choose a worse-priced quote intentionally and still sets the high', () => {
    let r = makeRound({ a: { extra_die: 1 }, b: { extra_die: 1 }, c: {} });
    r = place(r, 'a', ask('extra_die', 10)).round;
    r = place(r, 'b', ask('extra_die', 30)).round;
    const id = Object.values(r.openOrders).find((o) => o.playerId === 'b')!.id;
    const res = apply(r, (d, c) => acceptQuote(d, 'c', { orderId: id, expectedRemaining: 1, qty: 1 }, c));
    expect(res.result!.price).toBe(30);
    expect(res.round.upgrades.extra_die.highPrice).toBe(30);
    expect(res.result!.incomingOrderId).toBeNull();
  });

  it('rejects accepting your own quote', () => {
    let r = makeRound({ a: { extra_die: 1 } });
    r = place(r, 'a', ask('extra_die', 10)).round;
    const id = Object.keys(r.openOrders)[0];
    expect(apply(r, (d, c) => acceptQuote(d, 'a', { orderId: id, expectedRemaining: 1, qty: 1 }, c)).error.code).toBe('self_trade');
  });

  it('accepting a bid can create a short within the cap', () => {
    let r = makeRound({ a: {}, b: {} });
    r = place(r, 'b', bid('extra_die', 20, 2)).round;
    const id = Object.keys(r.openOrders)[0];
    r = apply(r, (d, c) => acceptQuote(d, 'a', { orderId: id, expectedRemaining: 2, qty: 2 }, c)).round;
    expect(r.accounts.a.positions.extra_die).toBe(-2);
    r = place(r, 'b', bid('second_chance', 5)).round;
    const id2 = Object.values(r.openOrders)[0].id;
    expect(apply(r, (d, c) => acceptQuote(d, 'a', { orderId: id2, expectedRemaining: 1, qty: 1 }, c)).error.code).toBe('short_limit');
  });
});

describe('round high and conservation', () => {
  it('high only rises on real fills and ignores quotes and cancels', () => {
    let r = makeRound({ a: { extra_die: 1 }, b: { extra_die: 1 }, c: {} });
    r = place(r, 'a', ask('extra_die', 50)).round;
    expect(r.upgrades.extra_die.highPrice).toBeNull();
    r = apply(r, (d, c) => cancelOrder(d, 'a', Object.keys(d.openOrders)[0], c)).round;
    expect(r.upgrades.extra_die.highPrice).toBeNull();
    r = place(r, 'a', ask('extra_die', 20)).round;
    r = place(r, 'c', bid('extra_die', 20)).round;
    expect(r.upgrades.extra_die.highPrice).toBe(20);
    expect(r.trades.at(-1)!.raisedHigh).toBe(true);
    r = place(r, 'b', ask('extra_die', 8)).round;
    r = place(r, 'c', bid('extra_die', 8)).round;
    expect(r.upgrades.extra_die.highPrice).toBe(20);
    expect(r.upgrades.extra_die.lastPrice).toBe(8);
    expect(r.trades.at(-1)!.raisedHigh).toBe(false);
  });

  it('random sequences conserve cash and signed supply and keep invariants', () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    const players = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`p${i}`, { [POOL[i % 4]]: 1 }]));
    let r = makeRound(players);
    const cash0 = totalCash(r);
    const supply0 = POOL.map((t) => totalSupply(r, t));
    let accepted = 0;
    for (let i = 0; i < 2000; i++) {
      const pid = `p${Math.floor(rnd() * 8)}`;
      const t = POOL[Math.floor(rnd() * 4)];
      const x = rnd();
      let res;
      if (x < 0.15 && Object.keys(r.openOrders).length) {
        const o = Object.values(r.openOrders)[Math.floor(rnd() * Object.keys(r.openOrders).length)];
        res = apply(r, (d, c) => cancelOrder(d, pid, o.id, c));
      } else if (x < 0.3 && Object.keys(r.openOrders).length) {
        const o = Object.values(r.openOrders)[Math.floor(rnd() * Object.keys(r.openOrders).length)];
        res = apply(r, (d, c) => acceptQuote(d, pid, { orderId: o.id, expectedRemaining: o.remaining, qty: 1 }, c));
      } else {
        res = place(r, pid, { type: t, side: rnd() < 0.5 ? 'bid' : 'ask', price: 1 + Math.floor(rnd() * 50), qty: 1 + Math.floor(rnd() * 2) });
      }
      if (!res.error) accepted++;
      r = res.round;
      checkAll(r);
      expect(totalCash(r)).toBe(cash0);
      POOL.forEach((t, k) => expect(totalSupply(r, t)).toBe(supply0[k]));
      for (const tr of r.trades) expect(tr.buyerId).not.toBe(tr.sellerId);
    }
    expect(accepted).toBeGreaterThan(300);
    expect(r.trades.length).toBeGreaterThan(50);
  });
});
