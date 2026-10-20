// Fixed market and session rules. The host cannot change these after a round begins.

export const STARTING_CASH = 100;
export const MIN_PRICE = 1;
export const MAX_PRICE = 50;
export const MIN_QTY = 1;
export const MAX_QTY = 2;
export const MAX_OPEN_ORDERS = 12;
export const MAX_SHORT_UNITS = 2;
export const CLOSEOUT_FALLBACK_PRICE = 10;
export const MAX_DEDUCTION_PER_ROUND = MAX_SHORT_UNITS * MAX_PRICE; // 100
export const POOL_SIZE = 4;
export const MAX_EQUIPPED = 2;
export const MAX_PLAYERS = 30;
export const MIN_PLAYERS = 2;
export const MIN_ROUNDS = 1;
export const MAX_ROUNDS = 6;
export const DEFAULT_ROUNDS = 2;
export const EXPLANATION_MINUTES = 5;
export const FAIRNESS_TOLERANCE = 3;

export interface PhaseDurations {
  marketMs: number;
  /** Selection allowance; settlement runs inside it. */
  selectionMs: number;
  revealMs: number;
  resultsMs: number;
}

export const DEFAULT_DURATIONS: PhaseDurations = {
  marketMs: 7 * 60_000,
  selectionMs: 60_000,
  revealMs: 60_000,
  resultsMs: 60_000,
};

export function roundLengthMs(d: PhaseDurations): number {
  return d.marketMs + d.selectionMs + d.revealMs + d.resultsMs;
}

/** Projected session length: explanation plus every configured round. */
export function projectedSessionMinutes(rounds: number, d: PhaseDurations = DEFAULT_DURATIONS): number {
  return EXPLANATION_MINUTES + (rounds * roundLengthMs(d)) / 60_000;
}

export const PHASES = ['lobby', 'market', 'settling', 'selection', 'reveal', 'results', 'finished'] as const;
export type Phase = (typeof PHASES)[number];

export const HOST_SCRIPT = `You each start with 100 coins and one upgrade. At the end you roll five dice and get five coins per point, with up to two upgrades changing the result. Your score is your remaining money plus the dice winnings minus any uncovered short deductions. During seven minutes, post prices to buy and sell upgrades, or accept someone else's price. You can sell something you do not have, but then you owe it. Buy it back before time runs out, or that upgrade's highest traded price this round is deducted from your final score for each unit owed. Your screen shows this exposure; you can owe at most two units in total. Check the Holdings tab to see who owns what. The host chooses the number of rounds, with two as the default. Each round has fresh money and a new fair selection of upgrades, so use the first round to learn how to price them.`;

export const FAIRNESS_NOTE =
  'Everyone gets the same cash, one card from a similarly valued catalog, and access to the same randomized market. Dice luck still affects results.';
