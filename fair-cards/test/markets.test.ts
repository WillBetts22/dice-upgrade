import { describe, expect, it } from 'vitest';
import { botDecision } from '../src/server/bots.js';
import { applyCommand, knownCards, playerFv } from '../src/server/engine.js';
import { seededRng, shuffle } from '../src/server/rng.js';
import { buildSnapshot } from '../src/server/view.js';
import { BASE_RULE, DECK, productFairValue, productValue, rankOf } from '../src/shared/cards.js';
import { clueHolds, estimateFv, makeClue } from '../src/shared/clues.js';
import { DEFAULT_DURATIONS, MARKET_IDS, MARKETS, PUBLIC_SCHEDULE, ROUND_TYPE_IDS } from '../src/shared/rules.js';
import { Harness } from './helpers.js';

const M = DEFAULT_DURATIONS.marketMs;

function simulate(players: number, type: (typeof ROUND_TYPE_IDS)[number], seed: number) {
  const h = new Harness(players, { types: [type], seed, product: true, clues: 2 });
  h.open();
  const rand = seededRng(seed + 1);
  const noise: Record<string, number> = Object.fromEntries(h.r.participants.map((p) => [p, (rand() * 2 - 1) * 4]));
  while (h.room.phase === 'market') {
    for (const m of MARKET_IDS)
      for (const pid of h.r.participants) {
        const cmd = botDecision(h.room, pid, noise[pid], rand, h.now, m);
        if (!cmd) continue;
        try {
          applyCommand(h.room, { kind: 'player', playerId: pid }, cmd, h.ctx());
        } catch {
          /* rejected commands are fine */
        }
      }
    h.advance(1_000);
  }
  return h;
}

describe('product market', () => {
  it('exact product fair value matches simulation', () => {
    const rand = seededRng(7);
    const known = [0, 17, 30];
    const knownProduct = [17];
    const rest = DECK.filter((c) => !known.includes(c));
    let acc = 0;
    const N = 200_000;
    for (let i = 0; i < N; i++) acc += productValue([17, ...shuffle(rest, rand).slice(0, 2)], BASE_RULE);
    expect(productFairValue(known, knownProduct, 3, BASE_RULE)).toBeCloseTo(acc / N, 0);
  });

  for (const type of ROUND_TYPE_IDS) {
    it(`both markets settle, and pnl = edge + luck per market and in total (${type})`, () => {
      const h = simulate(8, type, 11);
      const res = h.room.results[0];
      expect(res.markets.product!.settlement).toBe(productValue(h.r.productCards, h.r.rule));
      expect(h.r.trades.filter((t) => t.market === 'product').length).toBeGreaterThan(3);
      for (const rv of h.room.reviews) {
        for (const m of MARKET_IDS) {
          const s = rv.markets[m]!.summary;
          expect(s.pnl).toBe(res.markets[m]!.pnl[rv.playerId]);
          expect(s.decisionEdge + s.infoLuck).toBeCloseTo(s.pnl, 6);
        }
        expect(rv.summary.pnl).toBe(res.pnl[rv.playerId]);
        expect(Math.abs(h.r.books.product!.positions[rv.playerId])).toBeLessThanOrEqual(MARKETS.product.positionLimit);
      }
    });
  }

  it('each market has its own quote, limits and widths', () => {
    const h = new Harness(2, { product: true });
    h.open();
    h.as('p0', { kind: 'setQuote', market: 'product', bid: 280, ask: 320, size: 3 });
    expect(() => h.as('p0', { kind: 'setQuote', market: 'product', bid: 280, ask: 321, size: 1 })).toThrow(/at most 40 wide/);
    expect(() => h.as('p0', { kind: 'setQuote', market: 'product', bid: 280, ask: 300, size: 4 })).toThrow(/Size must be 1 to 3/);
    // A live product quote does not unlock sum trading.
    expect(() => h.as('p1', { kind: 'trade', market: 'product', targetId: 'p0', side: 'buy', qty: 1, price: 320 })).toThrow(/product quote first/);
    h.as('p1', { kind: 'setQuote', market: 'product', bid: 330, ask: 360, size: 3 });
    expect(h.p.positions.p1).toBe(3);
    expect(h.p.cash.p1).toBe(-960);
    expect(h.b.positions.p1).toBe(0);
    expect(() => new Harness(2).as('p0', { kind: 'setQuote', market: 'product', bid: 1, ask: 2, size: 1 })).toThrow();
  });
});

