// Personal clues: true statements about the hidden contract, phrased on face values (A=1 .. K=13) so news never changes them.
import { cardValue, DECK, isRed, rankOf, type ValueRule } from './cards.js';
import type { MarketId } from './rules.js';

export type ClueSpec =
  | { k: 'sum_mod'; m: number; r: number }
  | { k: 'sum_cmp'; t: number; above: boolean }
  | { k: 'count_face'; n: number }
  | { k: 'count_red'; n: number }
  | { k: 'rank_count'; rank: number; n: number }
  | { k: 'count_high'; n: number }
  | { k: 'prod_div'; p: number; yes: boolean }
  | { k: 'prod_distinct'; n: number }
  | { k: 'prod_omega'; n: number }
  | { k: 'prod_sum_cmp'; t: number; above: boolean }
  | { k: 'prod_max'; rank: number }
  | { k: 'prod_red'; n: number }
  | { k: 'prod_cmp'; t: number; above: boolean };

export interface Clue {
  id: string;
  /** The market it mostly informs. */
  market: MarketId;
  text: string;
  spec: ClueSpec;
  stage: number;
}

const RANK_NAME = ['', 'ace', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'jack', 'queen', 'king'];
const PRIMES = [2, 3, 5, 7, 11, 13];
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function primeStats(n: number): { distinct: number; omega: number } {
  let distinct = 0;
  let omega = 0;
  for (const p of PRIMES) {
    if (n % p) continue;
    distinct++;
    while (n % p === 0) {
      n /= p;
      omega++;
    }
  }
  return { distinct, omega };
}

/** Does the clue hold for these 10 original contract cards and their 3 product cards? */
export function clueHolds(c: ClueSpec, contract: number[], product: number[]): boolean {
  switch (c.k) {
    case 'sum_mod':
      return contract.reduce((a, x) => a + rankOf(x), 0) % c.m === c.r;
    case 'sum_cmp':
      return contract.reduce((a, x) => a + rankOf(x), 0) > c.t === c.above;
    case 'count_face':
      return contract.filter((x) => rankOf(x) >= 11).length === c.n;
    case 'count_red':
      return contract.filter(isRed).length === c.n;
    case 'rank_count':
      return contract.filter((x) => rankOf(x) === c.rank).length === c.n;
    case 'count_high':
      return contract.filter((x) => rankOf(x) >= 8).length === c.n;
    case 'prod_div':
      return (product.reduce((a, x) => a * rankOf(x), 1) % c.p === 0) === c.yes;
    case 'prod_distinct':
      return primeStats(product.reduce((a, x) => a * rankOf(x), 1)).distinct === c.n;
    case 'prod_omega':
      return primeStats(product.reduce((a, x) => a * rankOf(x), 1)).omega === c.n;
    case 'prod_sum_cmp':
      return product.reduce((a, x) => a + rankOf(x), 0) > c.t === c.above;
    case 'prod_max':
      return Math.max(...product.map(rankOf)) === c.rank;
    case 'prod_red':
      return product.filter(isRed).length === c.n;
    case 'prod_cmp':
      return product.reduce((a, x) => a * rankOf(x), 1) > c.t === c.above;
  }
}

