import { getPoolVersion } from '../../shared/catalog.js';
import type { DrawFn } from '../../shared/dice.js';
import { MAX_PLAYERS, MAX_ROUNDS, MIN_PLAYERS, MIN_ROUNDS, type Phase, type PhaseDurations } from '../../shared/rules.js';
import { analyzeRound } from '../../shared/analysis.js';
import type { DecisionEvent } from '../../shared/review.js';
import type { Command } from '../../shared/types.js';
import { acceptQuote, cancelOrder, placeLimitOrder, reservedForBids } from './market.js';
import {
  closeMarket,
  createRound,
  preselectEquipment,
  resolveRound,
  settleShorts,
  summarizeRound,
  tradingPlayers,
  validateEquipment,
} from './rounds.js';
import { buildReviewInput } from './review-input.js';
import { type Ctx, EngineError, type Player, type RoomState, type RoundState } from './state.js';

export type Actor = { kind: 'host' } | { kind: 'player'; playerId: string } | { kind: 'spectator' };

export interface Env {
  /** Fresh private seed for a round's pool selection and deal. */
  dealSeed: () => number;
  /** Private dice source for one player; draws only as many faces as equipped effects need. */
  drawFor: (roomId: string, roundId: string, playerId: string) => DrawFn;
}

const TIMED: Phase[] = ['market', 'selection', 'reveal', 'results'];

export function sanitizeName(raw: unknown): { name: string; key: string } {
  if (typeof raw !== 'string') throw new EngineError('invalid_name', 'Enter a display name.');
  const name = raw
    .normalize('NFKC')
    .replace(/[\p{C}<>]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 20);
  if (name.length < 1) throw new EngineError('invalid_name', 'Enter a display name.');
  return { name, key: name.toLowerCase() };
}

export function joinRoom(
  room: RoomState,
  args: { name: unknown; sessionHash: string; isHost: boolean; isBot?: boolean },
  ctx: Ctx,
): Player {
  const existing = Object.values(room.players).find((p) => p.sessionHash === args.sessionHash);
  if (existing) return existing; // reconnect: never a second identity
  const { name, key } = sanitizeName(args.name);
  if (Object.values(room.players).some((p) => p.nameKey === key)) {
    throw new EngineError('duplicate_name', 'That name is taken in this room. Pick another.');
  }
  const traders = tradingPlayers(room).length;
  const role: Player['role'] = room.rosterFrozen || traders >= MAX_PLAYERS ? 'spectator' : 'player';
  const p: Player = {
    id: ctx.newId(),
    roomId: room.id,
    name,
    nameKey: key,
    sessionHash: args.sessionHash,
    isHost: args.isHost,
    isBot: !!args.isBot,
    role,
    ready: false,
    connected: false,
    dealHistory: [],
    joinedAt: ctx.now,
  };
  room.players[p.id] = p;
  ctx.changes.players.add(p.id);
  ctx.changes.full = true;
  ctx.changes.message = role === 'player' ? `Joined as ${name}.` : `Joined as spectator ${name}; the roster is ${room.rosterFrozen ? 'frozen' : 'full'}.`;
  return p;
}

function requireHost(actor: Actor): void {
  if (actor.kind !== 'host') throw new EngineError('forbidden', 'Only the host can do that.');
}

function requirePlayer(room: RoomState, actor: Actor): string {
  if (actor.kind !== 'player' || room.players[actor.playerId]?.role !== 'player') {
    throw new EngineError('forbidden', 'Only players in this room can do that.');
  }
  return actor.playerId;
}

function requirePhase(room: RoomState, phase: Phase, now: number): void {
  if (room.phase !== phase) throw new EngineError('wrong_phase', `That is only allowed during ${phase}.`);
  if (room.pausedRemainingMs !== null) throw new EngineError('paused', 'The host has paused the game.');
  if (room.phaseDeadline !== null && now >= room.phaseDeadline) throw new EngineError('deadline', 'Time is up for this phase.');
}

