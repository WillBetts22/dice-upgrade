import type { PlayerRoundReview, RoundReviewInput } from './review.js';

// Stage 0 stub. Stage 2 replaces the body with the real EV analyzer; the signature is fixed.
export function analyzeRound(input: RoundReviewInput): PlayerRoundReview[] {
  return input.players.map((p) => ({
    roundId: input.roundId,
    roundNumber: input.roundNumber,
    playerId: p.id,
    items: [],
    summary: { startValue: 0, tradingEV: 0, equipmentLoss: 0, luck: 0, score: input.dice[p.id]?.score ?? 0, expectedPayoutEquipped: 0, bestPossiblePair: [] },
  }));
}
