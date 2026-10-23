import { describe, expect, it } from 'vitest';
import { analyzeRound } from '../src/shared/analysis.js';
import type { UpgradeId } from '../src/shared/catalog.js';
import { scriptedDraws } from '../src/shared/dice.js';
import { V, mu } from '../src/shared/ev-table.js';
import type { DecisionEvent, RoundReviewInput } from '../src/shared/review.js';
import type { Order } from '../src/shared/types.js';
import { acceptQuote, cancelOrder, placeLimitOrder } from '../src/server/engine/market.js';
import { closeMarket, resolveRound, settleShorts } from '../src/server/engine/rounds.js';
import type { Ctx, RoundState } from '../src/server/engine/state.js';
import { apply, makeRound } from './helpers.js';

/** Drives the real engine and records order lifetimes the way the server persists them. */
class Sim {
  now = 1_000;
  orders = new Map<string, Order & { closedAt: number | null }>();
  marketClosedAt = 0;
  constructor(public round: RoundState) {}

  step<T>(fn: (d: RoundState, c: Ctx) => T): { error?: any; result?: T } {
    this.now += 1_000;
    const res = apply(this.round, fn, this.now);
    if (!res.error) {
      this.round = res.round;
      for (const o of res.c.changes.orders.values()) {
        const prev = this.orders.get(o.id);
        this.orders.set(o.id, { ...o, closedAt: o.status === 'open' ? null : (prev?.closedAt ?? this.now) });
      }
    }
    return res;
  }

  bid(pid: string, type: UpgradeId, price: number, qty = 1) {
    return this.step((d, c) => placeLimitOrder(d, pid, { type, side: 'bid', price, qty }, c));
  }
  ask(pid: string, type: UpgradeId, price: number, qty = 1) {
    return this.step((d, c) => placeLimitOrder(d, pid, { type, side: 'ask', price, qty }, c));
  }
  take(pid: string, owner: string, side: 'bid' | 'ask') {
    const o = Object.values(this.round.openOrders).find((x) => x.playerId === owner && x.side === side)!;
    return this.step((d, c) => acceptQuote(d, pid, { orderId: o.id, expectedRemaining: o.remaining, qty: 1 }, c));
  }

  close(dice: (pid: string) => number[] = () => [2, 3, 4, 5, 6, 6, 6, 6], equipment: Record<string, UpgradeId[]> = {}) {
    this.step((d, c) => {
      closeMarket(d, c);
      settleShorts(d, c);
    });
    this.marketClosedAt = this.now;
    this.step((d, c) => {
      for (const [pid, eq] of Object.entries(equipment)) d.accounts[pid].equipment = eq;
      resolveRound(d, (pid) => scriptedDraws(dice(pid)), c);
    });
  }

  input(decisions: DecisionEvent[] = []): RoundReviewInput {
    const r = this.round;
    return {
      roundId: r.id,
      roundNumber: r.number,
      pool: r.pool,
      players: Object.values(r.accounts).map((a) => ({ id: a.playerId, name: a.playerId, startingUpgrade: a.startingUpgrade })),
      trades: r.trades,
      orders: [...this.orders.values()],
      decisions,
      settlements: r.settlements,
      finalHighs: Object.fromEntries(r.pool.map((t) => [t, r.upgrades[t].highPrice])),
      dice: r.dice,
      marketClosedAt: this.marketClosedAt,
    };
  }
}

function checkIdentity(sim: Sim) {
  const reviews = analyzeRound(sim.input());
  for (const rv of reviews) {
    const acct = sim.round.accounts[rv.playerId];
    const rec = sim.round.dice[rv.playerId];
    const owned = sim.round.pool.filter((t) => acct.positions[t] > 0);
    const start = [acct.startingUpgrade];
    const tradeSum = rv.items.filter((i) => i.tradeId).reduce((a, i) => a + i.evExPost!, 0);
    expect(rv.summary.tradingEV).toBeCloseTo(tradeSum, 9);
    expect(rv.summary.tradingEV).toBeCloseTo(acct.cash - 100 + V(owned) - V(start) - acct.shortDeductions, 6);
    expect(rv.summary.startValue + rv.summary.tradingEV - rv.summary.equipmentLoss + rv.summary.luck).toBeCloseTo(rec.score, 6);
    expect(rv.summary.score).toBe(rec.score);
    expect(rv.summary.equipmentLoss).toBeGreaterThanOrEqual(-1e-9);
  }
  return reviews;
}

const POOL_ED: UpgradeId[] = ['extra_die', 'second_chance', 'loaded_dice', 'six_hunter'];

function shortScenario(cover: boolean) {
  // Alex sells one Extra Die to Bea at 12; Dee and Eve later trade it at 30.
  const sim = new Sim(makeRound({ alex: { six_hunter: 1 }, bea: { loaded_dice: 1 }, chen: { extra_die: 1 }, dee: { extra_die: 1 }, eve: { second_chance: 1 } }, POOL_ED));
  sim.bid('bea', 'extra_die', 12);
  sim.ask('alex', 'extra_die', 12);
  sim.ask('dee', 'extra_die', 30);
  sim.bid('eve', 'extra_die', 30);
  if (cover) {
    sim.ask('chen', 'extra_die', 9);
    sim.take('alex', 'chen', 'ask');
  }
  sim.close();
  return sim;
}

