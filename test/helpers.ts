import { UPGRADE_IDS, type UpgradeId } from '../src/shared/catalog.js';
import { STARTING_CASH } from '../src/shared/rules.js';
import { Changes, type Ctx, type RoundState, draftRoom } from '../src/server/engine/state.js';

let idn = 0;
export function ctx(now = 1000): Ctx {
  return { now, changes: new Changes(), newId: () => `id${++idn}` };
}

export const POOL: UpgradeId[] = ['extra_die', 'second_chance', 'loaded_dice', 'six_hunter'];

/** A round with named players, 100 coins each and the given starting holdings. */
export function makeRound(players: Record<string, Partial<Record<UpgradeId, number>>>, pool = POOL): RoundState {
  const round: RoundState = {
    id: 'room:r1',
    roomId: 'room',
    number: 1,
    pool,
    dealSeed: 1,
    accounts: {},
    openOrders: {},
    trades: [],
    upgrades: {},
    settlements: [],
    dice: {},
    nextSeq: 1,
    closedOrders: [],
    decisions: [],
    marketClosedAt: null,
  };
  for (const t of pool) round.upgrades[t] = { type: t, lastPrice: null, highPrice: null, volume: 0, initialSupply: 0, shortCloseouts: 0 };
  for (const [pid, holds] of Object.entries(players)) {
    const positions = Object.fromEntries(UPGRADE_IDS.map((t) => [t, holds[t] ?? 0])) as Record<UpgradeId, number>;
    for (const t of pool) round.upgrades[t].initialSupply += positions[t];
    round.accounts[pid] = {
      playerId: pid,
      cash: STARTING_CASH,
      shortDeductions: 0,
      startingUpgrade: (Object.keys(holds)[0] as UpgradeId) ?? pool[0],
      positions,
      equipment: [],
      equipmentSubmitted: false,
      revision: 0,
    };
  }
  return round;
}

/** Run fn against a draft copy, committing only if it does not throw (mirrors the manager). */
export function apply<T>(round: RoundState, fn: (draft: RoundState, c: Ctx) => T, now = 1000): { round: RoundState; result?: T; error?: any; c: Ctx } {
  const fake = { round } as any;
  const draft = draftRoom({ ...fake, config: {}, players: {}, completedRounds: [] }).round!;
  const c = ctx(now);
  try {
    const result = fn(draft, c);
    draft.trades = round.trades.concat(c.changes.trades);
    return { round: draft, result, c };
  } catch (error) {
    return { round, error, c };
  }
}

export function totalCash(round: RoundState): number {
  return Object.values(round.accounts).reduce((a, x) => a + x.cash, 0);
}

export function totalSupply(round: RoundState, t: UpgradeId): number {
  return Object.values(round.accounts).reduce((a, x) => a + x.positions[t], 0);
}
