import { describe, expect, it } from 'vitest';
import { UPGRADE_IDS, type UpgradeId } from '../src/shared/catalog.js';
import { MU, V, bestPair, equipKey, mu } from '../src/shared/ev-table.js';
import { stats } from '../src/tools/balance-lib.js';

describe('hardcoded EV table', () => {
  it('matches exact enumeration for every equipment set', () => {
    const sets: UpgradeId[][] = [[], ...UPGRADE_IDS.map((t) => [t])];
    for (let i = 0; i < UPGRADE_IDS.length; i++) for (let j = i + 1; j < UPGRADE_IDS.length; j++) sets.push([UPGRADE_IDS[i], UPGRADE_IDS[j]]);
    expect(Object.keys(MU)).toHaveLength(sets.length);
    for (const s of sets) expect(Math.abs(MU[equipKey(s)] - stats(s).mean)).toBeLessThan(1e-9);
  }, 60_000);

  it('V and bestPair pick the best pair from any owned set', () => {
    expect(V([])).toBe(87.5);
    expect(bestPair(['extra_die', 'second_chance', 'jackpot'])).toEqual(['second_chance', 'jackpot']);
    expect(V(['jackpot', 'second_chance'])).toBe(mu(['second_chance', 'jackpot']));
    for (let mask = 0; mask < 64; mask++) {
      const S = UPGRADE_IDS.filter((_, i) => mask & (1 << i));
      const p = bestPair(S);
      expect(p.length).toBe(Math.min(2, S.length));
      for (const t of S) expect(V(S)).toBeGreaterThanOrEqual(mu([t]));
    }
  });
});