describe('decision review: spec examples', () => {
  it('short at 12 covered at 9 after a high of 30 makes +3 on the pair of trades', () => {
    const sim = shortScenario(true);
    const rv = checkIdentity(sim).find((r) => r.playerId === 'alex')!;
    const trades = rv.items.filter((i) => i.tradeId);
    expect(trades.map((i) => i.kind)).toEqual(['short', 'cover']);
    expect(trades[0].evExPost).toBeCloseTo(12 - 30, 9);
    expect(trades[1].evExPost).toBeCloseTo(30 - 9, 9);
    expect(rv.summary.tradingEV).toBeCloseTo(3, 9);
    // The short is judged on the round trip once it is covered.
    expect(trades[0].verdict).toBe('good');
    expect(trades[0].detail).toMatch(/round trip made \+3\.00/);
    expect(trades[0].title).toBe('Sold short Extra Die at 12, bought back at 9: round trip +3.00');
    // Ex-ante the short could at best break even: the high including the sale itself was 12.
    expect(trades[0].evExAnte).toBeCloseTo(0, 9);
    expect(trades[1].evExAnte).toBeCloseTo(30 - 9, 9);
  });

  it('the same short left uncovered is -18 and gets flagged', () => {
    const sim = shortScenario(false);
    const rv = checkIdentity(sim).find((r) => r.playerId === 'alex')!;
    const short = rv.items.find((i) => i.kind === 'short')!;
    expect(short.evExPost).toBeCloseTo(-18, 9);
    expect(short.verdict).toBe('bad');
    expect(short.better).toBeDefined();
    expect(rv.summary.tradingEV).toBeCloseTo(-18, 9);
    expect(sim.round.accounts.alex.shortDeductions).toBe(30);
  });
});

describe('decision review: trade valuation', () => {
  it('values a complementary purchase by marginal use value', () => {
    const pool: UpgradeId[] = ['extra_die', 'second_chance', 'jackpot', 'safety_net'];
    const sim = new Sim(makeRound({ a: { second_chance: 1 }, b: { jackpot: 1 } }, pool));
    sim.ask('b', 'jackpot', 20);
    sim.take('a', 'b', 'ask');
    sim.close(() => [6, 6, 4, 4, 4]);
    const [ra, rb] = checkIdentity(sim);
    const buy = ra.items.find((i) => i.kind === 'buy')!;
    expect(buy.evExPost).toBeCloseTo(mu(['second_chance', 'jackpot']) - mu(['second_chance']) - 20, 9);
    expect(buy.detail).toMatch(/With Second Chance it adds about 26\.99/);
    expect(buy.verdict).toBe('good');
    const sell = rb.items.find((i) => i.kind === 'sell')!;
    expect(sell.evExPost).toBeCloseTo(20 - (mu(['jackpot']) - mu([])), 9);
  });

  it('flags overpaying and suggests a price', () => {
    const sim = new Sim(makeRound({ a: { extra_die: 1 }, b: { second_chance: 1 } }, POOL_ED));
    sim.ask('b', 'second_chance', 40);
    sim.take('a', 'b', 'ask');
    sim.close();
    const buy = checkIdentity(sim)[0].items.find((i) => i.kind === 'buy')!;
    expect(buy.verdict).toBe('bad');
    expect(buy.better).toMatch(/Bidding at most 17/);
  });

  it('spare copies are worth nothing, and selling them is pure gain', () => {
    const sim = new Sim(makeRound({ a: { extra_die: 1 }, b: { extra_die: 1 } }, POOL_ED));
    sim.ask('b', 'extra_die', 5);
    sim.take('a', 'b', 'ask'); // a now has 2 copies
    sim.bid('b', 'extra_die', 3);
    sim.take('a', 'b', 'bid'); // a sells the spare
    sim.close();
    const ra = checkIdentity(sim)[0];
    const [buy, sell] = ra.items.filter((i) => i.tradeId);
    expect(buy.evExPost).toBeCloseTo(-5, 9);
    expect(sell.evExPost).toBeCloseTo(3, 9);
    expect(ra.items.some((i) => i.kind === 'dead_inventory')).toBe(false);
  });
});

