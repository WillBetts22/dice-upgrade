import type { UpgradeId } from './catalog.js';
import type { DiceResultRecord, Order, SettlementLine, Side, Trade } from './types.js';

// Shared contract for decision tracking (server) and decision review (analysis + UI).

/** One accepted player decision, logged with the player's state just before it. */
export interface DecisionEvent {
  id: string;
  roundId: string;
  playerId: string;
  /** Room revision this decision committed at; orders decisions in time. */
  revision: number;
  at: number;
  kind: 'order' | 'accept' | 'cancel' | 'equip' | 'equip_final';
  /** order: the posted limit order. */
  order?: { orderId: string; type: UpgradeId; side: Side; price: number; qty: number };
  /** accept: the quote taken. takerSide is what the decider did (bid = bought). */
  accept?: { orderId: string; type: UpgradeId; takerSide: Side; price: number; qty: number };
  /** cancel: the order removed. */
  cancel?: { orderId: string; type: UpgradeId; side: Side; price: number; remaining: number };
  /** equip: a submitted selection. equip_final: what was actually used; auto = filled by the timeout rule. */
  equip?: { types: UpgradeId[]; auto: boolean };
  before: {
    cash: number;
    spendable: number;
    positions: Partial<Record<UpgradeId, number>>;
    highs: Partial<Record<UpgradeId, number | null>>;
  };
  /** Trades this decision executed immediately. Later passive fills of a resting order are found via Trade.restingOrderId. */
  tradeIds: string[];
}

/** Everything the analyzer needs about one finished round. All of it is server data, already persisted. */
export interface RoundReviewInput {
  roundId: string;
  roundNumber: number;
  pool: UpgradeId[];
  players: { id: string; name: string; startingUpgrade: UpgradeId }[];
  trades: Trade[];
  /** All orders of the round including filled, cancelled and closed ones. closedAt is null while open. */
  orders: (Order & { closedAt: number | null })[];
  decisions: DecisionEvent[];
  settlements: SettlementLine[];
  finalHighs: Partial<Record<UpgradeId, number | null>>;
  dice: Record<string, DiceResultRecord>;
  marketClosedAt: number;
}

export type Verdict = 'good' | 'ok' | 'bad' | 'info';

export interface ReviewItem {
  at: number;
  kind: 'buy' | 'sell' | 'short' | 'cover' | 'equip' | 'missed_cover' | 'dead_inventory' | 'unfilled' | 'cancel';
  title: string;
  detail: string;
  /** EV change using only information available at the decision (high at that time). Null if not applicable. */
  evExAnte: number | null;
  /** EV change using the final round high for short deductions. Null if not applicable. */
  evExPost: number | null;
  verdict: Verdict;
  /** What a better decision would have been, when there was one. */
  better?: string;
  tradeId?: string;
  /** Short fully bought back: net coins of the whole round trip (sale price minus buy-back prices). */
  roundTrip?: number;
  /** A buy that closed (part of) an earlier short; the short's row carries the round-trip result. */
  coversShort?: boolean;
}

export interface PlayerRoundReview {
  roundId: string;
  roundNumber: number;
  playerId: string;
  items: ReviewItem[];
  /**
   * Exact identity: score = startValue + tradingEV - equipmentLoss + luck, where
   * startValue = 100 + V(starting upgrade), tradingEV = sum of trade evExPost,
   * equipmentLoss = V(final owned set) - mu(equipped), luck = payout - mu(equipped).
   */
  summary: {
    startValue: number;
    tradingEV: number;
    equipmentLoss: number;
    luck: number;
    score: number;
    expectedPayoutEquipped: number;
    bestPossiblePair: UpgradeId[];
  };
}
