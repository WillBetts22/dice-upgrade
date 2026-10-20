import { describe, expect, it } from 'vitest';
import { CATALOG, POOL_VERSIONS, UPGRADE_IDS } from '../src/shared/catalog.js';
import { scriptedDraws } from '../src/shared/dice.js';
import { FAIRNESS_TOLERANCE, MAX_PLAYERS, MAX_ROUNDS, MIN_PLAYERS } from '../src/shared/rules.js';
import { planDeal, spreadAfter } from '../src/server/engine/deal.js';
import { acceptQuote, placeLimitOrder } from '../src/server/engine/market.js';
import { closeMarket, finalEquipment, leaderboard, resolveRound, settleShorts } from '../src/server/engine/rounds.js';
import type { RoomState } from '../src/server/engine/state.js';
import { apply, makeRound } from './helpers.js';

function shortAt12(coverAt: number | null, highTrade: number | null) {
  // Alex sells one Extra Die to Bea at 12.
  let r = makeRound({ alex: {}, bea: {}, chen: { extra_die: 1 }, dee: { extra_die: 1 }, eve: {} });
  r = apply(r, (d, c) => placeLimitOrder(d, 'bea', { type: 'extra_die', side: 'bid', price: 12, qty: 1 }, c)).round;
  r = apply(r, (d, c) => placeLimitOrder(d, 'alex', { type: 'extra_die', side: 'ask', price: 12, qty: 1 }, c)).round;
  expect(r.accounts.alex.cash).toBe(112);
  expect(r.accounts.alex.positions.extra_die).toBe(-1);
  expect(r.accounts.bea.positions.extra_die).toBe(1);
  if (highTrade !== null) {
    r = apply(r, (d, c) => placeLimitOrder(d, 'dee', { type: 'extra_die', side: 'ask', price: highTrade, qty: 1 }, c)).round;
    r = apply(r, (d, c) => placeLimitOrder(d, 'eve', { type: 'extra_die', side: 'bid', price: highTrade, qty: 1 }, c)).round;
  }
  if (coverAt !== null) {
    r = apply(r, (d, c) => placeLimitOrder(d, 'chen', { type: 'extra_die', side: 'ask', price: coverAt, qty: 1 }, c)).round;
    const id = Object.values(r.openOrders).find((o) => o.playerId === 'chen')!.id;
    r = apply(r, (d, c) => acceptQuote(d, 'alex', { orderId: id, expectedRemaining: 1, qty: 1 }, c)).round;
  }
  r = apply(r, (d, c) => {
    closeMarket(d, c);
    settleShorts(d, c);
  }).round;
  return r;
}

describe('short closeout', () => {
  it('covered short: sold 12, bought back 9, high 30 => net +3, no forced cost', () => {
    const r = shortAt12(9, 30);
    const a = r.accounts.alex;
    expect(a.cash).toBe(103);
    expect(a.positions.extra_die).toBe(0);
    expect(a.shortDeductions).toBe(0);
    expect(a.cash - 100 - a.shortDeductions).toBe(3);
    expect(r.upgrades.extra_die.highPrice).toBe(30);
  });

  it('uncovered short with high 30 => 30 deduction, net -18, score 182 with a 100 payout', () => {
    const r = shortAt12(null, 30);
    const a = r.accounts.alex;
    expect(a.cash).toBe(112); // deduction does not touch trading cash
    expect(a.shortDeductions).toBe(30);
    expect(a.positions.extra_die).toBe(0);
    expect(a.cash - 100 - a.shortDeductions).toBe(-18);
    expect(r.settlements).toEqual([
      { playerId: 'alex', type: 'extra_die', units: 1, closeoutPrice: 30, deduction: 30, bankUnits: 1, fallbackPrice: false },
    ]);
    expect(r.upgrades.extra_die.shortCloseouts).toBe(1);
    // Bank issuance means signed supply rises by the closed-out units.
    const resolved = apply(r, (d, c) => resolveRound(d, () => scriptedDraws([2, 3, 4, 5, 6, 6]), c)).round;
    // Alex owns nothing equipable, so plain dice.
    expect(resolved.dice.alex.resolution.equipment).toEqual([]);
    expect(resolved.dice.alex.resolution.payout).toBe(100);
    expect(resolved.dice.alex.score).toBe(182);
  });

  it('a later lower trade does not lower the charge, and an untraded high ask does not raise it', () => {
    let r = shortAt12(null, 30);
    expect(r.accounts.alex.shortDeductions).toBe(30);
    r = makeRound({ a: {}, b: {}, c: { extra_die: 1 } });
    r = apply(r, (d, c) => placeLimitOrder(d, 'b', { type: 'extra_die', side: 'bid', price: 9, qty: 1 }, c)).round;
    r = apply(r, (d, c) => placeLimitOrder(d, 'a', { type: 'extra_die', side: 'ask', price: 9, qty: 1 }, c)).round;
    r = apply(r, (d, c) => placeLimitOrder(d, 'c', { type: 'extra_die', side: 'ask', price: 50, qty: 1 }, c)).round;
    r = apply(r, (d, c) => {
      closeMarket(d, c);
      settleShorts(d, c);
    }).round;
    expect(r.accounts.a.shortDeductions).toBe(9);
    expect(Object.keys(r.openOrders)).toHaveLength(0);
  });

  it('cannot settle twice', () => {
    const r = shortAt12(null, 30);
    expect(apply(r, (d, c) => settleShorts(d, c)).error.code).toBe('already_settled');
  });

  it('uses the disclosed fallback of 10 when no execution exists', () => {
    let r = makeRound({ a: {} });
    r.accounts.a.positions.extra_die = -1; // defensive path only
    r = apply(r, (d, c) => settleShorts(d, c)).round;
    expect(r.settlements[0]).toMatchObject({ closeoutPrice: 10, deduction: 10, fallbackPrice: true });
  });

  it('caps deductions at 100 per player per round', () => {
    let r = makeRound({ a: {} });
    r.accounts.a.positions.extra_die = -2;
    r.accounts.a.positions.loaded_dice = -1;
    r.upgrades.extra_die.highPrice = 50;
    r.upgrades.loaded_dice.highPrice = 50;
    r = apply(r, (d, c) => settleShorts(d, c)).round;
    expect(r.accounts.a.shortDeductions).toBe(100);
  });
});