describe('decision review: close of market', () => {
  it('reports equipment loss and whether the timeout rule picked it', () => {
    const pool: UpgradeId[] = ['extra_die', 'second_chance', 'jackpot', 'safety_net'];
    const sim = new Sim(makeRound({ a: { extra_die: 1 }, b: { second_chance: 1 }, c: { jackpot: 1 } }, pool));
    sim.ask('b', 'second_chance', 10);
    sim.take('a', 'b', 'ask');
    sim.ask('c', 'jackpot', 10);
    sim.take('a', 'c', 'ask');
    // Starting upgrade kept, then catalog order: Extra Die + Second Chance instead of Second Chance + Jackpot.
    sim.close(() => [1, 2, 3, 4, 5, 6, 6, 6], { a: ['extra_die'] });
    const decisions: DecisionEvent[] = [
      {
        id: 'd1',
        roundId: sim.round.id,
        playerId: 'a',
        revision: 1,
        at: sim.now,
        kind: 'equip_final',
        equip: { types: ['extra_die', 'second_chance'], auto: true },
        before: { cash: 80, spendable: 80, positions: {}, highs: {} },
        tradeIds: [],
      },
    ];
    const ra = analyzeRound(sim.input(decisions))[0];
    const eq = ra.items.find((i) => i.kind === 'equip')!;
    const loss = mu(['second_chance', 'jackpot']) - mu(['extra_die', 'second_chance']);
    expect(ra.summary.equipmentLoss).toBeCloseTo(loss, 9);
    expect(eq.evExPost).toBeCloseTo(-loss, 9);
    expect(eq.verdict).toBe('bad');
    expect(eq.detail).toMatch(/timeout rule chose this/);
    expect(eq.better).toMatch(/Second Chance \+ Jackpot/);
    expect(ra.summary.bestPossiblePair).toEqual(['second_chance', 'jackpot']);
    expect(ra.items.find((i) => i.kind === 'dead_inventory')!.detail).toMatch(/1 × Jackpot/);
    checkIdentity(sim);
  });

  it('finds a cheaper ask that was available while short', () => {
    const sim = new Sim(makeRound({ a: { six_hunter: 1 }, b: { loaded_dice: 1 }, c: { extra_die: 1 }, d: { extra_die: 1 }, e: { second_chance: 1 } }, POOL_ED));
    sim.bid('b', 'extra_die', 12);
    sim.ask('a', 'extra_die', 12); // a is short 1
    sim.ask('c', 'extra_die', 15); // cheaper than the final high, left on the book
    sim.ask('d', 'extra_die', 30);
    sim.take('e', 'd', 'ask'); // direct acceptance at 30 sets the high; c's ask stays on the book
    sim.close();
    expect(sim.round.upgrades.extra_die.highPrice).toBe(30);
    const ra = checkIdentity(sim).find((r) => r.playerId === 'a')!;
    const missed = ra.items.find((i) => i.kind === 'missed_cover')!;
    expect(missed.title).toMatch(/could have saved 15\.00/);
    expect(missed.detail).toMatch(/c was offering it at 15/);
    expect(missed.verdict).toBe('info');
  });

  it('lists unfilled and cancelled orders as information', () => {
    const sim = new Sim(makeRound({ a: { extra_die: 1 }, b: {} }, POOL_ED));
    sim.bid('a', 'second_chance', 5);
    sim.bid('a', 'loaded_dice', 6);
    const id = Object.values(sim.round.openOrders).find((o) => o.price === 6)!.id;
    sim.step((d, c) => cancelOrder(d, 'a', id, c));
    sim.close();
    const kinds = analyzeRound(sim.input())[0].items.map((i) => i.kind);
    expect(kinds).toContain('unfilled');
    expect(kinds).toContain('cancel');
  });
});

describe('decision review: properties', () => {
  it('the score identity holds exactly on randomized complete rounds', () => {
    for (let seedBase = 1; seedBase <= 25; seedBase++) {
      let seed = seedBase * 7919;
      const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
      const ids = Array.from({ length: 6 }, (_, i) => `p${i}`);
      const sim = new Sim(makeRound(Object.fromEntries(ids.map((p, i) => [p, { [POOL_ED[i % 4]]: 1 }])), POOL_ED));
      for (let i = 0; i < 250; i++) {
        const pid = ids[Math.floor(rnd() * ids.length)];
        const t = POOL_ED[Math.floor(rnd() * 4)];
        const x = rnd();
        const open = Object.values(sim.round.openOrders);
        if (x < 0.15 && open.length) {
          const o = open[Math.floor(rnd() * open.length)];
          sim.step((d, c) => cancelOrder(d, pid, o.id, c));
        } else if (x < 0.35 && open.length) {
          const o = open[Math.floor(rnd() * open.length)];
          sim.step((d, c) => acceptQuote(d, pid, { orderId: o.id, expectedRemaining: o.remaining, qty: 1 }, c));
        } else {
          sim.step((d, c) => placeLimitOrder(d, pid, { type: t, side: rnd() < 0.5 ? 'bid' : 'ask', price: 1 + Math.floor(rnd() * 50), qty: 1 + Math.floor(rnd() * 2) }, c));
        }
      }
      const faces = Array.from({ length: 8 }, () => 1 + Math.floor(rnd() * 6));
      sim.close(() => faces);
      expect(sim.round.trades.length).toBeGreaterThan(5);
      checkIdentity(sim);
    }
  });

  it('is deterministic and independent of input order', () => {
    const sim = shortScenario(true);
    const a = analyzeRound(sim.input());
    const shuffled = sim.input();
    shuffled.trades = shuffled.trades.slice().reverse();
    shuffled.orders = shuffled.orders.slice().reverse();
    expect(analyzeRound(shuffled)).toEqual(a);
    expect(analyzeRound(sim.input())).toEqual(a);
  });
});

