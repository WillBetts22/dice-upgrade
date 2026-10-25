import type { UpgradeId } from './catalog.js';

/** Returns one fair die face 1..6. Tests inject exact sequences. */
export type DrawFn = () => number;

export interface DiceResolution {
  equipment: UpgradeId[];
  originalDice: number[];
  /** Indices (into originalDice) selected for Second Chance, ascending by (points, index). */
  rerollIndices: number[];
  /** Replacement faces, aligned with rerollIndices. */
  replacements: number[];
  finalDice: number[];
  effectivePoints: number[];
  pointTotal: number;
  basePayout: number;
  floorAdjustment: number;
  sixBonus: number;
  jackpotBonus: number;
  payout: number;
}

export const COINS_PER_POINT = 5;
export const SAFETY_FLOOR = 100;
export const SIX_HUNTER_BONUS = 20;
export const JACKPOT_BONUS = 85;
export const MAX_DICE = 6;

function points(face: number, loaded: boolean): number {
  return loaded && face === 1 ? 5 : face;
}

/**
 * Resolution order: extra die, initial roll, Loaded Dice preview, select up to two
 * lowest dice worth at most 3 points, one replacement per selected die, final Loaded
 * Dice conversion, base payout, safety floor, six and jackpot bonuses.
 */
export function resolveDice(equipment: UpgradeId[], draw: DrawFn): DiceResolution {
  const has = (t: UpgradeId) => equipment.includes(t);
  const loaded = has('loaded_dice');
  const diceCount = has('extra_die') ? 6 : 5;

  const originalDice: number[] = [];
  for (let i = 0; i < diceCount; i++) originalDice.push(checkFace(draw()));

  const rerollIndices: number[] = [];
  const replacements: number[] = [];
  if (has('second_chance')) {
    // Determine both targets before replacing either.
    const eligible = originalDice
      .map((face, index) => ({ index, pts: points(face, loaded) }))
      .filter((d) => d.pts <= 3)
      .sort((a, b) => a.pts - b.pts || a.index - b.index)
      .slice(0, 2);
    for (const d of eligible) rerollIndices.push(d.index);
    for (let k = 0; k < rerollIndices.length; k++) replacements.push(checkFace(draw()));
  }

  const finalDice = originalDice.slice();
  rerollIndices.forEach((idx, k) => {
    finalDice[idx] = replacements[k];
  });

  const effectivePoints = finalDice.map((f) => points(f, loaded));
  const pointTotal = effectivePoints.reduce((a, b) => a + b, 0);
  const basePayout = pointTotal * COINS_PER_POINT;
  const floorAdjustment = has('safety_net') && basePayout < SAFETY_FLOOR ? SAFETY_FLOOR - basePayout : 0;
  const sixes = finalDice.filter((f) => f === 6).length;
  const sixBonus = has('six_hunter') ? SIX_HUNTER_BONUS * sixes : 0;
  const jackpotBonus = has('jackpot') && sixes >= 2 ? JACKPOT_BONUS : 0;
  const payout = basePayout + floorAdjustment + sixBonus + jackpotBonus;

  return {
    equipment: equipment.slice(),
    originalDice,
    rerollIndices,
    replacements,
    finalDice,
    effectivePoints,
    pointTotal,
    basePayout,
    floorAdjustment,
    sixBonus,
    jackpotBonus,
    payout,
  };
}

function checkFace(f: number): number {
  if (!Number.isInteger(f) || f < 1 || f > 6) throw new Error(`invalid die face ${f}`);
  return f;
}

/** A draw function that replays a fixed list and throws if more draws are requested. */
export function scriptedDraws(faces: number[]): DrawFn {
  let i = 0;
  return () => {
    if (i >= faces.length) throw new Error('scripted draws exhausted');
    return faces[i++];
  };
}
