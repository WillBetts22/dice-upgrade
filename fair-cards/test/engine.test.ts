import { describe, expect, it } from 'vitest';
import { cardValue, settlementValue } from '../src/shared/cards.js';
import { DEFAULT_DURATIONS, INSIDER_START_CARDS, POSITION_LIMIT, PUBLIC_SCHEDULE } from '../src/shared/rules.js';
import { EngineError, knownCards, playerFv, tick } from '../src/server/engine.js';
import { Harness } from './helpers.js';

const M = DEFAULT_DURATIONS.marketMs;

describe('session flow', () => {
  it('runs briefing, market stages, results, next round, finished', () => {
    const h = new Harness(4, { types: ['discovery', 'shocks'] });
    h.host({ kind: 'start' });
    expect(h.room.phase).toBe('briefing');
    h.advance(DEFAULT_DURATIONS.briefingMs);
    expect(h.room.phase).toBe('market');
    expect(h.r.revealed).toBe(0);
    for (const p of h.r.participants) expect(h.r.privateCards[p]).toHaveLength(1);
    h.advance(M * 0.25);
    expect(h.r.revealed).toBe(PUBLIC_SCHEDULE[1]);
    for (const p of h.r.participants) expect(h.r.privateCards[p]).toHaveLength(2);
    h.advance(M * 0.25);
    expect(h.r.revealed).toBe(PUBLIC_SCHEDULE[2]);
    h.advance(M * 0.25);
    expect(h.r.revealed).toBe(PUBLIC_SCHEDULE[3]);
    h.advance(M * 0.25);
    expect(h.room.phase).toBe('results');
    expect(h.r.settlement).toBe(settlementValue(h.r.contract, h.r.rule));
    h.advance(DEFAULT_DURATIONS.resultsMs);
    expect(h.room.phase).toBe('briefing');
    expect(h.room.roundNumber).toBe(2);
    h.host({ kind: 'advance' });
    h.advance(M);
    expect(h.r.shocks).toHaveLength(2);
    h.advance(DEFAULT_DURATIONS.resultsMs);
    expect(h.room.phase).toBe('finished');
    expect(h.room.results).toHaveLength(2);
  });

  it('private cards are contract cards and spread across the room', () => {
    const h = new Harness(20);
    h.open();
    const counts = new Map<number, number>();
    for (const p of h.r.participants) {
      const cards = h.r.privateCards[p];
      expect(new Set(cards).size).toBe(cards.length);
      for (const c of cards) {
        expect(h.r.contract).toContain(c);
        counts.set(c, (counts.get(c) ?? 0) + 1);
      }
    }
    // Opening deal: 20 players over 10 cards, each card seen by exactly two.
    expect([...counts.values()]).toEqual(new Array(10).fill(2));
    h.advance(M * 0.5);
    for (const p of h.r.participants) {
      const cards = h.r.privateCards[p];
      expect(new Set(cards).size).toBe(cards.length);
      for (const c of cards) expect(h.r.contract).toContain(c);
    }
  });

  it('makers get no cards, takers do; insider gets 5', () => {
    const h = new Harness(9, { types: ['makers', 'insider'] });
    h.open();
    const makers = h.r.participants.filter((p) => h.r.roles[p] === 'maker');
    expect(makers).toHaveLength(3);
    for (const p of makers) expect(h.r.privateCards[p]).toHaveLength(0);
    for (const p of h.r.participants.filter((x) => h.r.roles[x] === 'taker')) expect(h.r.privateCards[p]).toHaveLength(1);
    h.advance(M);
    h.host({ kind: 'advance' });
    h.host({ kind: 'advance' });
    expect(h.r.privateCards[h.r.insiderId!]).toHaveLength(INSIDER_START_CARDS);
  });

  it('pause freezes time and shifts the schedule', () => {
    const h = new Harness(2);
    h.open();
    h.advance(10_000);
    h.host({ kind: 'pause' });
    h.advance(M);
    expect(h.room.phase).toBe('market');
    expect(h.r.revealed).toBe(0);
    h.host({ kind: 'resume' });
    h.advance(M * 0.25 - 10_000);
    expect(h.r.revealed).toBe(PUBLIC_SCHEDULE[1]);
    h.advance(M * 0.75);
    expect(h.room.phase).toBe('results');
  });

  it('skip in test mode jumps to the next information drop', () => {
    const h = new Harness(2);
    h.open();
    h.host({ kind: 'skip' });
    expect(h.r.revealed).toBe(PUBLIC_SCHEDULE[1]);
    h.host({ kind: 'skip' });
    h.host({ kind: 'skip' });
    h.host({ kind: 'skip' });
    expect(h.room.phase).toBe('results');
  });
});

