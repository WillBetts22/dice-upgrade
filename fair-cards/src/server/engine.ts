// Pure game engine: room state in, room state out. No I/O; the manager persists and broadcasts.
import { applyShock, BASE_RULE, DECK, EXTRA_CARDS, fairValue, SHOCK_IDS, settlementValue } from '../shared/cards.js';
import { analyzeRound, type PlayerRoundReview } from '../shared/review.js';
import {
  CONTRACT_SIZE,
  DEFAULT_DURATIONS,
  DEFAULT_QUOTE_COOLDOWN_MS,
  DEFAULT_ROUND_TYPES,
  DURATION_BOUNDS,
  INSIDER_START_CARDS,
  MAKER_REBATE,
  MAKER_WIDTH,
  makerCount,
  MAX_PLAYERS,
  MAX_QUOTE_SIZE,
  MAX_ROUNDS,
  MAX_WIDTH,
  MIN_PLAYERS,
  MIN_ROUNDS,
  POSITION_LIMIT,
  PRICE_MAX,
  PRICE_MIN,
  PRIVATE_SCHEDULE,
  PUBLIC_SCHEDULE,
  QUOTE_COOLDOWN_BOUNDS,
  ROUND_TYPE_IDS,
  SHOCK_FRACTIONS,
  SHOCK_JITTER,
  STAGE_FRACTIONS,
} from '../shared/rules.js';
import type { Command, InfoEvent, Phase, Quote, Role, Round, RoomConfig, RoundResult, ScheduledEvent, Side, Trade } from '../shared/types.js';
import { seededRng, shuffle } from './rng.js';

export class EngineError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface Player {
  id: string;
  name: string;
  nameKey: string;
  sessionHash: string;
  isBot: boolean;
  isHost: boolean;
  spectator: boolean;
  joinedAt: number;
  total: number;
}

export interface RoomState {
  id: string;
  code: string;
  hostHash: string;
  revision: number;
  createdAt: number;
  config: RoomConfig;
  phase: Phase;
  phaseDeadline: number | null;
  pausedAt: number | null;
  players: Record<string, Player>;
  rosterFrozen: boolean;
  roundNumber: number;
  round: Round | null;
  results: RoundResult[];
  reviews: PlayerRoundReview[];
}

export type Actor = { kind: 'host' } | { kind: 'player'; playerId: string } | { kind: 'spectator' };

export interface Ctx {
  now: number;
  newId(): string;
  seed(): number;
}

export function newRoomState(args: { id: string; code: string; hostHash: string; devMode: boolean; now: number }): RoomState {
  return {
    id: args.id,
    code: args.code,
    hostHash: args.hostHash,
    revision: 1,
    createdAt: args.now,
    config: { roundTypes: DEFAULT_ROUND_TYPES.slice(), ...DEFAULT_DURATIONS, devMode: args.devMode, quoteCooldownMs: DEFAULT_QUOTE_COOLDOWN_MS },
    phase: 'lobby',
    phaseDeadline: null,
    pausedAt: null,
    players: {},
    rosterFrozen: false,
    roundNumber: 0,
    round: null,
    results: [],
    reviews: [],
  };
}

// ---------- info ----------

export function knownCards(r: Round, pid: string): number[] {
  const set = new Set(r.publicOrder.slice(0, r.revealed));
  for (const c of r.privateCards[pid] ?? []) set.add(c);
  return [...set];
}

export function playerFv(r: Round, pid: string): number {
  return fairValue(knownCards(r, pid), r.contract.length, r.rule);
}

export function publicFv(r: Round): number {
  return fairValue(r.publicOrder.slice(0, r.revealed), r.contract.length, r.rule);
}

export const isLive = (q: Quote | undefined): q is Quote => !!q && q.bidSize > 0 && q.askSize > 0;

export function maxWidthFor(r: Round, pid: string): number {
  return r.roles[pid] === 'maker' ? MAKER_WIDTH : MAX_WIDTH;
}

/** Lots a quote side can actually fill given the quoter's position limit. */
export function available(r: Round, pid: string, side: 'bid' | 'ask'): number {
  const q = r.quotes[pid];
  if (!q) return 0;
  const pos = r.positions[pid] ?? 0;
  return side === 'bid' ? Math.max(0, Math.min(q.bidSize, POSITION_LIMIT - pos)) : Math.max(0, Math.min(q.askSize, POSITION_LIMIT + pos));
}