function validateDurations(d: Partial<PhaseDurations>, base: PhaseDurations): PhaseDurations {
  const out = { ...base };
  const bounds: Record<keyof PhaseDurations, [number, number]> = {
    marketMs: [30_000, 30 * 60_000],
    selectionMs: [10_000, 10 * 60_000],
    revealMs: [10_000, 10 * 60_000],
    resultsMs: [10_000, 10 * 60_000],
  };
  for (const k of Object.keys(bounds) as (keyof PhaseDurations)[]) {
    const v = d[k];
    if (v === undefined) continue;
    const [lo, hi] = bounds[k];
    if (typeof v !== 'number' || !Number.isInteger(v) || v < lo || v > hi) {
      throw new EngineError('invalid_input', `${k} must be between ${lo / 1000}s and ${hi / 1000}s.`);
    }
    out[k] = v;
  }
  return out;
}

/** Apply one authenticated command to a draft room. Throws EngineError to reject. */
export function applyCommand(room: RoomState, actor: Actor, cmd: Command, ctx: Ctx, env: Env): void {
  const now = ctx.now;
  switch (cmd.kind) {
    case 'setConfig': {
      requireHost(actor);
      if (room.phase !== 'lobby') throw new EngineError('wrong_phase', 'Settings lock when the session starts.');
      if (cmd.rounds !== undefined) {
        if (!Number.isInteger(cmd.rounds) || cmd.rounds < MIN_ROUNDS || cmd.rounds > MAX_ROUNDS) {
          throw new EngineError('invalid_input', `Rounds must be ${MIN_ROUNDS} to ${MAX_ROUNDS}.`);
        }
        room.config.rounds = cmd.rounds;
      }
      if (cmd.durations) {
        if (!room.config.devMode && cmd.durations.marketMs !== undefined && cmd.durations.marketMs < 60_000) {
          throw new EngineError('invalid_input', 'Market must be at least one minute outside test mode.');
        }
        room.config.durations = validateDurations(cmd.durations, room.config.durations);
      }
      if (cmd.poolVersion !== undefined) {
        if (!getPoolVersion(cmd.poolVersion)) throw new EngineError('invalid_input', 'Unknown pool version.');
        room.config.poolVersion = cmd.poolVersion;
      }
      ctx.changes.full = true;
      ctx.changes.message = 'Settings saved.';
      return;
    }
    case 'setReady': {
      const pid = requirePlayer(room, actor);
      if (room.phase !== 'lobby') throw new EngineError('wrong_phase', 'Readiness only matters in the lobby.');
      room.players[pid].ready = !!cmd.ready;
      ctx.changes.players.add(pid);
      ctx.changes.full = true;
      return;
    }
    case 'removePlayer': {
      requireHost(actor);
      const p = room.players[cmd.playerId];
      if (!p) throw new EngineError('not_found', 'No such player.');
      if (room.rosterFrozen && p.role === 'player') {
        throw new EngineError('forbidden', 'Active players with positions cannot be removed once the session starts.');
      }
      delete room.players[cmd.playerId];
      ctx.changes.players.add(cmd.playerId);
      ctx.changes.full = true;
      ctx.changes.data = { removed: cmd.playerId };
      return;
    }
    case 'devAddBots': {
      requireHost(actor);
      if (!room.config.devMode) throw new EngineError('forbidden', 'Bots are only available in a host-enabled test room.');
      if (room.phase !== 'lobby') throw new EngineError('wrong_phase', 'Add bots in the lobby.');
      const n = Math.max(1, Math.min(MAX_PLAYERS, Math.floor(cmd.count)));
      const added: string[] = [];
      for (let i = 0; i < n && tradingPlayers(room).length < MAX_PLAYERS; i++) {
        let k = Object.values(room.players).filter((p) => p.isBot).length + 1;
        while (Object.values(room.players).some((p) => p.nameKey === `bot ${k}`)) k++;
        const p = joinRoom(room, { name: `Bot ${k}`, sessionHash: `bot:${ctx.newId()}`, isHost: false, isBot: true }, ctx);
        p.ready = true;
        added.push(p.id);
      }
      ctx.changes.data = { added };
      ctx.changes.message = `Added ${added.length} bots.`;
      return;
    }
    case 'startSession': {
      requireHost(actor);
      if (room.phase !== 'lobby') throw new EngineError('wrong_phase', 'The session has already started.');
      const n = tradingPlayers(room).length;
      if (n < MIN_PLAYERS) throw new EngineError('too_few', `At least ${MIN_PLAYERS} players are needed to start.`);
      room.rosterFrozen = true;
      startRound(room, 1, ctx, env);
      ctx.changes.message = 'Session started.';
      return;
    }
    case 'placeLimitOrder': {
      const pid = requirePlayer(room, actor);
      requirePhase(room, 'market', now);
      const before = decisionBefore(room.round!, pid);
      const { order, trades } = placeLimitOrder(room.round!, pid, cmd, ctx);
      logDecision(room, pid, ctx, before!, {
        kind: 'order',
        order: { orderId: order.id, type: order.type, side: order.side, price: order.price, qty: order.originalQty },
        tradeIds: trades.map((t) => t.id),
      });
      return;
    }
    case 'acceptQuote': {
      const pid = requirePlayer(room, actor);
      requirePhase(room, 'market', now);
      const before = decisionBefore(room.round!, pid);
      const trade = acceptQuote(room.round!, pid, cmd, ctx);
      logDecision(room, pid, ctx, before!, {
        kind: 'accept',
        accept: { orderId: trade.restingOrderId, type: trade.type, takerSide: trade.buyerId === pid ? 'bid' : 'ask', price: trade.price, qty: trade.qty },
        tradeIds: [trade.id],
      });
      return;
    }
    case 'cancelOrder': {
      const pid = requirePlayer(room, actor);
      requirePhase(room, 'market', now);
      const before = decisionBefore(room.round!, pid);
      const o = cancelOrder(room.round!, pid, cmd.orderId, ctx);
      logDecision(room, pid, ctx, before!, {
        kind: 'cancel',
        cancel: { orderId: o.id, type: o.type, side: o.side, price: o.price, remaining: o.remaining },
        tradeIds: [],
      });
      return;
    }
    case 'selectEquipment': {
      const pid = requirePlayer(room, actor);
      requirePhase(room, 'selection', now);
      const acct = room.round!.accounts[pid];
      if (!acct) throw new EngineError('not_trader', 'You are not in this round.');
      const before = decisionBefore(room.round!, pid)!;
      acct.equipment = validateEquipment(room.round!, acct, cmd.types);
      acct.equipmentSubmitted = true;
      acct.revision++;
      ctx.changes.accounts.add(pid);
      logDecision(room, pid, ctx, before, { kind: 'equip', equip: { types: acct.equipment.slice(), auto: false }, tradeIds: [] });
      ctx.changes.message = acct.equipment.length ? 'Equipment saved.' : 'Slots cleared; the fallback rule will fill them.';
      return;
    }
    case 'pauseRoom': {
      requireHost(actor);
      if (!TIMED.includes(room.phase)) throw new EngineError('wrong_phase', 'Nothing to pause right now.');
      if (room.pausedRemainingMs !== null) throw new EngineError('paused', 'Already paused.');
      room.pausedRemainingMs = Math.max(0, (room.phaseDeadline ?? now) - now);
      room.phaseDeadline = null;
      ctx.changes.full = true;
      ctx.changes.message = 'Paused.';
      return;
    }
    case 'resumeRoom': {
      requireHost(actor);
      if (room.pausedRemainingMs === null) throw new EngineError('wrong_phase', 'The game is not paused.');
      room.phaseDeadline = now + room.pausedRemainingMs;
      room.pausedRemainingMs = null;
      ctx.changes.full = true;
      ctx.changes.message = 'Resumed.';
      return;
    }
    case 'advanceResults': {
      requireHost(actor);
      if (room.phase !== 'results') throw new EngineError('wrong_phase', 'You can only advance from completed results.');
      if (room.pausedRemainingMs !== null) throw new EngineError('paused', 'Resume first.');
      room.phaseDeadline = now;
      ctx.changes.full = true;
      return;
    }
    case 'devSkipPhase': {
      requireHost(actor);
      if (!room.config.devMode) throw new EngineError('forbidden', 'Skipping phases requires a test room.');
      if (!TIMED.includes(room.phase) || room.pausedRemainingMs !== null) throw new EngineError('wrong_phase', 'Nothing to skip.');
      room.phaseDeadline = now;
      ctx.changes.full = true;
      return;
    }
    default:
      throw new EngineError('invalid_input', 'Unknown command.');
  }
}

