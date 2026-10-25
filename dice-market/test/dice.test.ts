import { describe, expect, it } from 'vitest';
import { resolveDice, scriptedDraws } from '../src/shared/dice.js';

describe('dice fixtures from the spec', () => {
  it('no upgrades: 2,3,4,5,6 pays 100', () => {
    expect(resolveDice([], scriptedDraws([2, 3, 4, 5, 6])).payout).toBe(100);
  });

  it('Loaded Dice + Six Hunter: 1,1,2,6,6 is 120 base + 40 bonus = 160', () => {
    const r = resolveDice(['loaded_dice', 'six_hunter'], scriptedDraws([1, 1, 2, 6, 6]));
    expect(r.basePayout).toBe(120);
    expect(r.sixBonus).toBe(40);
    expect(r.payout).toBe(160);
  });

  it('Safety Net + Jackpot: 1,1,1,6,6 is 75 raised to 100 plus 85 = 185', () => {
    const r = resolveDice(['safety_net', 'jackpot'], scriptedDraws([1, 1, 1, 6, 6]));
    expect(r.basePayout).toBe(75);
    expect(r.floorAdjustment).toBe(25);
    expect(r.jackpotBonus).toBe(85);
    expect(r.payout).toBe(185);
  });

  it('Extra Die + Second Chance: 1..6 with replacements 6,6 pays 150', () => {
    const r = resolveDice(['extra_die', 'second_chance'], scriptedDraws([1, 2, 3, 4, 5, 6, 6, 6]));
    expect(r.originalDice).toEqual([1, 2, 3, 4, 5, 6]);
    expect(r.rerollIndices).toEqual([0, 1]);
    expect(r.finalDice).toEqual([6, 6, 3, 4, 5, 6]);
    expect(r.payout).toBe(150);
  });

  it('exact ties use the lower original index', () => {
    const r = resolveDice(['second_chance'], scriptedDraws([3, 3, 3, 5, 5, 4, 4]));
    expect(r.rerollIndices).toEqual([0, 1]);
    expect(r.finalDice).toEqual([4, 4, 3, 5, 5]);
  });

  it('Loaded Dice + Second Chance: 1,2,3,4,6 targets the raw 2 and 3, not the raw 1', () => {
    const r = resolveDice(['loaded_dice', 'second_chance'], scriptedDraws([1, 2, 3, 4, 6, 1, 1]));
    expect(r.rerollIndices).toEqual([1, 2]);
    // Replacements of 1 become 5 points under Loaded Dice.
    expect(r.effectivePoints).toEqual([5, 5, 5, 4, 6]);
  });

  it('replacements are kept even if worse and never trigger another reroll', () => {
    const r = resolveDice(['second_chance'], scriptedDraws([3, 6, 6, 6, 6, 1]));
    expect(r.rerollIndices).toEqual([0]);
    expect(r.finalDice).toEqual([1, 6, 6, 6, 6]);
    expect(r.payout).toBe(125);
  });

  it('only draws what equipped effects need', () => {
    expect(() => resolveDice([], scriptedDraws([1, 2, 3, 4, 5]))).not.toThrow();
    expect(() => resolveDice(['extra_die'], scriptedDraws([1, 2, 3, 4, 5]))).toThrow(/exhausted/);
    // Second Chance with no eligible dice draws nothing extra.
    expect(() => resolveDice(['second_chance'], scriptedDraws([4, 4, 5, 5, 6]))).not.toThrow();
  });

  it('a raw 1 worth 5 under Loaded Dice is not reroll eligible', () => {
    const r = resolveDice(['loaded_dice', 'second_chance'], scriptedDraws([1, 1, 4, 5, 6]));
    expect(r.rerollIndices).toEqual([]);
  });
});