// ---------- uptime ----------

function touchUptime(room: RoomState, pid: string, now: number): void {
  const r = room.round!;
  const u = (r.uptime[pid] ??= { ms: 0, since: null });
  const counting = room.phase === 'market' && room.pausedAt === null && r.roles[pid] !== 'taker';
  const live = counting && isLive(r.quotes[pid]);
  if (live && u.since === null) u.since = now;
  if (!live && u.since !== null) {
    u.ms += now - u.since;
    u.since = null;
  }
}

function touchAll(room: RoomState, now: number): void {
  for (const pid of room.round!.participants) touchUptime(room, pid, now);
}

// ---------- rounds ----------

function createRound(room: RoomState, ctx: Ctx): Round {
  const number = room.roundNumber;
  const type = room.config.roundTypes[number - 1];
  const seed = ctx.seed();
  const rand = seededRng(seed);
  const deck = shuffle(DECK, rand);
  const contract = deck.slice(0, CONTRACT_SIZE);
  const participants = Object.values(room.players)
    .filter((p) => !p.spectator)
    .sort((a, b) => a.joinedAt - b.joinedAt || a.id.localeCompare(b.id))
    .map((p) => p.id);
  const roles: Record<string, Role> = {};
  if (type === 'makers') {
    const order = shuffle(participants, rand);
    const m = makerCount(order.length);
    order.forEach((pid, i) => (roles[pid] = i < m ? 'maker' : 'taker'));
  } else for (const pid of participants) roles[pid] = 'trader';
  const insiderId = type === 'insider' ? participants[Math.floor(rand() * participants.length)] : null;

  const schedule: ScheduledEvent[] = STAGE_FRACTIONS.map((frac, stage) => ({ frac, at: null, kind: 'stage', stage, done: false }));
  if (type === 'shocks') {
    const picks = shuffle(SHOCK_IDS, rand).slice(0, SHOCK_FRACTIONS.length);
    SHOCK_FRACTIONS.forEach((f, i) => schedule.push({ frac: f + (rand() * 2 - 1) * SHOCK_JITTER, at: null, kind: 'shock', shock: picks[i], done: false }));
  }
  schedule.sort((a, b) => a.frac - b.frac);

  const zero = () => Object.fromEntries(participants.map((p) => [p, 0]));
  return {
    number,
    type,
    seed,
    contract,
    spare: deck.slice(CONTRACT_SIZE),
    publicOrder: shuffle(contract, rand),
    revealed: 0,
    rule: { ...BASE_RULE },
    shocks: [],
    privateCards: Object.fromEntries(participants.map((p) => [p, [] as number[]])),
    roles,
    insiderId,
    participants,
    schedule,
    quotes: {},
    positions: zero(),
    cash: zero(),
    rebates: zero(),
    trades: [],
    decisions: [],
    infoEvents: [],
    uptime: Object.fromEntries(participants.map((p) => [p, { ms: 0, since: null }])),
    startedAt: null,
    endsAt: null,
    pausedMs: 0,
    activeMs: null,
    settlement: null,
    lastPrice: null,
    quoteCooldownMs: room.config.quoteCooldownMs ?? DEFAULT_QUOTE_COOLDOWN_MS,
    lastQuoteAt: {},
  };
}

/** Earliest time this player may post a quote again. */
export function nextQuoteAt(r: Round, pid: string): number | null {
  const last = r.lastQuoteAt?.[pid];
  return last === undefined ? null : last + (r.quoteCooldownMs ?? DEFAULT_QUOTE_COOLDOWN_MS);
}

function startBriefing(room: RoomState, ctx: Ctx): void {
  room.round = createRound(room, ctx);
  room.phase = 'briefing';
  room.phaseDeadline = ctx.now + room.config.briefingMs;
}

function beginMarket(room: RoomState, ctx: Ctx): void {
  const r = room.round!;
  room.phase = 'market';
  r.startedAt = ctx.now;
  r.endsAt = ctx.now + room.config.marketMs;
  for (const e of r.schedule) e.at = Math.round(ctx.now + e.frac * room.config.marketMs);
  room.phaseDeadline = r.endsAt;
  processDueEvents(room, ctx);
}