describe('quotes and trades', () => {
  const err = (fn: () => unknown) => {
    try {
      fn();
    } catch (e) {
      return (e as EngineError).code;
    }
    return null;
  };

  it('validates width, crossing and the live-quote requirement', () => {
    const h = new Harness(3);
    h.open();
    expect(err(() => h.as('p0', { kind: 'setQuote', bid: 70, ask: 75, size: 1 }))).toBe('too_wide');
    expect(err(() => h.as('p0', { kind: 'setQuote', bid: 72, ask: 72, size: 1 }))).toBe('bad_quote');
    h.as('p0', { kind: 'setQuote', bid: 68, ask: 72, size: 2 });
    expect(err(() => h.as('p1', { kind: 'setQuote', bid: 72, ask: 74, size: 1 }))).toBe('crosses');
    expect(err(() => h.as('p1', { kind: 'setQuote', bid: 64, ask: 68, size: 1 }))).toBe('crosses');
    expect(err(() => h.as('p1', { kind: 'trade', targetId: 'p0', side: 'buy', qty: 1, price: 72 }))).toBe('no_quote');
    h.as('p1', { kind: 'setQuote', bid: 67, ask: 71, size: 1 });
    expect(err(() => h.as('p1', { kind: 'trade', targetId: 'p0', side: 'buy', qty: 1, price: 71 }))).toBe('quote_changed');
    h.as('p1', { kind: 'trade', targetId: 'p0', side: 'buy', qty: 2, price: 72 });
    expect(h.r.positions.p1).toBe(2);
    expect(h.r.positions.p0).toBe(-2);
    expect(h.r.cash.p1).toBe(-144);
    expect(h.r.quotes.p0.askSize).toBe(0);
    expect(err(() => h.as('p0', { kind: 'trade', targetId: 'p1', side: 'sell', qty: 1, price: 67 }))).toBe('no_quote');
  });

  it('enforces position limits on both sides', () => {
    const h = new Harness(3);
    h.open();
    h.r.positions.p1 = POSITION_LIMIT - 1;
    h.as('p0', { kind: 'setQuote', bid: 60, ask: 64, size: 5 });
    h.as('p1', { kind: 'setQuote', bid: 61, ask: 63, size: 1 });
    expect(err(() => h.as('p1', { kind: 'trade', targetId: 'p0', side: 'buy', qty: 2, price: 64 }))).toBe('limit');
    h.r.positions.p2 = -POSITION_LIMIT;
    h.as('p2', { kind: 'setQuote', bid: 62, ask: 63, size: 3 });
    // p2 is already short the limit, so nobody can buy from p2's ask.
    expect(err(() => h.as('p0', { kind: 'trade', targetId: 'p2', side: 'buy', qty: 1, price: 63 }))).toBe('limit_target');
  });

  it('takers trade only against makers and makers earn rebates', () => {
    const h = new Harness(6, { types: ['makers'] });
    h.open();
    const maker = h.r.participants.find((p) => h.r.roles[p] === 'maker')!;
    const taker = h.r.participants.find((p) => h.r.roles[p] === 'taker')!;
    expect(err(() => h.as(taker, { kind: 'setQuote', bid: 60, ask: 62, size: 1 }))).toBe('taker');
    expect(err(() => h.as(maker, { kind: 'setQuote', bid: 60, ask: 63, size: 1 }))).toBe('too_wide');
    h.as(maker, { kind: 'setQuote', bid: 69, ask: 71, size: 3 });
    h.as(taker, { kind: 'trade', targetId: maker, side: 'sell', qty: 3, price: 69 });
    expect(h.r.rebates[maker]).toBe(3);
    expect(h.r.cash[maker]).toBe(-69 * 3 + 3);
  });

  it('pnl sums to the rebates paid (zero-sum otherwise)', () => {
    const h = new Harness(6, { types: ['makers'] });
    h.open();
    const makers = h.r.participants.filter((p) => h.r.roles[p] === 'maker');
    const takers = h.r.participants.filter((p) => h.r.roles[p] === 'taker');
    h.as(makers[0], { kind: 'setQuote', bid: 66, ask: 68, size: 5 });
    h.as(makers[1], { kind: 'setQuote', bid: 65, ask: 67, size: 5 });
    h.as(takers[0], { kind: 'trade', targetId: makers[0], side: 'sell', qty: 2, price: 66 });
    h.as(takers[1], { kind: 'trade', targetId: makers[1], side: 'buy', qty: 4, price: 67 });
    h.advance(M);
    const res = h.room.results[0];
    const total = Object.values(res.pnl).reduce((a, b) => a + b, 0);
    expect(total).toBe(6);
  });

  it('fair value only uses cards the player knows', () => {
    const h = new Harness(2);
    h.open();
    const k = knownCards(h.r, 'p0');
    expect(k).toEqual(h.r.privateCards.p0);
    const c = k[0];
    expect(playerFv(h.r, 'p0')).toBeCloseTo(cardValue(c, h.r.rule) + (9 * (364 - cardValue(c, h.r.rule))) / 51, 10);
  });

  it('tracks quoting uptime', () => {
    const h = new Harness(2);
    h.open();
    h.as('p0', { kind: 'setQuote', bid: 68, ask: 72, size: 1 });
    h.advance(60_000);
    h.as('p0', { kind: 'pullQuote' });
    h.advance(M);
    expect(h.r.uptime.p0.ms).toBe(60_000);
    expect(h.room.reviews.find((x) => x.playerId === 'p0')!.summary.uptime).toBeCloseTo(60_000 / M, 6);
  });

  it('tick is a no-op when nothing is due', () => {
    const h = new Harness(2);
    h.open();
    expect(tick(h.room, h.ctx())).toBe(false);
  });
});

