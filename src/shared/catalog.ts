// Upgrade catalog, version 1. The row order here is the row order of the
// spec's definition table and is used for the selection-timeout fallback.

export const UPGRADE_IDS = [
  'extra_die',
  'second_chance',
  'loaded_dice',
  'six_hunter',
  'jackpot',
  'safety_net',
] as const;

export type UpgradeId = (typeof UPGRADE_IDS)[number];

export interface UpgradeDef {
  id: UpgradeId;
  name: string;
  effect: string;
  /** Straightforward effects always help; situational ones depend on the roll. */
  kind: 'straightforward' | 'situational';
  /** Exact standalone expected payout increment in coins (see docs/balance-report.md). */
  standaloneIncrement: number;
}

export const CATALOG_VERSION = 'v1';

export const CATALOG: Record<UpgradeId, UpgradeDef> = {
  extra_die: {
    id: 'extra_die',
    name: 'Extra Die',
    effect: 'Roll one additional independent die, for six dice total.',
    kind: 'straightforward',
    standaloneIncrement: 17.5,
  },
  second_chance: {
    id: 'second_chance',
    name: 'Second Chance',
    effect:
      'Reroll up to two lowest dice worth 1, 2, or 3 points, once each; keep replacements even if worse. Loaded Dice conversions count when deciding eligibility. Ties go to the lower original position.',
    kind: 'situational',
    standaloneIncrement: 15.462,
  },
  loaded_dice: {
    id: 'loaded_dice',
    name: 'Loaded Dice',
    effect: 'Each raw 1 contributes 5 points instead of 1. Other faces keep their value. Applies to rerolled faces too.',
    kind: 'straightforward',
    standaloneIncrement: 16.6667,
  },
  six_hunter: {
    id: 'six_hunter',
    name: 'Six Hunter',
    effect: 'Add 20 coins for each final raw 6.',
    kind: 'straightforward',
    standaloneIncrement: 16.6667,
  },
  jackpot: {
    id: 'jackpot',
    name: 'Jackpot',
    effect: 'Add 85 coins once if at least two final raw dice are 6.',
    kind: 'situational',
    standaloneIncrement: 16.6808,
  },
  safety_net: {
    id: 'safety_net',
    name: 'Safety Net',
    effect: 'Increase the base payout to 100 coins if it would otherwise be lower. Six bonuses and jackpot apply afterward.',
    kind: 'situational',
    standaloneIncrement: 15.4482,
  },
};

export function isUpgradeId(x: unknown): x is UpgradeId {
  return typeof x === 'string' && (UPGRADE_IDS as readonly string[]).includes(x);
}

/** Validated pool versions. Each pool is four distinct types; every pair inside passes the balance checks. */
export interface PoolVersion {
  id: string;
  catalogVersion: string;
  pools: UpgradeId[][];
}

function allFourTypePools(): UpgradeId[][] {
  const out: UpgradeId[][] = [];
  const ids = UPGRADE_IDS;
  for (let a = 0; a < ids.length; a++)
    for (let b = a + 1; b < ids.length; b++)
      for (let c = b + 1; c < ids.length; c++)
        for (let d = c + 1; d < ids.length; d++) out.push([ids[a], ids[b], ids[c], ids[d]]);
  return out;
}

/** Pools must mix straightforward and situational effects. */
export function poolIsMixed(pool: UpgradeId[]): boolean {
  const kinds = new Set(pool.map((t) => CATALOG[t].kind));
  return kinds.has('straightforward') && kinds.has('situational');
}

export const POOL_VERSIONS: PoolVersion[] = [
  {
    id: 'v1-all15',
    catalogVersion: CATALOG_VERSION,
    pools: allFourTypePools().filter(poolIsMixed),
  },
];

export const DEFAULT_POOL_VERSION = POOL_VERSIONS[0].id;

export function getPoolVersion(id: string): PoolVersion | undefined {
  return POOL_VERSIONS.find((p) => p.id === id);
}
