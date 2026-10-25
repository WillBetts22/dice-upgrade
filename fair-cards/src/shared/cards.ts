// Cards, the contract's value rule, shocks and exact fair value.

/** Card ids are 0..51: rank = floor(id / 4) + 1 (A=1 .. K=13), suit = id % 4. */
export const DECK_SIZE = 52;
export const DECK: number[] = Array.from({ length: DECK_SIZE }, (_, i) => i);

const RANK_LABEL = ['', 'A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
// Text presentation selector keeps suits from rendering as emoji.
const SUIT_LABEL = ['♠︎', '♥︎', '♦︎', '♣︎'];

export const rankOf = (id: number) => Math.floor(id / 4) + 1;
export const suitOf = (id: number) => id % 4;
export const isRed = (id: number) => suitOf(id) === 1 || suitOf(id) === 2;
export const cardLabel = (id: number) => `${RANK_LABEL[rankOf(id)]}${SUIT_LABEL[suitOf(id)]}`;

/** How the contract settles: offset + sum of each contract card's value. */
export interface ValueRule {
  /** Multiplier for J, Q, K. */
  faceMult: number;
  /** Aces count 14 instead of 1. */
  aceHigh: boolean;
  /** Hearts and diamonds count 0. */
  redZero: boolean;
  offset: number;
}

export const BASE_RULE: ValueRule = { faceMult: 1, aceHigh: false, redZero: false, offset: 0 };

export function cardValue(id: number, rule: ValueRule): number {
  if (rule.redZero && isRed(id)) return 0;
  const r = rankOf(id);
  const v = r === 1 && rule.aceHigh ? 14 : r;
  return r >= 11 ? v * rule.faceMult : v;
}

export function settlementValue(contract: number[], rule: ValueRule): number {
  return contract.reduce((a, c) => a + cardValue(c, rule), rule.offset);
}

/**
 * Exact expected settlement given the contract cards a viewer knows.
 * Unknown contract cards are a uniformly random subset of the cards the viewer has not seen,
 * so each one is worth the average value of the unseen deck.
 */
export function fairValue(known: Iterable<number>, contractSize: number, rule: ValueRule): number {
  const k = new Set(known);
  let knownSum = 0;
  let restSum = 0;
  for (const id of DECK) {
    if (k.has(id)) knownSum += cardValue(id, rule);
    else restSum += cardValue(id, rule);
  }
  const unknown = contractSize - k.size;
  return rule.offset + knownSum + (unknown > 0 ? (unknown * restSum) / (DECK_SIZE - k.size) : 0);
}

export type ShockId = 'faces_double' | 'aces_high' | 'red_zero' | 'bonus' | 'penalty' | 'extra_cards';

export const EXTRA_CARDS = 2;

export const SHOCKS: Record<ShockId, { label: string; description: string }> = {
  faces_double: { label: 'Face cards count double', description: 'J, Q and K are now worth 22, 24 and 26.' },
  aces_high: { label: 'Aces are high', description: 'Aces now count 14 instead of 1.' },
  red_zero: { label: 'Red cards are void', description: 'Hearts and diamonds now count 0. Only black cards score.' },
  bonus: { label: 'Bonus +15', description: 'The contract pays 15 more at settlement.' },
  penalty: { label: 'Penalty -20', description: 'The contract pays 20 less at settlement.' },
  extra_cards: { label: 'Two more hidden cards', description: 'Two unseen cards join the contract. Nobody knows them until settlement.' },
};

export const SHOCK_IDS = Object.keys(SHOCKS) as ShockId[];

export function applyShock(rule: ValueRule, id: ShockId): ValueRule {
  switch (id) {
    case 'faces_double':
      return { ...rule, faceMult: rule.faceMult * 2 };
    case 'aces_high':
      return { ...rule, aceHigh: true };
    case 'red_zero':
      return { ...rule, redZero: true };
    case 'bonus':
      return { ...rule, offset: rule.offset + 15 };
    case 'penalty':
      return { ...rule, offset: rule.offset - 20 };
    case 'extra_cards':
      return rule;
  }
}

/** Short human summary of a rule, empty for the base rule. */
export function ruleSummary(rule: ValueRule): string[] {
  const out: string[] = [];
  if (rule.faceMult !== 1) out.push(`J/Q/K x${rule.faceMult}`);
  if (rule.aceHigh) out.push('A = 14');
  if (rule.redZero) out.push('red = 0');
  if (rule.offset) out.push(`${rule.offset > 0 ? '+' : ''}${rule.offset} at settle`);
  return out;
}