describe('personal information', () => {
  it('clues are true, personal, and makers get none', () => {
    const h = new Harness(9, { types: ['makers'], product: true, clues: 3 });
    h.open();
    h.advance(M / 2);
    const orig = h.r.contract.slice(0, 10);
    for (const pid of h.r.participants) {
      const clues = h.r.clues[pid];
      if (h.r.roles[pid] === 'maker') expect(clues).toHaveLength(0);
      else expect(clues).toHaveLength(9);
      for (const c of clues) expect(clueHolds(c.spec, orig, h.r.productCards)).toBe(true);
      expect(new Set(clues.map((c) => c.id)).size).toBe(clues.length);
    }
    const snap = buildSnapshot(h.room, { kind: 'player', playerId: 'p0' }, h.now, () => true);
    expect(JSON.stringify(snap)).not.toContain(JSON.stringify(h.r.clues.p1[0]?.text ?? 'none at all'));
    // Only product cards the viewer has seen are marked.
    const seen = new Set(knownCards(h.r, 'p0'));
    expect(snap.round!.productKnown.every((c) => seen.has(c))).toBe(true);
  });

  it('the host sets how many private cards and clues players get', () => {
    const h = new Harness(4, { product: true });
    h.host({ kind: 'setConfig', privateStart: 3, privatePerReveal: 2, cluesPerReveal: 2 });
    h.open();
    expect(h.r.privateCards.p0).toHaveLength(3);
    expect(h.r.clues.p0).toHaveLength(2);
    h.advance(M / 4);
    expect(h.r.privateCards.p0).toHaveLength(5);
    expect(h.r.clues.p0).toHaveLength(4);
    h.advance(M / 2);
    expect(h.r.clues.p0).toHaveLength(6);
    expect(h.r.revealed).toBe(PUBLIC_SCHEDULE[3]);
    expect(() => h.room.config && new Harness(2).host({ kind: 'setConfig', cluesPerReveal: 4 })).toThrow(/0 to 3/);
    const off = new Harness(2, { product: true });
    off.host({ kind: 'setConfig', productMarket: false });
    off.open();
    expect(off.r.markets).toEqual(['sum']);
  });

  it('fair values with clues match rejection sampling', () => {
    const rand = seededRng(3);
    for (let trial = 0; trial < 3; trial++) {
      const deck = shuffle(DECK, rand);
      const contract = deck.slice(0, 10);
      const product = contract.slice(0, 3);
      const known = contract.slice(3, 5);
      const clues = [makeClue('sum', contract, product, rand, new Set(), 0)!.spec, makeClue('product', contract, product, rand, new Set(), 0)!.spec];
      const est = estimateFv({ known, contract, product, extras: 0, clues, rule: BASE_RULE, rand: seededRng(trial), steps: 60_000 });
      // Brute force: draw hidden cards and keep only hands consistent with every clue.
      const pool = DECK.filter((c) => !known.includes(c));
      let s = 0;
      let p = 0;
      let n = 0;
      for (let i = 0; i < 400_000 && n < 20_000; i++) {
        const draw = shuffle(pool, rand).slice(0, 8);
        const hand = [...draw.slice(0, 3), ...known, ...draw.slice(3)];
        const prod = draw.slice(0, 3);
        if (!clues.every((c) => clueHolds(c, hand, prod))) continue;
        s += hand.reduce((a, c) => a + rankOf(c), 0);
        p += prod.reduce((a, c) => a * rankOf(c), 1);
        n++;
      }
      expect(n).toBeGreaterThan(1000);
      expect(Math.abs(est.sum - s / n)).toBeLessThan(1.2);
      expect(Math.abs(est.product - p / n) / (p / n)).toBeLessThan(0.12);
    }
  });

  it('a player with clues has a different fair value from the cards alone', () => {
    const h = new Harness(3, { product: true, clues: 3 });
    h.open();
    const plain = new Harness(3, { product: true, clues: 0 });
    plain.open();
    expect(h.r.contract).toEqual(plain.r.contract);
    expect(playerFv(h.r, 'p0', 'sum')).not.toBeCloseTo(playerFv(plain.r, 'p0', 'sum'), 6);
  });
});
