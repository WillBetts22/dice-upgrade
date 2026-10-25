import type { RoundReviewInput } from '../../shared/review.js';
import type { RoomState, RoundState } from './state.js';

/** Everything the decision analyzer needs about a finished round, taken from server state. */
export function buildReviewInput(room: RoomState, round: RoundState, now: number): RoundReviewInput {
  const orders = [...round.closedOrders, ...Object.values(round.openOrders)].map((o) => ({ ...o, closedAt: o.closedAt ?? null }));
  const finalHighs: RoundReviewInput['finalHighs'] = {};
  for (const t of round.pool) finalHighs[t] = round.upgrades[t]?.highPrice ?? null;
  return {
    roundId: round.id,
    roundNumber: round.number,
    pool: round.pool.slice(),
    players: Object.values(round.accounts).map((a) => ({
      id: a.playerId,
      name: room.players[a.playerId]?.name ?? '?',
      startingUpgrade: a.startingUpgrade,
    })),
    trades: round.trades.slice(),
    orders,
    decisions: round.decisions.slice(),
    settlements: round.settlements.slice(),
    finalHighs,
    dice: { ...round.dice },
    marketClosedAt: round.marketClosedAt ?? now,
  };
}
