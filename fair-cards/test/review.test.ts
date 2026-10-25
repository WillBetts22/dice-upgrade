import { describe, expect, it } from 'vitest';
import { botDecision } from '../src/server/bots.js';
import { applyCommand, playerFv } from '../src/server/engine.js';
import { seededRng } from '../src/server/rng.js';
import { DEFAULT_DURATIONS, ROUND_TYPE_IDS } from '../src/shared/rules.js';
import { Harness } from './helpers.js';

const M = DEFAULT_DURATIONS.marketMs;

/** Drive a full round with bots on the pure engine. */
function simulate(players: number, type: (typeof ROUND_TYPE_IDS)[number], seed: number) {
  const h = new Harness(players, { types: [type], seed });
  h.open();
  const rand = seededRng(seed + 1);
  const noise: Record<string, number> = Object.fromEntries(h.r.participants.map((p) => [p, (rand() * 2 - 1) * 4]));
  while (h.room.phase === 'market') {
    for (const pid of h.r.participants) {
      const cmd = botDecision(h.room, pid, noise[pid], rand, h.now);
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

describe('decision review', () => {
  for (const type of ROUND_TYPE_IDS) {
    it(`pnl = decision edge + information luck exactly (${type})`, () => {
      for (const seed of [1, 2, 3]) {
        const h = simulate(8, type, seed);
        expect(h.r.trades.length).toBeGreaterThan(5);
        const res = h.room.results[0];
        expect(h.room.reviews).toHaveLength(8);
        for (const rv of h.room.reviews) {
          const s = rv.summary;
          expect(s.pnl).toBe(res.pnl[rv.playerId]);
          expect(s.decisionEdge + s.infoLuck).toBeCloseTo(s.pnl, 9);
          expect(s.aggressiveEdge + s.passiveEdge).toBeCloseTo(s.decisionEdge, 9);
          // Each fill row's final value adds up to the round result.
          const fills = rv.items.filter((i) => ['buy', 'sell', 'fill_buy', 'fill_sell'].includes(i.kind));
          expect(fills.reduce((a, i) => a + i.evFinal!, 0)).toBeCloseTo(s.pnl, 9);
        }
        const total = Object.values(res.pnl).reduce((a, b) => a + b, 0);
        const rebates = Object.values(h.r.rebates).reduce((a, b) => a + b, 0);
        expect(total).toBe(rebates);
      }
    });
  }

  it('flags a quote that leaves out your own fair value', () => {
    const h = new Harness(2);
    h.open();
    const fv = playerFv(h.r, 'p0');
    const bid = Math.round(fv) + 5;
    h.as('p0', { kind: 'setQuote', bid, ask: bid + 2, size: 1 });
    h.advance(M);
    const items = h.room.reviews.find((r) => r.playerId === 'p0')!.items;
    const q = items.find((i) => i.kind === 'quote' && i.verdict === 'bad');
    expect(q).toBeTruthy();
    expect(q!.better).toMatch(/Quote around/);
  });

  it('flags a stale quote and a pick-off after an information drop', () => {
    // Search seeds for a reveal that moves p0's fair value outside a tight quote.
    for (let seed = 1; seed < 200; seed++) {
      const h = new Harness(2, { seed });
      h.open();
      const fv0 = playerFv(h.r, 'p0');
      const bid = Math.floor(fv0) - 1;
      h.as('p0', { kind: 'setQuote', bid, ask: bid + 2, size: 3 });
      h.as('p1', { kind: 'setQuote', bid: bid - 1, ask: bid + 3, size: 1 });
      h.advance(M * 0.25);
      const fv1 = playerFv(h.r, 'p0');
      if (fv1 > bid + 2.5 + 3) {
        // Fair value jumped well above p0's ask; p1 lifts it 20 s later.
        h.advance(20_000);
        h.as('p1', { kind: 'trade', targetId: 'p0', side: 'buy', qty: 1, price: bid + 2 });
        h.advance(M);
        const items = h.room.reviews.find((r) => r.playerId === 'p0')!.items;
        expect(items.some((i) => i.kind === 'stale' && i.verdict === 'bad')).toBe(true);
        const fill = items.find((i) => i.kind === 'fill_sell')!;
        expect(fill.verdict).toBe('bad');
        expect(fill.detail).toMatch(/stale quote/);
        return;
      }
    }
    throw new Error('no seed produced a big enough jump');
  });

  it('reports a missed edge after an information drop', () => {
    for (let seed = 1; seed < 200; seed++) {
      const h = new Harness(2, { seed });
      h.open();
      h.as('p1', { kind: 'setQuote', bid: 60, ask: 62, size: 1 });
      h.as('p0', { kind: 'setQuote', bid: 58, ask: 61, size: 1 });
      h.advance(M * 0.25);
      if (playerFv(h.r, 'p0') - 62 >= 4) {
        h.advance(M);
        const items = h.room.reviews.find((r) => r.playerId === 'p0')!.items;
        const m = items.find((i) => i.kind === 'missed');
        expect(m).toBeTruthy();
        expect(m!.evThen!).toBeGreaterThanOrEqual(3);
        return;
      }
    }
    throw new Error('no seed produced a missed edge');
  });
});
