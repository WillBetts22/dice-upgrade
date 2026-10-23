import type { UpgradeId } from '../shared/catalog.js';
import type { PlayerRoundReview } from '../shared/review.js';
import type { HostInfo, MarketDelta, PublicOrder, PublicPlayer, PublicRound, Snapshot } from '../shared/types.js';
import { estimatedDeduction, owedUnits, privateAccount } from './engine/market.js';
import { leaderboard } from './engine/rounds.js';
import type { Actor } from './engine/room.js';
import type { Changes, Player, RoomState, RoundState } from './engine/state.js';

// Nothing in this file may expose session hashes, the host credential, or deal seeds.

export function publicPlayer(p: Player, connected: boolean): PublicPlayer {
  return { id: p.id, name: p.name, isHost: p.isHost, isBot: p.isBot, role: p.role, ready: p.ready, connected };
}

function bookFor(round: RoundState, type: UpgradeId): PublicOrder[] {
  return Object.values(round.openOrders)
    .filter((o) => o.type === type)
    .sort((a, b) => a.seq - b.seq)
    .map((o) => ({ id: o.id, playerId: o.playerId, type: o.type, side: o.side, price: o.price, remaining: o.remaining, seq: o.seq }));
}

function holdingsFor(round: RoundState, playerId: string): Partial<Record<UpgradeId, number>> {
  const acct = round.accounts[playerId];
  const out: Partial<Record<UpgradeId, number>> = {};
  for (const t of round.pool) out[t] = acct.positions[t];
  return out;
}

function diceVisible(phase: RoomState['phase']): boolean {
  return phase === 'reveal' || phase === 'results' || phase === 'finished';
}

function publicRound(room: RoomState, round: RoundState): PublicRound {
  const books: Record<string, PublicOrder[]> = {};
  const holdings: Record<string, Partial<Record<UpgradeId, number>>> = {};
  for (const t of round.pool) books[t] = bookFor(round, t);
  for (const pid of Object.keys(round.accounts)) holdings[pid] = holdingsFor(round, pid);
  return {
    id: round.id,
    number: round.number,
    pool: round.pool.slice(),
    books,
    holdings,
    upgrades: structuredClone(round.upgrades),
    tape: round.trades.slice(),
    dice: diceVisible(room.phase) ? { ...round.dice } : null,
    submittedCount: Object.values(round.accounts).filter((a) => a.equipmentSubmitted).length,
  };
}

export function hostInfo(room: RoomState): HostInfo {
  const round = room.round;
  const exposure: HostInfo['exposure'] = [];
  const owedByType: HostInfo['owedByType'] = {};
  if (round) {
    for (const acct of Object.values(round.accounts)) {
      const owed = owedUnits(acct);
      if (owed > 0) exposure.push({ playerId: acct.playerId, owedUnits: owed, estimatedDeduction: estimatedDeduction(round, acct).amount });
      for (const t of round.pool) if (acct.positions[t] < 0) owedByType[t] = (owedByType[t] ?? 0) - acct.positions[t];
    }
  }
  const hp = Object.values(room.players).find((p) => p.isHost);
  return { exposure, owedByType, hostPlayerId: hp?.id ?? null };
}

/**
 * Reviews exist only for completed rounds. A player sees only their own; the
 * host sees everyone's once the session is finished; spectators see none.
 */
export function visibleReviews(room: RoomState, actor: Actor): PlayerRoundReview[] {
  if (actor.kind === 'host') return room.phase === 'finished' ? room.reviews.slice() : [];
  if (actor.kind !== 'player') return [];
  const mine = room.reviews.filter((r) => r.playerId === actor.playerId);
  // Keep snapshots small: results shows only the round just played; finished shows all.
  if (room.phase === 'finished') return mine;
  if (room.phase === 'results') return mine.filter((r) => r.roundNumber === room.roundNumber);
  return [];
}

export function buildSnapshot(room: RoomState, actor: Actor, now: number, isConnected: (pid: string) => boolean): Snapshot {
  const playerId = actor.kind === 'player' ? actor.playerId : null;
  return {
    roomId: room.id,
    code: room.code,
    phase: room.phase,
    paused: room.pausedRemainingMs !== null,
    pausedRemainingMs: room.pausedRemainingMs,
    phaseDeadline: room.phaseDeadline,
    serverTime: now,
    revision: room.revision,
    config: structuredClone(room.config),
    roundNumber: room.roundNumber,
    players: Object.values(room.players)
      .sort((a, b) => a.joinedAt - b.joinedAt)
      .map((p) => publicPlayer(p, isConnected(p.id))),
    round: room.round ? publicRound(room, room.round) : null,
    completedRounds: room.completedRounds,
    leaderboard: leaderboard(room),
    you: { kind: actor.kind, playerId },
    account: playerId && room.round ? privateAccount(room.round, playerId) : null,
    host: actor.kind === 'host' ? hostInfo(room) : null,
    reviews: visibleReviews(room, actor),
  };
}

export function buildDelta(room: RoomState, changes: Changes, isConnected: (pid: string) => boolean): MarketDelta {
  const round = room.round;
  const delta: MarketDelta = { books: {}, trades: changes.trades, holdings: {}, upgrades: {}, players: [] };
  if (round) {
    for (const t of changes.bookTypes) delta.books[t] = bookFor(round, t);
    for (const pid of changes.accounts) if (round.accounts[pid]) delta.holdings[pid] = holdingsFor(round, pid);
    for (const t of changes.upgrades) delta.upgrades[t] = { ...round.upgrades[t] };
    delta.submittedCount = Object.values(round.accounts).filter((a) => a.equipmentSubmitted).length;
  }
  for (const pid of changes.players) {
    const p = room.players[pid];
    if (p) delta.players.push(publicPlayer(p, isConnected(pid)));
  }
  return delta;
}