function dealPrivate(r: Round, stage: number): void {
  const rand = seededRng(r.seed + 7919 * (stage + 1));
  const tiebreak = new Map(r.publicOrder.map((c) => [c, rand()]));
  const assigned = new Map<number, number>(r.publicOrder.map((c) => [c, 0]));
  for (const cards of Object.values(r.privateCards)) for (const c of cards) assigned.set(c, (assigned.get(c) ?? 0) + 1);
  const revealedSet = new Set(r.publicOrder.slice(0, r.revealed));
  const pubIndex = new Map(r.publicOrder.map((c, i) => [c, i]));
  for (const pid of shuffle(r.participants, rand)) {
    if (r.roles[pid] === 'maker') continue;
    let n = PRIVATE_SCHEDULE[stage] ?? 0;
    if (stage === 0 && pid === r.insiderId) n = INSIDER_START_CARDS;
    if (!n) continue;
    const have = new Set(r.privateCards[pid]);
    const candidates = r.publicOrder
      .filter((c) => !have.has(c) && !revealedSet.has(c))
      // Least-seen first, then cards that stay hidden longest, then a seeded tiebreak.
      .sort((a, b) => assigned.get(a)! - assigned.get(b)! || pubIndex.get(b)! - pubIndex.get(a)! || tiebreak.get(a)! - tiebreak.get(b)!);
    for (const c of candidates.slice(0, n)) {
      r.privateCards[pid].push(c);
      assigned.set(c, assigned.get(c)! + 1);
    }
  }
}

function recordInfo(r: Round, at: number, base: Pick<InfoEvent, 'kind' | 'stage' | 'shock' | 'publicNew'>): void {
  const quotes: InfoEvent['quotes'] = {};
  for (const [pid, q] of Object.entries(r.quotes)) quotes[pid] = { bid: q.bid, ask: q.ask, bidSize: q.bidSize, askSize: q.askSize };
  r.infoEvents.push({
    ...base,
    at,
    fvAfter: Object.fromEntries(r.participants.map((p) => [p, playerFv(r, p)])),
    publicFvAfter: publicFv(r),
    quotes,
    positions: { ...r.positions },
  });
}

function processEvent(room: RoomState, e: ScheduledEvent, at: number): void {
  const r = room.round!;
  e.done = true;
  if (e.kind === 'stage') {
    const target = Math.min(PUBLIC_SCHEDULE[e.stage!], r.publicOrder.length);
    const publicNew = r.publicOrder.slice(r.revealed, target);
    r.revealed = Math.max(r.revealed, target);
    dealPrivate(r, e.stage!);
    recordInfo(r, at, { kind: 'stage', stage: e.stage, publicNew });
  } else {
    r.rule = applyShock(r.rule, e.shock!);
    if (e.shock === 'extra_cards') r.contract.push(...r.spare.splice(0, EXTRA_CARDS));
    r.shocks.push({ at, id: e.shock! });
    recordInfo(r, at, { kind: 'shock', shock: e.shock, publicNew: [] });
  }
}

function processDueEvents(room: RoomState, ctx: Ctx): boolean {
  const r = room.round;
  if (!r || room.phase !== 'market' || room.pausedAt !== null) return false;
  let changed = false;
  for (;;) {
    const next = r.schedule.find((e) => !e.done);
    if (!next || next.at === null || next.at > ctx.now || next.at >= r.endsAt!) break;
    processEvent(room, next, next.at);
    changed = true;
  }
  return changed;
}

function closeMarket(room: RoomState, ctx: Ctx): void {
  const r = room.round!;
  const end = Math.min(ctx.now, r.endsAt!);
  for (const pid of r.participants) {
    const u = r.uptime[pid];
    if (u.since !== null) {
      u.ms += Math.max(0, end - u.since);
      u.since = null;
    }
  }
  for (const e of r.schedule) e.done = true;
  const fvAtClose = Object.fromEntries(r.participants.map((p) => [p, playerFv(r, p)]));
  r.activeMs = Math.max(1, r.endsAt! - r.startedAt! - r.pausedMs);
  r.revealed = r.publicOrder.length;
  const S = settlementValue(r.contract, r.rule);
  r.settlement = S;
  const pnl: Record<string, number> = {};
  for (const pid of r.participants) {
    pnl[pid] = (r.cash[pid] ?? 0) + (r.positions[pid] ?? 0) * S;
    const p = room.players[pid];
    if (p) p.total += pnl[pid];
  }
  room.results.push({
    number: r.number,
    type: r.type,
    settlement: S,
    pnl,
    volume: r.trades.reduce((a, t) => a + t.qty, 0),
    contract: r.contract.slice(),
    rule: { ...r.rule },
    insiderId: r.insiderId,
  });
  try {
    const names = Object.fromEntries(Object.values(room.players).map((p) => [p.id, p.name]));
    room.reviews.push(...analyzeRound({ round: r, names, fvAtClose }));
  } catch (e) {
    // A review bug must never block the game.
    console.error('review failed', e);
  }
  room.phase = 'results';
  room.phaseDeadline = ctx.now + room.config.resultsMs;
}