/** The decider's state just before a decision. Null when they have no account (the engine then rejects). */
function decisionBefore(round: RoundState, playerId: string): DecisionEvent['before'] | null {
  const acct = round.accounts[playerId];
  if (!acct) return null;
  const positions: DecisionEvent['before']['positions'] = {};
  const highs: DecisionEvent['before']['highs'] = {};
  for (const t of round.pool) {
    positions[t] = acct.positions[t];
    highs[t] = round.upgrades[t]?.highPrice ?? null;
  }
  return { cash: acct.cash, spendable: acct.cash - reservedForBids(round, playerId), positions, highs };
}

/** Record an accepted decision; it commits at the next revision together with the command. */
function logDecision(
  room: RoomState,
  playerId: string,
  ctx: Ctx,
  before: DecisionEvent['before'],
  rest: Omit<DecisionEvent, 'id' | 'roundId' | 'playerId' | 'revision' | 'at' | 'before'>,
): void {
  ctx.changes.decisions.push({
    id: ctx.newId(),
    roundId: room.round!.id,
    playerId,
    revision: room.revision + 1,
    at: ctx.now,
    before,
    ...rest,
  });
}

const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));

function startRound(room: RoomState, number: number, ctx: Ctx, env: Env): void {
  if (room.round && room.round.number >= number) throw new Error('round already created');
  room.roundNumber = number;
  room.round = createRound(room, number, env.dealSeed(), ctx);
  room.phase = 'market';
  room.phaseDeadline = ctx.now + room.config.durations.marketMs;
  ctx.changes.full = true;
}

