import type { UpgradeId } from './catalog.js';
import type { DiceResolution } from './dice.js';
import type { Phase, PhaseDurations } from './rules.js';

export type Side = 'bid' | 'ask';
export type OrderStatus = 'open' | 'filled' | 'cancelled' | 'closed';

export interface RoomConfig {
  rounds: number;
  durations: PhaseDurations;
  poolVersion: string;
  /** Host-enabled test mode: allows bots and skipping phases. */
  devMode: boolean;
}

export interface Order {
  id: string;
  roundId: string;
  playerId: string;
  type: UpgradeId;
  side: Side;
  price: number;
  originalQty: number;
  remaining: number;
  seq: number;
  status: OrderStatus;
  createdAt: number;
}

export interface Trade {
  id: string;
  roundId: string;
  type: UpgradeId;
  buyerId: string;
  sellerId: string;
  restingOrderId: string;
  /** Null for direct quote acceptance. */
  incomingOrderId: string | null;
  price: number;
  qty: number;
  seq: number;
  kind: 'match' | 'accept';
  /** True when this execution raised the round high. */
  raisedHigh: boolean;
  createdAt: number;
}

export interface UpgradeRoundState {
  type: UpgradeId;
  lastPrice: number | null;
  highPrice: number | null;
  volume: number;
  initialSupply: number;
  shortCloseouts: number;
}

export interface RoundAccount {
  playerId: string;
  cash: number;
  shortDeductions: number;
  startingUpgrade: UpgradeId;
  positions: Record<UpgradeId, number>;
  equipment: UpgradeId[];
  equipmentSubmitted: boolean;
  revision: number;
}

export interface SettlementLine {
  playerId: string;
  type: UpgradeId;
  units: number;
  closeoutPrice: number;
  deduction: number;
  bankUnits: number;
  fallbackPrice: boolean;
}

export interface DiceResultRecord {
  playerId: string;
  resolution: DiceResolution;
  tradingCash: number;
  shortDeductions: number;
  score: number;
}

export interface DealEntry {
  round: number;
  type: UpgradeId;
  value: number;
}

export interface LedgerEntry {
  roundId: string | null;
  playerId: string | null;
  kind: 'endowment_cash' | 'endowment_unit' | 'trade_cash' | 'trade_unit' | 'bank_issue' | 'score_deduction' | 'dice_payout';
  cashDelta: number;
  type: UpgradeId | null;
  positionDelta: number;
  scoreDelta: number;
  ref: string | null;
}

export interface PlayerResultRow {
  playerId: string;
  name: string;
  tradingCash: number;
  dicePayout: number;
  shortDeductions: number;
  roundScore: number;
  netTradingResult: number;
  equipment: UpgradeId[];
}

export interface UpgradeResultRow {
  type: UpgradeId;
  highPrice: number | null;
  lastPrice: number | null;
  volume: number;
  shortCloseouts: number;
}

export interface CompletedRound {
  number: number;
  pool: UpgradeId[];
  players: PlayerResultRow[];
  upgrades: UpgradeResultRow[];
}

// ---------------------------------------------------------------- snapshots

export interface PublicPlayer {
  id: string;
  name: string;
  isHost: boolean;
  isBot: boolean;
  role: 'player' | 'spectator';
  ready: boolean;
  connected: boolean;
}

export interface PublicOrder {
  id: string;
  playerId: string;
  type: UpgradeId;
  side: Side;
  price: number;
  remaining: number;
  seq: number;
}

export interface PublicRound {
  id: string;
  number: number;
  pool: UpgradeId[];
  books: Record<string, PublicOrder[]>;
  holdings: Record<string, Partial<Record<UpgradeId, number>>>;
  upgrades: Record<string, UpgradeRoundState>;
  tape: Trade[];
  /** Present from Reveal onward. */
  dice: Record<string, DiceResultRecord> | null;
  submittedCount: number;
}

export interface PrivateAccount {
  playerId: string;
  cash: number;
  reservedForBids: number;
  spendable: number;
  positions: Record<UpgradeId, number>;
  owedUnits: number;
  worstCaseShortUnits: number;
  estimatedDeduction: number;
  estimateProvisional: boolean;
  shortDeductions: number;
  startingUpgrade: UpgradeId;
  equipment: UpgradeId[];
  equipmentSubmitted: boolean;
  settlement: SettlementLine[];
}

export interface Leaderboard {
  rows: { playerId: string; name: string; total: number; rank: number; perRound: (number | null)[] }[];
}

export interface Snapshot {
  roomId: string;
  code: string;
  phase: Phase;
  paused: boolean;
  pausedRemainingMs: number | null;
  phaseDeadline: number | null;
  serverTime: number;
  revision: number;
  config: RoomConfig;
  roundNumber: number;
  players: PublicPlayer[];
  round: PublicRound | null;
  completedRounds: CompletedRound[];
  leaderboard: Leaderboard;
  you: { kind: 'host' | 'player' | 'spectator'; playerId: string | null };
  account: PrivateAccount | null;
  host: HostInfo | null;
}

export interface HostInfo {
  exposure: { playerId: string; owedUnits: number; estimatedDeduction: number }[];
  owedByType: Partial<Record<UpgradeId, number>>;
  hostPlayerId: string | null;
}

export interface MarketDelta {
  books: Record<string, PublicOrder[]>;
  trades: Trade[];
  holdings: Record<string, Partial<Record<UpgradeId, number>>>;
  upgrades: Record<string, UpgradeRoundState>;
  players: PublicPlayer[];
  submittedCount?: number;
}

// ---------------------------------------------------------------- commands

export type Command =
  | { kind: 'startSession' }
  | { kind: 'setConfig'; rounds?: number; durations?: Partial<PhaseDurations>; poolVersion?: string }
  | { kind: 'setReady'; ready: boolean }
  | { kind: 'placeLimitOrder'; type: UpgradeId; side: Side; price: number; qty: number }
  | { kind: 'acceptQuote'; orderId: string; expectedRemaining: number; qty: number }
  | { kind: 'cancelOrder'; orderId: string }
  | { kind: 'selectEquipment'; types: UpgradeId[] }
  | { kind: 'pauseRoom' }
  | { kind: 'resumeRoom' }
  | { kind: 'advanceResults' }
  | { kind: 'devSkipPhase' }
  | { kind: 'devAddBots'; count: number }
  | { kind: 'removePlayer'; playerId: string };

export type CommandKind = Command['kind'];

export interface Receipt {
  requestId: string;
  ok: boolean;
  error?: string;
  code?: string;
  revision: number;
  /** Short human-readable confirmation, e.g. "Bought 1 Extra Die at 12". */
  message?: string;
  data?: unknown;
}

// ---------------------------------------------------------------- wire

export type ClientMessage =
  | { t: 'hello'; code: string; token?: string; asHost?: boolean }
  | { t: 'cmd'; requestId: string; cmd: Command }
  | { t: 'snapshot' }
  | { t: 'ping'; clientTime: number };

export type ServerMessage =
  | { t: 'snapshot'; data: Snapshot }
  | { t: 'update'; rev: number; serverTime: number; delta: MarketDelta; account: PrivateAccount | null; host: HostInfo | null }
  | { t: 'receipt'; receipt: Receipt }
  | { t: 'pong'; clientTime: number; serverTime: number }
  | { t: 'presence'; connected: string[] }
  | { t: 'error'; error: string };