function afterResults(room: RoomState, ctx: Ctx): void {
  if (room.roundNumber < room.config.roundTypes.length) {
    room.roundNumber++;
    startBriefing(room, ctx);
  } else {
    room.phase = 'finished';
    room.phaseDeadline = null;
  }
}

/** Advance whatever is due. Returns true if anything changed. */
export function tick(room: RoomState, ctx: Ctx): boolean {
  if (room.pausedAt !== null) return false;
  let changed = processDueEvents(room, ctx);
  if (room.phaseDeadline !== null && ctx.now >= room.phaseDeadline) {
    if (room.phase === 'briefing') beginMarket(room, ctx);
    else if (room.phase === 'market') closeMarket(room, ctx);
    else if (room.phase === 'results') afterResults(room, ctx);
    changed = true;
  }
  return changed;
}

/** Earliest time this room needs a tick, or null. */
export function nextDue(room: RoomState): number | null {
  if (room.pausedAt !== null) return null;
  let t = room.phaseDeadline;
  if (room.phase === 'market' && room.round) {
    const e = room.round.schedule.find((x) => !x.done);
    if (e?.at != null && (t === null || e.at < t)) t = e.at;
  }
  return t;
}

// ---------- joining ----------

export function nameKey(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

export function addPlayer(room: RoomState, args: { id: string; name: string; sessionHash: string; isBot: boolean; isHost: boolean; now: number }): Player {
  const name = args.name.trim().replace(/\s+/g, ' ');
  if (!name || name.length > 20) throw new EngineError('bad_name', 'Pick a display name of 1 to 20 characters.');
  const key = nameKey(name);
  if (Object.values(room.players).some((p) => p.nameKey === key)) throw new EngineError('name_taken', 'That name is taken in this room.');
  const active = Object.values(room.players).filter((p) => !p.spectator).length;
  const spectator = room.rosterFrozen || active >= MAX_PLAYERS;
  const p: Player = { id: args.id, name, nameKey: key, sessionHash: args.sessionHash, isBot: args.isBot, isHost: args.isHost, spectator, joinedAt: args.now, total: 0 };
  room.players[p.id] = p;
  return p;
}

// ---------- commands ----------

const isInt = (x: unknown): x is number => typeof x === 'number' && Number.isInteger(x);

function needHost(actor: Actor): void {
  if (actor.kind !== 'host') throw new EngineError('not_host', 'Only the host can do that.');
}

function needMarket(room: RoomState): Round {
  if (room.phase !== 'market' || !room.round) throw new EngineError('closed', 'The market is not open.');
  if (room.pausedAt !== null) throw new EngineError('paused', 'The game is paused.');
  return room.round;
}

function needParticipant(room: RoomState, actor: Actor): { r: Round; pid: string } {
  if (actor.kind !== 'player') throw new EngineError('not_player', 'Join as a player to trade.');
  const r = needMarket(room);
  if (!r.participants.includes(actor.playerId)) throw new EngineError('spectator', 'You are watching this session; you joined after it started.');
  return { r, pid: actor.playerId };
}

export interface CommandResult {
  message?: string;
}

export function applyCommand(room: RoomState, actor: Actor, cmd: Command, ctx: Ctx, hooks: { newBotId?: () => string } = {}): CommandResult {
  switch (cmd.kind) {
    case 'setConfig': {
      needHost(actor);
      if (room.phase !== 'lobby') throw new EngineError('locked', 'Settings lock when the session starts.');
      const c = room.config;
      if (cmd.roundTypes !== undefined) {
        if (!Array.isArray(cmd.roundTypes) || cmd.roundTypes.length < MIN_ROUNDS || cmd.roundTypes.length > MAX_ROUNDS || !cmd.roundTypes.every((t) => ROUND_TYPE_IDS.includes(t)))
          throw new EngineError('bad_config', `Choose ${MIN_ROUNDS} to ${MAX_ROUNDS} rounds.`);
        c.roundTypes = cmd.roundTypes.slice();
      }
      for (const k of ['briefingMs', 'marketMs', 'resultsMs'] as const) {
        const v = cmd[k];
        if (v === undefined) continue;
        const [lo, hi] = DURATION_BOUNDS[k];
        if (!isInt(v) || v < lo || v > hi) throw new EngineError('bad_config', `That duration must be between ${lo / 1000} and ${hi / 1000} seconds.`);
        c[k] = v;
      }
      if (cmd.quoteCooldownMs !== undefined) {
        const v = cmd.quoteCooldownMs;
        const [lo, hi] = QUOTE_COOLDOWN_BOUNDS;
        if (!isInt(v) || v < lo || v > hi) throw new EngineError('bad_config', `Time between quote updates must be ${lo / 1000} to ${hi / 1000} seconds.`);
        c.quoteCooldownMs = v;
      }
      return {};
    }
    case 'start': {
      needHost(actor);
      if (room.phase !== 'lobby') throw new EngineError('started', 'The session already started.');
      const n = Object.values(room.players).filter((p) => !p.spectator).length;
      if (n < MIN_PLAYERS) throw new EngineError('few_players', `Need at least ${MIN_PLAYERS} players.`);
      room.rosterFrozen = true;
      room.roundNumber = 1;
      startBriefing(room, ctx);
      return { message: 'Session started.' };
    }
    case 'pause': {
      needHost(actor);
      if (!['briefing', 'market', 'results'].includes(room.phase)) throw new EngineError('bad_phase', 'Nothing to pause.');
      if (room.pausedAt !== null) return {};
      if (room.phase === 'market') touchAll(room, ctx.now);
      room.pausedAt = ctx.now;
      if (room.phase === 'market') touchAll(room, ctx.now);
      return { message: 'Paused.' };
    }
    case 'resume': {
      needHost(actor);
      if (room.pausedAt === null) return {};
      const delta = ctx.now - room.pausedAt;
      room.pausedAt = null;
      if (room.phaseDeadline !== null) room.phaseDeadline += delta;
      const r = room.round;
      if (r && room.phase === 'market') {
        r.endsAt! += delta;
        r.pausedMs += delta;
        for (const e of r.schedule) if (!e.done && e.at !== null) e.at += delta;
        touchAll(room, ctx.now);
      }
      return { message: 'Resumed.' };
    }
    case 'advance': {
      needHost(actor);
      if (room.pausedAt !== null) throw new EngineError('paused', 'Resume first.');
      if (room.phase === 'briefing') beginMarket(room, ctx);
      else if (room.phase === 'results') afterResults(room, ctx);
      else throw new EngineError('bad_phase', 'The market runs on its timer.');
      return {};
    }
    case 'skip': {
      needHost(actor);
      if (!room.config.devMode) throw new EngineError('not_dev', 'Skipping is only allowed in test mode.');
      if (room.pausedAt !== null) throw new EngineError('paused', 'Resume first.');
      if (room.phase === 'briefing') beginMarket(room, ctx);
      else if (room.phase === 'results') afterResults(room, ctx);
      else if (room.phase === 'market') {
        const r = room.round!;
        const next = r.schedule.find((e) => !e.done && e.at !== null && e.at < r.endsAt!);
        if (next) {
          // Bring the rest of the round forward so the skipped time disappears.
          const shift = next.at! - ctx.now;
          r.endsAt! -= shift;
          room.phaseDeadline = r.endsAt;
          for (const e of r.schedule) if (!e.done && e.at !== null) e.at -= shift;
          processDueEvents(room, ctx);
        } else {
          r.endsAt = ctx.now;
          closeMarket(room, ctx);
        }
      } else throw new EngineError('bad_phase', 'Nothing to skip.');
      return {};
    }
    case 'addBots': {
      needHost(actor);
      if (!room.config.devMode) throw new EngineError('not_dev', 'Bots are only allowed in test mode.');
      if (room.phase !== 'lobby') throw new EngineError('started', 'Add bots before starting.');
      const count = isInt(cmd.count) ? Math.min(10, Math.max(1, cmd.count)) : 5;
      let added = 0;
      for (let i = 1; added < count && i < 200; i++) {
        if (Object.values(room.players).filter((p) => !p.spectator).length >= MAX_PLAYERS) break;
        const name = `Bot ${i}`;
        if (Object.values(room.players).some((p) => p.nameKey === nameKey(name))) continue;
        const id = hooks.newBotId ? hooks.newBotId() : ctx.newId();
        addPlayer(room, { id, name, sessionHash: `bot:${id}`, isBot: true, isHost: false, now: ctx.now + added });
        added++;
      }
      return { message: `Added ${added} bots.` };
    }
    case 'removePlayer': {
      needHost(actor);
      if (room.phase !== 'lobby') throw new EngineError('started', 'Players can only be removed in the lobby.');
      if (!room.players[cmd.playerId]) throw new EngineError('no_player', 'No such player.');
      delete room.players[cmd.playerId];
      return {};
    }
    case 'setQuote': {
      const { r, pid } = needParticipant(room, actor);
      if (r.roles[pid] === 'taker') throw new EngineError('taker', 'Takers do not quote this round. Trade against the makers instead.');
      const { bid, ask, size } = cmd;
      if (!isInt(bid) || !isInt(ask) || !isInt(size)) throw new EngineError('bad_quote', 'Prices and size must be whole numbers.');
      if (bid < PRICE_MIN || ask > PRICE_MAX) throw new EngineError('bad_quote', `Prices must be between ${PRICE_MIN} and ${PRICE_MAX}.`);
      if (ask <= bid) throw new EngineError('bad_quote', 'Your ask must be above your bid.');
      const w = maxWidthFor(r, pid);
      if (ask - bid > w) throw new EngineError('too_wide', `Your quote can be at most ${w} wide (bid ${bid}, so ask at most ${bid + w}).`);
      if (size < 1 || size > MAX_QUOTE_SIZE) throw new EngineError('bad_size', `Size must be 1 to ${MAX_QUOTE_SIZE}.`);
      for (const [oid, oq] of Object.entries(r.quotes)) {
        if (oid === pid) continue;
        const who = room.players[oid]?.name ?? 'another player';
        if (oq.askSize > 0 && bid >= oq.ask) throw new EngineError('crosses', `Your bid ${bid} would cross ${who}'s ask ${oq.ask}. Buy from them instead, or bid lower.`);
        if (oq.bidSize > 0 && ask <= oq.bid) throw new EngineError('crosses', `Your ask ${ask} would cross ${who}'s bid ${oq.bid}. Sell to them instead, or ask higher.`);
      }
      const allowedAt = nextQuoteAt(r, pid);
      if (allowedAt !== null && ctx.now < allowedAt) {
        const secs = Math.ceil((allowedAt - ctx.now) / 1000);
        throw new EngineError('cooldown', `You can update your quote every ${Math.round(r.quoteCooldownMs / 1000)} s. Next update in ${secs} s.`);
      }
      const fv = playerFv(r, pid);
      (r.lastQuoteAt ??= {})[pid] = ctx.now;
      r.quotes[pid] = { id: ctx.newId(), bid, ask, bidSize: size, askSize: size, size, postedAt: ctx.now, fvAtPost: fv };
      r.decisions.push({ at: ctx.now, playerId: pid, kind: 'quote', bid, ask, size, fv, publicFv: publicFv(r), position: r.positions[pid] ?? 0 });
      touchUptime(room, pid, ctx.now);
      return { message: `Quoting ${bid} / ${ask}, ${size} each side.` };
    }
    case 'pullQuote': {
      const { r, pid } = needParticipant(room, actor);
      if (!r.quotes[pid]) return {};
      delete r.quotes[pid];
      r.decisions.push({ at: ctx.now, playerId: pid, kind: 'pull', fv: playerFv(r, pid), publicFv: publicFv(r), position: r.positions[pid] ?? 0 });
      touchUptime(room, pid, ctx.now);
      return { message: 'Quote pulled.' };
    }
    case 'trade':
      return trade(room, actor, cmd, ctx);
  }
  throw new EngineError('bad_command', 'Unknown command.');
}

function trade(room: RoomState, actor: Actor, cmd: { targetId: string; side: Side; qty: number; price: number }, ctx: Ctx): CommandResult {
  const { r, pid } = needParticipant(room, actor);
  const role = r.roles[pid];
  if (cmd.targetId === pid) throw new EngineError('self', 'That is your own quote.');
  if (cmd.side !== 'buy' && cmd.side !== 'sell') throw new EngineError('bad_side', 'Buy or sell?');
  if (!isInt(cmd.qty) || cmd.qty < 1 || cmd.qty > MAX_QUOTE_SIZE) throw new EngineError('bad_qty', `Trade 1 to ${MAX_QUOTE_SIZE} lots.`);
  if (role !== 'taker' && !isLive(r.quotes[pid])) throw new EngineError('no_quote', 'Post a two-sided quote first: you can only trade with others while your own quote is live.');
  if (role === 'taker' && r.roles[cmd.targetId] !== 'maker') throw new EngineError('takers', 'Takers can only trade against makers.');
  const q = r.quotes[cmd.targetId];
  const who = room.players[cmd.targetId]?.name ?? 'That player';
  if (!q) throw new EngineError('no_quote_target', `${who} has no quote up.`);
  const buy = cmd.side === 'buy';
  const px = buy ? q.ask : q.bid;
  const size = buy ? q.askSize : q.bidSize;
  if (size <= 0) throw new EngineError('quote_changed', `${who}'s ${buy ? 'ask' : 'bid'} has already been filled.`);
  if (px !== cmd.price) throw new EngineError('quote_changed', `${who}'s ${buy ? 'ask' : 'bid'} moved to ${px}. Check the new price and try again.`);
  if (cmd.qty > size) throw new EngineError('quote_changed', `${who} only shows ${size} at ${px}.`);
  const mine = r.positions[pid] ?? 0;
  const theirs = r.positions[cmd.targetId] ?? 0;
  if (buy ? mine + cmd.qty > POSITION_LIMIT : mine - cmd.qty < -POSITION_LIMIT)
    throw new EngineError('limit', `That would take you past your position limit of ${POSITION_LIMIT} lots ${buy ? 'long' : 'short'}.`);
  if (buy ? theirs - cmd.qty < -POSITION_LIMIT : theirs + cmd.qty > POSITION_LIMIT)
    throw new EngineError('limit_target', `${who} is at their position limit and can only fill ${available(r, cmd.targetId, buy ? 'ask' : 'bid')}.`);

  const buyerId = buy ? pid : cmd.targetId;
  const sellerId = buy ? cmd.targetId : pid;
  const rebate = r.type === 'makers' && r.roles[cmd.targetId] === 'maker' ? MAKER_REBATE * cmd.qty : 0;
  const t: Trade = {
    id: ctx.newId(),
    seq: r.trades.length + 1,
    at: ctx.now,
    buyerId,
    sellerId,
    aggressorId: pid,
    restingId: cmd.targetId,
    price: px,
    qty: cmd.qty,
    rebate,
    buyerFv: playerFv(r, buyerId),
    sellerFv: playerFv(r, sellerId),
    publicFv: publicFv(r),
    restingQuoteId: q.id,
    restingBid: q.bid,
    restingAsk: q.ask,
    restingFvAtPost: q.fvAtPost,
  };
  r.positions[buyerId] = (r.positions[buyerId] ?? 0) + cmd.qty;
  r.positions[sellerId] = (r.positions[sellerId] ?? 0) - cmd.qty;
  r.cash[buyerId] = (r.cash[buyerId] ?? 0) - px * cmd.qty;
  r.cash[sellerId] = (r.cash[sellerId] ?? 0) + px * cmd.qty;
  if (rebate) {
    r.cash[cmd.targetId] += rebate;
    r.rebates[cmd.targetId] = (r.rebates[cmd.targetId] ?? 0) + rebate;
  }
  if (buy) q.askSize -= cmd.qty;
  else q.bidSize -= cmd.qty;
  r.trades.push(t);
  r.lastPrice = px;
  touchUptime(room, cmd.targetId, ctx.now);
  return { message: `${buy ? 'Bought' : 'Sold'} ${cmd.qty} ${buy ? 'from' : 'to'} ${who} at ${px}.` };
}