/**
 * Advance one phase step if the persisted deadline has passed. Each step is
 * its own serialized transaction, so a restart resumes exactly where it stopped.
 * Returns false when nothing is due.
 */
export function advancePhase(room: RoomState, ctx: Ctx, env: Env): boolean {
  const now = ctx.now;
  if (room.pausedRemainingMs !== null) return false;
  const d = room.config.durations;
  const due = room.phaseDeadline !== null && now >= room.phaseDeadline;
  const round = room.round;

  switch (room.phase) {
    case 'market':
      if (!due) return false;
      // Block trading and cancel outstanding orders in the same step.
      room.phase = 'settling';
      closeMarket(round!, ctx);
      round!.marketClosedAt = now;
      ctx.changes.roundUpdated = true;
      room.phaseDeadline = now + d.selectionMs;
      break;
    case 'settling':
      // Settlement runs immediately, inside the selection allowance.
      settleShorts(round!, ctx);
      preselectEquipment(round!, ctx);
      room.phase = 'selection';
      break;
    case 'selection':
      if (!due) return false;
      {
        const submitted = new Map<string, string[] | null>();
        const befores = new Map<string, DecisionEvent['before']>();
        for (const a of Object.values(round!.accounts)) {
          submitted.set(a.playerId, a.equipmentSubmitted ? a.equipment.slice() : null);
          befores.set(a.playerId, decisionBefore(round!, a.playerId)!);
        }
        resolveRound(round!, (pid) => env.drawFor(room.id, round!.id, pid), ctx);
        // One equip_final per newly resolved player; auto when the timeout rule chose or changed the slots.
        for (const d of ctx.changes.dice) {
          const used = d.resolution.equipment;
          const sub = submitted.get(d.playerId) ?? null;
          logDecision(room, d.playerId, ctx, befores.get(d.playerId)!, {
            kind: 'equip_final',
            equip: { types: used.slice(), auto: sub === null || !sameSet(sub, used) },
            tradeIds: [],
          });
        }
      }
      room.phase = 'reveal';
      room.phaseDeadline = now + d.revealMs;
      break;
    case 'reveal':
      if (!due) return false;
      if (!room.completedRounds.some((r) => r.number === round!.number)) {
        room.completedRounds = [...room.completedRounds, summarizeRound(room, round!)];
      }
      if (!room.reviews.some((r) => r.roundId === round!.id)) {
        // A review failure must never block the game: log it and advance without reviews.
        try {
          const reviews = analyzeRound(buildReviewInput(room, round!, now));
          room.reviews = [...room.reviews, ...reviews];
          ctx.changes.reviews.push(...reviews);
        } catch (e) {
          console.error('decision review failed', round!.id, e);
        }
      }
      room.phase = 'results';
      room.phaseDeadline = now + d.resultsMs;
      break;
    case 'results':
      if (!due) return false;
      if (room.completedRounds.length < room.config.rounds) {
        startRound(room, room.roundNumber + 1, ctx, env);
      } else {
        room.phase = 'finished';
        room.phaseDeadline = null;
      }
      break;
    default:
      return false;
  }
  ctx.changes.full = true;
  return true;
}