describe('equipment', () => {
  it('fallback keeps valid picks and fills from owned types in table row order', () => {
    const r = makeRound({ a: { six_hunter: 1, second_chance: 2, extra_die: 1 } });
    r.accounts.a.equipment = ['six_hunter'];
    expect(finalEquipment(r, r.accounts.a)).toEqual(['six_hunter', 'extra_die']);
    r.accounts.a.equipment = [];
    expect(finalEquipment(r, r.accounts.a)).toEqual(['extra_die', 'second_chance']);
  });

  it('never equips short, zero, inactive, or duplicate types', () => {
    const r = makeRound({ a: { extra_die: -1, second_chance: 0, jackpot: 1, loaded_dice: 1 } });
    r.accounts.a.equipment = ['extra_die', 'jackpot', 'loaded_dice', 'loaded_dice'];
    expect(finalEquipment(r, r.accounts.a)).toEqual(['loaded_dice']);
  });
});

describe('scoring and ranking', () => {
  function roomWith(scores: Record<string, (number | null)[]>): RoomState {
    const players: any = {};
    const names = Object.keys(scores);
    names.forEach((n, i) => (players[n] = { id: n, name: n, role: 'player', joinedAt: i }));
    const rounds = Math.max(...names.map((n) => scores[n].length));
    return {
      players,
      completedRounds: Array.from({ length: rounds }, (_, k) => ({
        number: k + 1,
        pool: [],
        upgrades: [],
        players: names.filter((n) => scores[n][k] !== null).map((n) => ({ playerId: n, name: n, roundScore: scores[n][k] })),
      })),
    } as any;
  }

  it('sums rounds, keeps negatives, and shares ranks on ties', () => {
    const lb = leaderboard(roomWith({ alex: [182, 205], bo: [-20, 10], cy: [300, 87], di: [400, -13] }));
    expect(lb.rows.map((r) => [r.name, r.total, r.rank])).toEqual([
      ['alex', 387, 1],
      ['cy', 387, 1],
      ['di', 387, 1],
      ['bo', -10, 4],
    ]);
  });
});

describe('fair dealing', () => {
  it('counts per type differ by at most one and cumulative values stay within tolerance', () => {
    for (const version of POOL_VERSIONS) {
      for (let n = MIN_PLAYERS; n <= MAX_PLAYERS; n++) {
        for (let trial = 0; trial < 5; trial++) {
          const acc: Record<string, number> = {};
          for (let i = 0; i < n; i++) acc[`p${i}`] = 0;
          for (let round = 1; round <= MAX_ROUNDS; round++) {
            const plan = planDeal({ poolVersion: version.id, roundNumber: round, accumulated: acc, seed: n * 1000 + trial * 10 + round });
            const counts = Object.values(plan.supply);
            expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1);
            expect(counts.reduce((a, b) => a + b, 0)).toBe(n);
            expect(new Set(plan.pool).size).toBe(4);
            expect(spreadAfter(acc, plan.assignment)).toBeLessThanOrEqual(FAIRNESS_TOLERANCE);
            for (const [p, t] of Object.entries(plan.assignment)) acc[p] += CATALOG[t].standaloneIncrement;
          }
        }
      }
    }
  });

  it('every approved pool mixes straightforward and situational effects', () => {
    for (const v of POOL_VERSIONS) {
      expect(v.pools.length).toBe(15);
      for (const pool of v.pools) {
        const kinds = new Set(pool.map((t) => CATALOG[t].kind));
        expect(kinds.size).toBe(2);
        for (const t of pool) expect(UPGRADE_IDS).toContain(t);
      }
    }
  });
});