function describe(c: ClueSpec): string {
  switch (c.k) {
    case 'sum_mod':
      if (c.m === 2) return `The 10 cards add up to an ${c.r ? 'odd' : 'even'} number.`;
      return c.r === 0 ? `The 10 cards add up to a multiple of ${c.m}.` : `The 10 cards add up to ${c.r} more than a multiple of ${c.m}.`;
    case 'sum_cmp':
      return `The 10 cards add up to ${c.above ? 'more than' : 'at most'} ${c.t}.`;
    case 'count_face':
      return `Exactly ${plural(c.n, 'card')} of the 10 ${c.n === 1 ? 'is a face card' : 'are face cards'} (J, Q, K).`;
    case 'count_red':
      return `Exactly ${c.n} of the 10 cards ${c.n === 1 ? 'is' : 'are'} red.`;
    case 'rank_count':
      return c.n === 0 ? `There is no ${RANK_NAME[c.rank]} among the 10 cards.` : `There ${c.n === 1 ? 'is exactly one' : `are exactly ${c.n}`} ${RANK_NAME[c.rank]}${c.n === 1 ? '' : 's'} among the 10 cards.`;
    case 'count_high':
      return `Exactly ${c.n} of the 10 cards ${c.n === 1 ? 'is' : 'are'} 8 or higher.`;
    case 'prod_div':
      return `The product cards multiply to a number ${c.yes ? '' : 'not '}divisible by ${c.p}.`;
    case 'prod_distinct':
      return `The product has exactly ${plural(c.n, 'distinct prime factor')}.`;
    case 'prod_omega':
      return `The product has ${plural(c.n, 'prime factor')} counting repeats (8 = 2x2x2 counts 3).`;
    case 'prod_sum_cmp':
      return `The 3 product cards add up to ${c.above ? 'more than' : 'at most'} ${c.t}.`;
    case 'prod_max':
      return `The highest product card is ${c.rank === 1 || c.rank === 8 ? 'an' : 'a'} ${RANK_NAME[c.rank]}.`;
    case 'prod_red':
      return `Exactly ${c.n} of the 3 product cards ${c.n === 1 ? 'is' : 'are'} red.`;
    case 'prod_cmp':
      return `The product cards multiply to ${c.above ? 'more than' : 'at most'} ${c.t}.`;
  }
}

const pick = <T,>(xs: T[], rand: () => number): T => xs[Math.floor(rand() * xs.length)];

/** A true clue about this contract, drawn for one market, avoiding ids the player already has. */
export function makeClue(market: MarketId, contract: number[], product: number[], rand: () => number, have: Set<string>, stage: number): Clue | null {
  const S = contract.reduce((a, x) => a + rankOf(x), 0);
  const P = product.reduce((a, x) => a * rankOf(x), 1);
  const ps = primeStats(P);
  const makers: (() => ClueSpec)[] =
    market === 'sum'
      ? [
          () => {
            const m = pick([2, 3, 4, 5, 6], rand);
            return { k: 'sum_mod', m, r: S % m };
          },
          () => {
            const t = 55 + Math.floor(rand() * 31);
            return { k: 'sum_cmp', t, above: S > t };
          },
          () => ({ k: 'count_face', n: contract.filter((x) => rankOf(x) >= 11).length }),
          () => ({ k: 'count_red', n: contract.filter(isRed).length }),
          () => {
            const rank = 1 + Math.floor(rand() * 13);
            return { k: 'rank_count', rank, n: contract.filter((x) => rankOf(x) === rank).length };
          },
          () => ({ k: 'count_high', n: contract.filter((x) => rankOf(x) >= 8).length }),
        ]
      : [
          () => {
            const p = pick(PRIMES, rand);
            return { k: 'prod_div', p, yes: P % p === 0 };
          },
          () => ({ k: 'prod_distinct', n: ps.distinct }),
          () => ({ k: 'prod_omega', n: ps.omega }),
          () => {
            const t = 12 + Math.floor(rand() * 17);
            return { k: 'prod_sum_cmp', t, above: product.reduce((a, x) => a + rankOf(x), 0) > t };
          },
          () => ({ k: 'prod_max', rank: Math.max(...product.map(rankOf)) }),
          () => ({ k: 'prod_red', n: product.filter(isRed).length }),
          () => {
            const t = pick([50, 100, 200, 300, 500, 800], rand);
            return { k: 'prod_cmp', t, above: P > t };
          },
        ];
  for (let tries = 0; tries < 30; tries++) {
    const spec = pick(makers, rand)();
    const id = JSON.stringify(spec);
    if (have.has(id)) continue;
    return { id, market, text: describe(spec), spec, stage };
  }
  return null;
}

