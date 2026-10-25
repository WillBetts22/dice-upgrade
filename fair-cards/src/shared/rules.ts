export type RoundType = 'discovery' | 'makers' | 'shocks' | 'insider';

export const ROUND_TYPES: Record<RoundType, { name: string; lesson: string; rules: string }> = {
  discovery: {
    name: 'Price discovery',
    lesson: 'Prices pool information that no single person has.',
    rules: 'Everyone quotes a bid and an ask at most 4 apart. You can only trade with others while your own two-sided quote is live.',
  },
  makers: {
    name: 'Makers vs takers',
    lesson: 'Adverse selection: quoting tight against better-informed traders costs money.',
    rules:
      'About a third of the room are market makers. Makers see no private cards, must quote at most 2 wide, and earn a 1 coin rebate per lot filled on their quote. Takers get private cards and can only trade against makers.',
  },
  shocks: {
    name: 'News shocks',
    lesson: 'Public news moves prices at once; private information leaks in slowly.',
    rules: 'Same as price discovery, but two surprise news events change how the contract settles at random times.',
  },
  insider: {
    name: 'Insider',
    lesson: 'Spotting informed flow and widening or skewing when someone trades too confidently.',
    rules: 'Same as price discovery, but one random player secretly starts with 5 private cards. Nobody is told who.',
  },
};

export const ROUND_TYPE_IDS = Object.keys(ROUND_TYPES) as RoundType[];
export const DEFAULT_ROUND_TYPES: RoundType[] = ['discovery', 'makers', 'shocks', 'insider'];

export const MIN_ROUNDS = 1;
export const MAX_ROUNDS = 6;
export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 30;

export const CONTRACT_SIZE = 10;
/** Cumulative public cards after each information stage. */
export const PUBLIC_SCHEDULE = [0, 2, 4, 7];
export const STAGE_COUNT = PUBLIC_SCHEDULE.length;
/** Time between information stages; stage k starts k intervals into the market. */
export const DEFAULT_REVEAL_EVERY_MS = 120_000;
export const REVEAL_EVERY_BOUNDS: [number, number] = [15_000, 450_000];
/** The last reveal must leave at least this long to trade on it. */
export const MIN_FINAL_STAGE_MS = 15_000;
export const INSIDER_START_CARDS = 5;
/** News shocks in each news round, spread evenly through the market. */
export const DEFAULT_SHOCK_COUNT = 2;
export const SHOCK_COUNT_BOUNDS: [number, number] = [1, 6];
export const SHOCK_JITTER = 0.04;
/** Shocks keep at least this fraction of the market away from a reveal. */
export const SHOCK_GAP = 0.04;

export type MarketId = 'sum' | 'product';
export const MARKET_IDS: MarketId[] = ['sum', 'product'];
export const PRODUCT_CARDS = 3;

export interface MarketSpec {
  name: string;
  short: string;
  pays: string;
  maxWidth: number;
  makerWidth: number;
  maxSize: number;
  positionLimit: number;
  rebate: number;
  priceMax: number;
  /** Where a fresh quote box starts. */
  startMid: number;
  /** Review thresholds, in this market's coins. */
  edgeNoise: number;
  missedEdge: number;
  staleSlack: number;
  inventoryWarn: number;
}

export const MARKETS: Record<MarketId, MarketSpec> = {
  sum: {
    name: 'Sum market',
    short: 'Sum',
    pays: 'the sum of all the contract cards',
    maxWidth: 4,
    makerWidth: 2,
    maxSize: 5,
    positionLimit: 10,
    rebate: 1,
    priceMax: 400,
    startMid: 70,
    edgeNoise: 1,
    missedEdge: 3,
    staleSlack: 0.5,
    inventoryWarn: 8,
  },
  product: {
    name: 'Product market',
    short: 'Product',
    pays: 'the product of the 3 product cards',
    maxWidth: 40,
    makerWidth: 20,
    maxSize: 3,
    positionLimit: 3,
    rebate: 5,
    priceMax: 20_000,
    startMid: 300,
    edgeNoise: 15,
    missedEdge: 40,
    staleSlack: 10,
    inventoryWarn: 3,
  },
};

