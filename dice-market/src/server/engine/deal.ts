import { CATALOG, type UpgradeId, getPoolVersion } from '../../shared/catalog.js';
import { FAIRNESS_TOLERANCE, POOL_SIZE } from '../../shared/rules.js';
import { seededRng, shuffle } from './rng.js';

export interface DealPlan {
  pool: UpgradeId[];
  /** playerId -> dealt type */
  assignment: Record<string, UpgradeId>;
  supply: Record<string, number>;
  attempts: number;
  usedFallback: boolean;
}

export const MAX_DEAL_ATTEMPTS = 20;

/** Type counts differ by at most one; which types get the extra copy is random. */
export function balancedCounts(pool: UpgradeId[], players: number, rand: () => number): Record<string, number> {
  const base = Math.floor(players / pool.length);
  const extra = players % pool.length;
  const order = shuffle(pool, rand);
  const counts: Record<string, number> = {};
  order.forEach((t, i) => (counts[t] = base + (i < extra ? 1 : 0)));
  return counts;
}

/**
 * Pair cards sorted by descending standalone value with players sorted by ascending
 * accumulated endowment value, shuffling ties on both sides.
 */
export function pairDeal(
  counts: Record<string, number>,
  accumulated: Record<string, number>,
  rand: (() => number) | null,
  value: (t: UpgradeId) => number = (t) => CATALOG[t].standaloneIncrement,
): Record<string, UpgradeId> {
  const cards: UpgradeId[] = [];
  for (const [t, n] of Object.entries(counts)) for (let i = 0; i < n; i++) cards.push(t as UpgradeId);
  const mix = <T,>(xs: T[]) => (rand ? shuffle(xs, rand) : xs.slice());
  const cardOrder = mix(cards).sort((a, b) => value(b) - value(a));
  const playerOrder = mix(Object.keys(accumulated).sort()).sort((a, b) => accumulated[a] - accumulated[b]);
  if (cardOrder.length !== playerOrder.length) throw new Error('card and player counts differ');
  const out: Record<string, UpgradeId> = {};
  playerOrder.forEach((p, i) => (out[p] = cardOrder[i]));
  return out;
}

export function spreadAfter(accumulated: Record<string, number>, assignment: Record<string, UpgradeId>): number {
  const totals = Object.keys(accumulated).map((p) => accumulated[p] + CATALOG[assignment[p]].standaloneIncrement);
  return totals.length ? Math.max(...totals) - Math.min(...totals) : 0;
}

/**
 * Choose a pool and a fair deal. Resamples a bounded number of times, then uses a
 * precomputed deterministic schedule; never silently relaxes the constraint.
 */
export function planDeal(args: {
  poolVersion: string;
  roundNumber: number;
  accumulated: Record<string, number>;
  seed: number;
}): DealPlan {
  const version = getPoolVersion(args.poolVersion);
  if (!version) throw new Error(`unknown pool version ${args.poolVersion}`);
  const rand = seededRng(args.seed);
  const n = Object.keys(args.accumulated).length;
  for (let attempt = 1; attempt <= MAX_DEAL_ATTEMPTS; attempt++) {
    const pool = version.pools[Math.floor(rand() * version.pools.length)];
    const supply = balancedCounts(pool, n, rand);
    const assignment = pairDeal(supply, args.accumulated, rand);
    if (spreadAfter(args.accumulated, assignment) <= FAIRNESS_TOLERANCE + 1e-9) {
      return { pool: pool.slice(), assignment, supply, attempts: attempt, usedFallback: false };
    }
  }
  return fallbackDeal(version.pools, args.roundNumber, args.accumulated);
}

/** Deterministic schedule: pool by round index, counts in pool order, sorted pairing without shuffles. */
export function fallbackDeal(pools: UpgradeId[][], roundNumber: number, accumulated: Record<string, number>): DealPlan {
  const pool = pools[(roundNumber - 1) % pools.length];
  const n = Object.keys(accumulated).length;
  const supply: Record<string, number> = {};
  pool.forEach((t, i) => (supply[t] = Math.floor(n / POOL_SIZE) + (i < n % POOL_SIZE ? 1 : 0)));
  const assignment = pairDeal(supply, accumulated, null);
  if (spreadAfter(accumulated, assignment) > FAIRNESS_TOLERANCE + 1e-9) {
    throw new Error('no fair deal exists for this roster; refusing to relax the fairness constraint');
  }
  return { pool: pool.slice(), assignment, supply, attempts: MAX_DEAL_ATTEMPTS, usedFallback: true };
}
