import { describe, expect, it } from 'vitest';
import { applyShock, BASE_RULE, cardLabel, cardValue, DECK, fairValue, settlementValue } from '../src/shared/cards.js';
import { seededRng, shuffle } from '../src/server/rng.js';

describe('cards and fair value', () => {
  it('labels and values', () => {
    expect(cardLabel(0).startsWith('A')).toBe(true);
    expect(cardValue(0, BASE_RULE)).toBe(1);
    expect(cardValue(51, BASE_RULE)).toBe(13);
    expect(cardValue(0, applyShock(BASE_RULE, 'aces_high'))).toBe(14);
    expect(cardValue(50, applyShock(BASE_RULE, 'faces_double'))).toBe(26);
    // suit 1 is hearts
    expect(cardValue(1, applyShock(BASE_RULE, 'red_zero'))).toBe(0);
    expect(cardValue(0, applyShock(BASE_RULE, 'red_zero'))).toBe(1);
  });

  it('prior fair value of 10 cards is 70', () => {
    expect(fairValue([], 10, BASE_RULE)).toBeCloseTo(70, 10);
  });

  it('fully known contract equals settlement', () => {
    const c = [0, 5, 9, 13, 20, 33, 40, 44, 47, 51];
    for (const rule of [BASE_RULE, applyShock(BASE_RULE, 'faces_double'), applyShock(applyShock(BASE_RULE, 'red_zero'), 'bonus')]) {
      expect(fairValue(c, 10, rule)).toBeCloseTo(settlementValue(c, rule), 10);
    }
  });

  it('matches exhaustive conditional expectation on random deals', () => {
    // Monte Carlo over the unknown cards agrees with the closed form.
    const rand = seededRng(7);
    const rule = applyShock(applyShock(BASE_RULE, 'faces_double'), 'aces_high');
    const known = [3, 17, 50];
    const rest = DECK.filter((c) => !known.includes(c));
    let sum = 0;
    const N = 60_000;
    for (let i = 0; i < N; i++) sum += settlementValue([...known, ...shuffle(rest, rand).slice(0, 9)], rule);
    expect(sum / N).toBeCloseTo(fairValue(known, 12, rule), 0);
  });
});