describe('quote cooldown and hidden fair value', () => {
  it('limits how often a player can post a quote, but pulling is always allowed', async () => {
    const { buildSnapshot } = await import('../src/server/view.js');
    const h = new Harness(2, { cooldownMs: 15_000 });
    h.open();
    h.as('p0', { kind: 'setQuote', bid: 68, ask: 72, size: 1 });
    expect(() => h.as('p0', { kind: 'setQuote', bid: 67, ask: 71, size: 1 })).toThrow(/Next update in 15 s/);
    h.as('p0', { kind: 'pullQuote' });
    h.now += 10_000;
    expect(() => h.as('p0', { kind: 'setQuote', bid: 67, ask: 71, size: 1 })).toThrow(/Next update in 5 s/);
    h.now += 5_000;
    h.as('p0', { kind: 'setQuote', bid: 67, ask: 71, size: 1 });
    const snap = buildSnapshot(h.room, { kind: 'player', playerId: 'p0' }, h.now, () => true);
    expect(snap.me!.nextQuoteAt).toBe(h.now + 15_000);
    // No fair values leave the server while the market is open.
    expect(snap.me!.fv).toBeNull();
    expect(snap.round!.publicFv).toBeNull();
    expect(snap.round!.publicFvSeries).toBeNull();
    expect(buildSnapshot(h.room, { kind: 'spectator' }, h.now, () => true).round!.publicFv).toBeNull();
    h.advance(DEFAULT_DURATIONS.marketMs);
    const done = buildSnapshot(h.room, { kind: 'player', playerId: 'p0' }, h.now, () => true);
    expect(done.me!.fv).not.toBeNull();
    expect(done.round!.publicFv).not.toBeNull();
  });

  it('rejects an out-of-range cooldown setting', () => {
    const h = new Harness(2);
    expect(() => h.host({ kind: 'setConfig', quoteCooldownMs: 120_000 })).toThrow(/0 to 60 seconds/);
    h.host({ kind: 'setConfig', quoteCooldownMs: 5_000 });
    expect(h.room.config.quoteCooldownMs).toBe(5_000);
  });
});
