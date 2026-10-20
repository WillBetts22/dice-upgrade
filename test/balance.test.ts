import { describe, expect, it } from 'vitest';
import { buildReport } from '../src/tools/balance-lib.js';

describe('balance calibration', () => {
  it('reproduces the spec calibration and passes every release check', () => {
    const r = buildReport(3);
    expect(r.base.mean).toBeCloseTo(87.5, 10);
    const inc = Object.fromEntries(r.singles.map((s) => [s.equipment[0], s.increment]));
    expect(inc.extra_die).toBeCloseTo(17.5, 4);
    expect(inc.second_chance).toBeCloseTo(15.462, 3);
    expect(inc.jackpot).toBeCloseTo(16.6808, 4);
    expect(inc.safety_net).toBeCloseTo(15.4482, 4);
    expect(r.standaloneSpread).toBeCloseTo(2.052, 3);
    const top = r.pairs.reduce((a, b) => (a.increment > b.increment ? a : b));
    expect(top.equipment).toEqual(['second_chance', 'jackpot']);
    expect(top.increment).toBeCloseTo(42.451, 3);
    expect(r.checks.filter((c) => !c.pass)).toEqual([]);
  }, 60_000);
});