/**
 * Expected settlement in each market for a viewer, given the cards they know and their clues.
 * Without clues this is exact. With clues it samples hidden hands consistent with every clue
 * (a Metropolis walk over swaps, started from the true hand, which always satisfies them).
 */
export function estimateFv(a: {
  known: number[];
  /** The 10 original contract cards and the 3 product cards (truth; the walk only starts here). */
  contract: number[];
  product: number[];
  /** Cards added by news, unknown to everyone. */
  extras: number;
  clues: ClueSpec[];
  rule: ValueRule;
  rand: () => number;
  steps?: number;
}): { sum: number; product: number } {
  const known = new Set(a.known);
  const v = (id: number) => cardValue(id, a.rule);
  const knownOrig = a.contract.filter((c) => known.has(c));
  const knownProd = a.product.filter((c) => known.has(c));
  const knownSum = knownOrig.reduce((s, c) => s + v(c), 0);
  const knownProdVal = knownProd.reduce((s, c) => s * v(c), 1);
  const uP = a.product.filter((c) => !known.has(c));
  const uN = a.contract.filter((c) => !known.has(c) && !a.product.includes(c));
  const free = DECK.filter((c) => !known.has(c) && !a.contract.includes(c));
  const poolSize = uP.length + uN.length + free.length;
  const poolValue = [...uP, ...uN, ...free].reduce((s, c) => s + v(c), 0);

  let sumAcc = 0;
  let prodAcc = 0;
  let n = 0;
  const record = () => {
    const hidden = uP.reduce((s, c) => s + v(c), 0) + uN.reduce((s, c) => s + v(c), 0);
    // Extra cards are a uniform draw from whatever is left unseen.
    const freeAvg = free.length ? (poolValue - hidden) / free.length : 0;
    sumAcc += a.rule.offset + knownSum + hidden + a.extras * freeAvg;
    prodAcc += knownProdVal * uP.reduce((s, c) => s * v(c), 1);
    n++;
  };
  if (!a.clues.length) {
    // Exact: every hidden card is an average unseen card; products use exact symmetric sums.
    const avg = poolSize ? poolValue / poolSize : 0;
    const hiddenCount = uP.length + uN.length + a.extras;
    const values = [...uP, ...uN, ...free].map(v);
    let e = [1, 0, 0, 0, 0, 0];
    for (const x of values) for (let j = uP.length; j >= 1; j--) e[j] += e[j - 1] * x;
    let combos = 1;
    for (let i = 0; i < uP.length; i++) combos = (combos * (values.length - i)) / (i + 1);
    return { sum: a.rule.offset + knownSum + hiddenCount * avg, product: knownProdVal * (uP.length ? e[uP.length] / combos : 1) };
  }

  const ok = () => {
    const contract = [...knownOrig, ...uP, ...uN];
    const product = [...knownProd, ...uP];
    return a.clues.every((c) => clueHolds(c, contract, product));
  };
  const steps = a.steps ?? 14_000;
  const burn = Math.floor(steps / 8);
  const slots = uP.length + uN.length;
  for (let i = 0; i < steps; i++) {
    if (slots > 0) {
      const swapInside = uP.length > 0 && uN.length > 0 && a.rand() < 0.25;
      if (swapInside) {
        const x = Math.floor(a.rand() * uP.length);
        const y = Math.floor(a.rand() * uN.length);
        [uP[x], uN[y]] = [uN[y], uP[x]];
        if (!ok()) [uP[x], uN[y]] = [uN[y], uP[x]];
      } else if (free.length) {
        const s = Math.floor(a.rand() * slots);
        const f = Math.floor(a.rand() * free.length);
        const arr = s < uP.length ? uP : uN;
        const j = s < uP.length ? s : s - uP.length;
        [arr[j], free[f]] = [free[f], arr[j]];
        if (!ok()) [arr[j], free[f]] = [free[f], arr[j]];
      }
    }
    if (i >= burn) record();
  }
  return { sum: sumAcc / n, product: prodAcc / n };
}