export const DEFAULT_PRODUCT_MARKET = true;

/** Personal information the host can dial up or down. */
export const DEFAULT_PRIVATE_START = 1;
export const PRIVATE_START_BOUNDS: [number, number] = [0, 5];
export const DEFAULT_PRIVATE_PER_REVEAL = 1;
export const PRIVATE_PER_REVEAL_BOUNDS: [number, number] = [0, 3];
export const DEFAULT_CLUES_PER_REVEAL = 1;
export const CLUES_PER_REVEAL_BOUNDS: [number, number] = [0, 3];
/** Private cards and clues are dealt at the open and the first two reveals. */
export const PERSONAL_STAGES = 3;

export const MAX_WIDTH = 4;
/** Minimum time between a player's quote posts. Off unless the host turns it on. */
export const DEFAULT_QUOTE_COOLDOWN_MS = 0;
export const QUOTE_COOLDOWN_BOUNDS: [number, number] = [0, 60_000];
export const MAKER_WIDTH = 2;
export const MAX_QUOTE_SIZE = 5;
export const POSITION_LIMIT = 10;
export const MAKER_REBATE = 1;
export const PRICE_MIN = 0;
export const PRICE_MAX = 400;

export interface Durations {
  briefingMs: number;
  marketMs: number;
  resultsMs: number;
}

export const DEFAULT_DURATIONS: Durations = { briefingMs: 30_000, marketMs: 480_000, resultsMs: 120_000 };
export const DURATION_BOUNDS: Record<keyof Durations, [number, number]> = {
  briefingMs: [5_000, 300_000],
  marketMs: [60_000, 1_800_000],
  resultsMs: [10_000, 600_000],
};

/** Review thresholds. */
export const STALE_MS = 15_000;
export const MISSED_EDGE = 3;
export const MISSED_WINDOW_MS = 30_000;
export const EDGE_NOISE = 1;

export function makerCount(players: number): number {
  return Math.min(players - 1, Math.max(1, Math.round(players / 3)));
}

/** Market length that fits every reveal with time left to trade on the last one. */
export function minMarketMs(revealEveryMs: number): number {
  return (STAGE_COUNT - 1) * revealEveryMs + MIN_FINAL_STAGE_MS;
}

/** Longest reveal interval a market of this length allows. */
export function maxRevealEveryMs(marketMs: number): number {
  return Math.floor((marketMs - MIN_FINAL_STAGE_MS) / (STAGE_COUNT - 1) / 1000) * 1000;
}

export function projectedMinutes(rounds: number, d: Durations = DEFAULT_DURATIONS): number {
  return Math.round(5 + (rounds * (d.briefingMs + d.marketMs + d.resultsMs)) / 60_000);
}

export const HOST_SCRIPT = `Fair Cards in five minutes.

1. Each round the server deals 10 hidden cards. The contract pays the sum of those cards: ace is 1, jack 11, queen 12, king 13. The average is 70.
2. You each get a private card or two, and at regular intervals more cards are revealed to everyone. Together the room knows almost everything; alone you know a little.
3. You trade by quoting: a bid (the price you will buy at) and an ask (the price you will sell at), at most 4 apart. Others can buy from your ask or sell to your bid. You can only trade with others while your own quote is live.
4. Score = cash + position x settlement. You can go long or short up to 10 lots. Positions reset each round.
5. Watch the chart: trades should find the true value before the public cards do. That is price discovery.
6. There can be a second market on the product of 3 marked "product cards". Same cards, a different calculation: your information may be worth more in one market than the other. You may also get private clues such as "the sum is a multiple of 6".
7. Later rounds add designated market makers, surprise news, and a hidden insider.
8. After each round you get a review of every decision: what each trade was worth given what you knew, and what you could have done better.`;
