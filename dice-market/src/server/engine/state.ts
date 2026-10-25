import type { UpgradeId } from '../../shared/catalog.js';
import type {
  CompletedRound,
  DealEntry,
  DiceResultRecord,
  LedgerEntry,
  Order,
  RoomConfig,
  RoundAccount,
  SettlementLine,
  Trade,
  UpgradeRoundState,
} from '../../shared/types.js';
import type { Phase } from '../../shared/rules.js';
import type { DecisionEvent, PlayerRoundReview } from '../../shared/review.js';

export interface Player {
  id: string;
  roomId: string;
  name: string;
  nameKey: string;
  sessionHash: string;
  isHost: boolean;
  isBot: boolean;
  role: 'player' | 'spectator';
  ready: boolean;
  connected: boolean;
  dealHistory: DealEntry[];
  joinedAt: number;
}

export interface RoundState {
  id: string;
  roomId: string;
  number: number;
  pool: UpgradeId[];
  /** Private seed used for pool selection and dealing. Never sent to clients. */
  dealSeed: number;
  accounts: Record<string, RoundAccount>;
  /** Only open orders live here; closed orders are persisted and dropped. */
  openOrders: Record<string, Order>;
  /** Append-only; appended after commit, never mutated by the engine directly. */
  trades: Trade[];
  upgrades: Record<string, UpgradeRoundState>;
  settlements: SettlementLine[];
  dice: Record<string, DiceResultRecord>;
  nextSeq: number;
  /** Orders no longer open, append-only (appended after commit) so reviews can see every order. */
  closedOrders: Order[];
  /** Accepted player decisions this round, append-only (appended after commit). */
  decisions: DecisionEvent[];
  /** When the market phase closed; null until then. */
  marketClosedAt: number | null;
}

export interface RoomState {
  id: string;
  code: string;
  hostHash: string;
  config: RoomConfig;
  phase: Phase;
  roundNumber: number;
  phaseDeadline: number | null;
  pausedRemainingMs: number | null;
  revision: number;
  rosterFrozen: boolean;
  createdAt: number;
  players: Record<string, Player>;
  round: RoundState | null;
  completedRounds: CompletedRound[];
  /** Decision reviews for completed rounds, all players. Filtered per viewer in view.ts. */
  reviews: PlayerRoundReview[];
}

export class EngineError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Collects everything a command touched so persistence and broadcast can be precise. */
export class Changes {
  players = new Set<string>();
  accounts = new Set<string>();
  orders = new Map<string, Order>();
  trades: Trade[] = [];
  upgrades = new Set<UpgradeId>();
  settlements: SettlementLine[] = [];
  dice: DiceResultRecord[] = [];
  ledger: LedgerEntry[] = [];
  bookTypes = new Set<UpgradeId>();
  decisions: DecisionEvent[] = [];
  reviews: PlayerRoundReview[] = [];
  /** Round row fields changed (market_closed_at). */
  roundUpdated = false;
  newRound: RoundState | null = null;
  /** Phase-level change: clients receive a full snapshot. */
  full = false;
  message?: string;
  data?: unknown;
}

export interface Ctx {
  now: number;
  changes: Changes;
  newId: () => string;
}

/**
 * Copy the mutable parts of a room so a command can be applied and discarded on
 * failure. Trades are append-only and shared by reference.
 */
export function draftRoom(room: RoomState): RoomState {
  const r = room.round;
  return {
    ...room,
    config: structuredClone(room.config),
    players: structuredClone(room.players),
    completedRounds: room.completedRounds,
    reviews: room.reviews,
    round: r
      ? {
          ...r,
          accounts: structuredClone(r.accounts),
          openOrders: structuredClone(r.openOrders),
          upgrades: structuredClone(r.upgrades),
          settlements: r.settlements.slice(),
          dice: { ...r.dice },
          trades: r.trades,
          closedOrders: r.closedOrders,
          decisions: r.decisions,
        }
      : null,
  };
}
