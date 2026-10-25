import type { ShockId, ValueRule } from './cards.js';
import type { PlayerRoundReview } from './review.js';
import type { Durations, RoundType } from './rules.js';

export type Phase = 'lobby' | 'briefing' | 'market' | 'results' | 'finished';
export type Role = 'trader' | 'maker' | 'taker';
export type Side = 'buy' | 'sell';

export interface RoomConfig extends Durations {
  roundTypes: RoundType[];
  devMode: boolean;
  /** Minimum ms between a player's quote posts. */
  quoteCooldownMs: number;
  /** Ms between information stages. */
  revealEveryMs: number;
  /** News shocks in each news round. */
  shockCount: number;
}

export interface Quote {
  id: string;
  bid: number;
  ask: number;
  bidSize: number;
  askSize: number;
  size: number;
  postedAt: number;
  /** The poster's own fair value when the quote went up. */
  fvAtPost: number;
}

export interface Trade {
  id: string;
  seq: number;
  at: number;
  buyerId: string;
  sellerId: string;
  aggressorId: string;
  restingId: string;
  price: number;
  qty: number;
  /** Rebate paid to the resting maker (makers round only). */
  rebate: number;
  buyerFv: number;
  sellerFv: number;
  publicFv: number;
  restingQuoteId: string;
  restingBid: number;
  restingAsk: number;
  restingFvAtPost: number;
}

/** Quote changes, logged with the player's state at the time. Trades are logged separately. */
export interface Decision {
  at: number;
  playerId: string;
  kind: 'quote' | 'pull';
  bid?: number;
  ask?: number;
  size?: number;
  fv: number;
  publicFv: number;
  position: number;
}

export interface QuoteSides {
  bid: number;
  ask: number;
  bidSize: number;
  askSize: number;
}

/** An information drop or shock, with every participant's fair value right after it. */
export interface InfoEvent {
  at: number;
  kind: 'stage' | 'shock';
  stage?: number;
  shock?: ShockId;
  publicNew: number[];
  fvAfter: Record<string, number>;
  publicFvAfter: number;
  quotes: Record<string, QuoteSides>;
  positions: Record<string, number>;
}

export interface ScheduledEvent {
  frac: number;
  at: number | null;
  kind: 'stage' | 'shock';
  stage?: number;
  shock?: ShockId;
  done: boolean;
}

export interface Round {
  number: number;
  type: RoundType;
  seed: number;
  contract: number[];
  /** Cards not in the contract, in shuffled order; extra-card shocks draw from here. */
  spare: number[];
  /** The original contract cards in the order they become public. */
  publicOrder: number[];
  revealed: number;
  rule: ValueRule;
  shocks: { at: number; id: ShockId }[];
  privateCards: Record<string, number[]>;
  roles: Record<string, Role>;
  insiderId: string | null;
  participants: string[];
  schedule: ScheduledEvent[];
  quotes: Record<string, Quote>;
  positions: Record<string, number>;
  cash: Record<string, number>;
  rebates: Record<string, number>;
  trades: Trade[];
  decisions: Decision[];
  infoEvents: InfoEvent[];
  uptime: Record<string, { ms: number; since: number | null }>;
  startedAt: number | null;
  endsAt: number | null;
  pausedMs: number;
  activeMs: number | null;
  settlement: number | null;
  lastPrice: number | null;
  quoteCooldownMs: number;
  /** When each player last posted a quote (pulling does not reset it). */
  lastQuoteAt: Record<string, number>;
}

export interface RoundResult {
  number: number;
  type: RoundType;
  settlement: number;
  pnl: Record<string, number>;
  volume: number;
  contract: number[];
  rule: ValueRule;
  insiderId: string | null;
}

// ---- wire ----

export type Command =
  | { kind: 'setConfig'; roundTypes?: RoundType[]; briefingMs?: number; marketMs?: number; resultsMs?: number; quoteCooldownMs?: number; revealEveryMs?: number; shockCount?: number }
  | { kind: 'start' }
  | { kind: 'pause' }
  | { kind: 'resume' }
  | { kind: 'advance' }
  | { kind: 'skip' }
  | { kind: 'addBots'; count: number }
  | { kind: 'removePlayer'; playerId: string }
  | { kind: 'setQuote'; bid: number; ask: number; size: number }
  | { kind: 'pullQuote' }
  | { kind: 'trade'; targetId: string; side: Side; qty: number; price: number };

export interface Receipt {
  requestId: string;
  ok: boolean;
  code?: string;
  error?: string;
  message?: string;
}

export interface QuoteView {
  playerId: string;
  bid: number;
  ask: number;
  bidSize: number;
  askSize: number;
  /** Lots actually tradeable after the quoter's position limit. */
  bidAvail: number;
  askAvail: number;
  postedAt: number;
}

export interface TradeView {
  id: string;
  at: number;
  buyerId: string;
  sellerId: string;
  aggressorId: string;
  price: number;
  qty: number;
}

export interface Snapshot {
  serverTime: number;
  revision: number;
  code: string;
  phase: Phase;
  phaseDeadline: number | null;
  paused: boolean;
  pausedRemainingMs: number | null;
  config: RoomConfig;
  you: { kind: 'host' | 'player' | 'spectator'; playerId: string | null };
  players: { id: string; name: string; isBot: boolean; isHost: boolean; spectator: boolean; connected: boolean; total: number }[];
  round: {
    number: number;
    type: RoundType;
    startedAt: number | null;
    endsAt: number | null;
    nextInfoAt: number | null;
    /** When each information stage happens (shock times stay secret). */
    stageTimes: number[];
    contractSize: number;
    publicCards: number[];
    rule: ValueRule;
    shocks: { at: number; id: ShockId }[];
    roles: Record<string, Role>;
    quotes: QuoteView[];
    trades: TradeView[];
    chart: [number, number][];
    publicFvSeries: [number, number][] | null;
    publicFv: number | null;
    volume: number;
    lastPrice: number | null;
    /** Revealed at results. */
    contract: number[] | null;
    settlement: number | null;
    insiderId: string | null;
    privateHolders: Record<number, number> | null;
  } | null;
  me: {
    role: Role;
    privateCards: number[];
    position: number;
    cash: number;
    rebates: number;
    /** Only revealed once the round settles: players work out fair value themselves. */
    fv: number | null;
    nextQuoteAt: number | null;
    quote: Quote | null;
    uptimeMs: number;
    isInsider: boolean;
  } | null;
  results: RoundResult[];
  reviews: PlayerRoundReview[];
  host: {
    positions: { playerId: string; position: number; live: boolean }[];
    quoting: number;
  } | null;
}

export type ClientMessage =
  | { t: 'hello'; code: string; token?: string; asHost?: boolean }
  | { t: 'cmd'; requestId: string; cmd: Command }
  | { t: 'ping'; clientTime: number };

export type ServerMessage =
  | { t: 'snapshot'; data: Snapshot }
  | { t: 'receipt'; receipt: Receipt }
  | { t: 'pong'; clientTime: number; serverTime: number }
  | { t: 'error'; error: string };
