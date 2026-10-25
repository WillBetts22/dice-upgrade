// Pure game engine: room state in, room state out. No I/O; the manager persists and broadcasts.
import { applyShock, BASE_RULE, DECK, EXTRA_CARDS, fairValue, productFairValue, productValue, SHOCK_IDS, settlementValue } from '../shared/cards.js';
import { estimateFv, makeClue } from '../shared/clues.js';
import { analyzeMarket, combineReviews, type PlayerRoundReview, type ReviewRound } from '../shared/review.js';
import {
  CONTRACT_SIZE,
  DEFAULT_DURATIONS,
  DEFAULT_QUOTE_COOLDOWN_MS,
  DEFAULT_ROUND_TYPES,
  DURATION_BOUNDS,
  INSIDER_START_CARDS,
  CLUES_PER_REVEAL_BOUNDS,
  DEFAULT_CLUES_PER_REVEAL,
  DEFAULT_PRIVATE_PER_REVEAL,
  DEFAULT_PRIVATE_START,
  DEFAULT_PRODUCT_MARKET,
  makerCount,
  type MarketId,
  MARKETS,
  MAX_PLAYERS,
  MAX_ROUNDS,
  MIN_PLAYERS,
  MIN_ROUNDS,
  PERSONAL_STAGES,
  PRICE_MIN,
  PRIVATE_PER_REVEAL_BOUNDS,
  PRIVATE_START_BOUNDS,
  PRODUCT_CARDS,
  PUBLIC_SCHEDULE,
  QUOTE_COOLDOWN_BOUNDS,
  ROUND_TYPE_IDS,
  DEFAULT_REVEAL_EVERY_MS,
  DEFAULT_SHOCK_COUNT,
  maxRevealEveryMs,
  minMarketMs,
  REVEAL_EVERY_BOUNDS,
  SHOCK_COUNT_BOUNDS,
  SHOCK_GAP,
  SHOCK_JITTER,
  STAGE_COUNT,
} from '../shared/rules.js';
import type { Book, Command, InfoEvent, MarketSnap, Phase, Quote, Role, Round, RoomConfig, RoundResult, ScheduledEvent, Side, Trade } from '../shared/types.js';
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
    config: { roundTypes: DEFAULT_ROUND_TYPES.slice(), ...DEFAULT_DURATIONS, devMode: args.devMode,
      quoteCooldownMs: DEFAULT_QUOTE_COOLDOWN_MS,
      revealEveryMs: DEFAULT_REVEAL_EVERY_MS,
      shockCount: DEFAULT_SHOCK_COUNT,
      productMarket: DEFAULT_PRODUCT_MARKET,
      privateStart: DEFAULT_PRIVATE_START,
      privatePerReveal: DEFAULT_PRIVATE_PER_REVEAL,
      cluesPerReveal: DEFAULT_CLUES_PER_REVEAL,
    },
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

const original = (r: Round) => r.contract.slice(0, CONTRACT_SIZE);

function hashId(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

function computeFv(r: Round, pid: string): Partial<Record<MarketId, number>> {
  const est = estimateFv({
    known: knownCards(r, pid),
    contract: original(r),
    product: r.productCards,
    extras: r.contract.length - CONTRACT_SIZE,
    clues: (r.clues[pid] ?? []).map((c) => c.spec),
    rule: r.rule,
    rand: seededRng((r.seed ^ hashId(pid)) + 104729 * (r.infoEvents.length + 1)),
  });
  const out: Partial<Record<MarketId, number>> = { sum: est.sum };
  if (r.markets.includes('product')) out.product = est.product;
  return out;
}

function refreshFv(r: Round): void {
  for (const pid of r.participants) r.fv[pid] = computeFv(r, pid);
}

/** A participant's exact fair value in one market given everything they know (cards and clues). */
export function playerFv(r: Round, pid: string, m: MarketId = 'sum'): number {
  return r.fv?.[pid]?.[m] ?? computeFv(r, pid)[m] ?? 0;
}

export function publicFv(r: Round, m: MarketId = 'sum'): number {
  const pub = r.publicOrder.slice(0, r.revealed);
  if (m === 'product') return productFairValue(pub, r.productCards.filter((c) => pub.includes(c)), r.productCards.length, r.rule);
  return fairValue(pub, r.contract.length, r.rule);
}

export const isLive = (q: Quote | undefined): q is Quote => !!q && q.bidSize > 0 && q.askSize > 0;

export function book(r: Round, m: MarketId): Book {
  const b = r.books[m];
  if (!b) throw new EngineError('no_market', 'That market is not running this session.');
  return b;
}

export function maxWidthFor(r: Round, pid: string, m: MarketId = 'sum'): number {
  return r.roles[pid] === 'maker' ? MARKETS[m].makerWidth : MARKETS[m].maxWidth;
}

/** Lots a quote side can actually fill given the quoter's position limit. */
export function available(r: Round, pid: string, side: 'bid' | 'ask', m: MarketId = 'sum'): number {
  const b = book(r, m);
  const q = b.quotes[pid];
  if (!q) return 0;
  const pos = b.positions[pid] ?? 0;
  const lim = MARKETS[m].positionLimit;
  return side === 'bid' ? Math.max(0, Math.min(q.bidSize, lim - pos)) : Math.max(0, Math.min(q.askSize, lim + pos));
}

// ---------- uptime ----------

function touchUptime(room: RoomState, pid: string, now: number, m: MarketId): void {
  const r = room.round!;
  const b = book(r, m);
  const u = (b.uptime[pid] ??= { ms: 0, since: null });
  const counting = room.phase === 'market' && room.pausedAt === null && r.roles[pid] !== 'taker';
  const live = counting && isLive(b.quotes[pid]);
  if (live && u.since === null) u.since = now;
  if (!live && u.since !== null) {
    u.ms += now - u.since;
    u.since = null;
  }
}

function touchAll(room: RoomState, now: number): void {
  for (const m of room.round!.markets) for (const pid of room.round!.participants) touchUptime(room, pid, now, m);
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

  const { marketMs } = room.config;
  const revealEvery = Math.min(room.config.revealEveryMs ?? DEFAULT_REVEAL_EVERY_MS, maxRevealEveryMs(marketMs));
  const stageFracs = Array.from({ length: STAGE_COUNT }, (_, k) => (k * revealEvery) / marketMs);
  const schedule: ScheduledEvent[] = stageFracs.map((frac, stage) => ({ frac, at: null, kind: 'stage', stage, done: false }));
  if (type === 'shocks') {
    const n = Math.min(room.config.shockCount ?? DEFAULT_SHOCK_COUNT, SHOCK_IDS.length);
    const picks = shuffle(SHOCK_IDS, rand).slice(0, n);
    picks.forEach((shock, i) => {
      let f = (i + 1) / (n + 1) + (rand() * 2 - 1) * SHOCK_JITTER;
      // Keep news apart from reveals so each moves the market on its own.
      for (const sf of stageFracs.slice(1)) if (Math.abs(f - sf) < SHOCK_GAP) f = f >= sf ? sf + SHOCK_GAP : sf - SHOCK_GAP;
      schedule.push({ frac: Math.min(0.97, Math.max(0.03, f)), at: null, kind: 'shock', shock, done: false });
    });
  }
  schedule.sort((a, b) => a.frac - b.frac);

  const zero = () => Object.fromEntries(participants.map((p) => [p, 0]));
  const markets: MarketId[] = room.config.productMarket ?? DEFAULT_PRODUCT_MARKET ? ['sum', 'product'] : ['sum'];
  const books: Round['books'] = {};
  for (const m of markets)
    books[m] = { quotes: {}, positions: zero(), cash: zero(), rebates: zero(), lastPrice: null, lastQuoteAt: {}, uptime: Object.fromEntries(participants.map((p) => [p, { ms: 0, since: null }])) };
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
    markets,
    books,
    // The deck is shuffled, so the first cards dealt are as random as any; the reveal order is shuffled separately.
    productCards: contract.slice(0, PRODUCT_CARDS),
    clues: Object.fromEntries(participants.map((p) => [p, []])),
    fv: {},
    privateStart: room.config.privateStart ?? DEFAULT_PRIVATE_START,
    privatePerReveal: room.config.privatePerReveal ?? DEFAULT_PRIVATE_PER_REVEAL,
    cluesPerReveal: room.config.cluesPerReveal ?? DEFAULT_CLUES_PER_REVEAL,
    trades: [],
    decisions: [],
    infoEvents: [],
    startedAt: null,
    endsAt: null,
    pausedMs: 0,
    activeMs: null,
    settlement: null,
    quoteCooldownMs: room.config.quoteCooldownMs ?? DEFAULT_QUOTE_COOLDOWN_MS,
  };
}

/** Earliest time this player may post a quote again in this market. */
export function nextQuoteAt(r: Round, pid: string, m: MarketId = 'sum'): number | null {
  const last = r.books[m]?.lastQuoteAt[pid];
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
    let n = stage === 0 ? r.privateStart : stage < PERSONAL_STAGES ? r.privatePerReveal : 0;
    if (stage === 0 && pid === r.insiderId) n = r.privateStart + INSIDER_START_CARDS - 1;
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

/** Personal clues: true statements about the hidden contract, different for each player. */
function dealClues(r: Round, stage: number): void {
  if (stage >= PERSONAL_STAGES || r.cluesPerReveal <= 0) return;
  const rand = seededRng(r.seed + 15485863 * (stage + 1));
  for (const pid of r.participants) {
    if (r.roles[pid] === 'maker') continue;
    const have = new Set(r.clues[pid].map((c) => c.id));
    for (let i = 0; i < r.cluesPerReveal; i++) {
      const m: MarketId = r.markets.includes('product') && rand() < 0.5 ? 'product' : 'sum';
      const clue = makeClue(m, original(r), r.productCards, rand, have, stage);
      if (!clue) continue;
      have.add(clue.id);
      r.clues[pid].push(clue);
    }
  }
}

function recordInfo(r: Round, at: number, base: Pick<InfoEvent, 'kind' | 'stage' | 'shock' | 'publicNew'>): void {
  refreshFv(r);
  const m: InfoEvent['m'] = {};
  for (const id of r.markets) {
    const b = book(r, id);
    const quotes: MarketSnap['quotes'] = {};
    for (const [pid, q] of Object.entries(b.quotes)) quotes[pid] = { bid: q.bid, ask: q.ask, bidSize: q.bidSize, askSize: q.askSize };
    m[id] = { fvAfter: Object.fromEntries(r.participants.map((p) => [p, playerFv(r, p, id)])), publicFvAfter: publicFv(r, id), quotes, positions: { ...b.positions } };
  }
  r.infoEvents.push({ ...base, at, m });
}

function processEvent(room: RoomState, e: ScheduledEvent, at: number): void {
  const r = room.round!;
  e.done = true;
  if (e.kind === 'stage') {
    const target = Math.min(PUBLIC_SCHEDULE[e.stage!], r.publicOrder.length);
    const publicNew = r.publicOrder.slice(r.revealed, target);
    r.revealed = Math.max(r.revealed, target);
    dealPrivate(r, e.stage!);
    dealClues(r, e.stage!);
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
  for (const m of r.markets)
    for (const pid of r.participants) {
      const u = book(r, m).uptime[pid];
      if (u && u.since !== null) {
        u.ms += Math.max(0, end - u.since);
        u.since = null;
      }
    }
  for (const e of r.schedule) e.done = true;
  const fvAtClose = Object.fromEntries(r.markets.map((m) => [m, Object.fromEntries(r.participants.map((p) => [p, playerFv(r, p, m)]))])) as Record<MarketId, Record<string, number>>;
  r.activeMs = Math.max(1, r.endsAt! - r.startedAt! - r.pausedMs);
  r.revealed = r.publicOrder.length;
  r.settlement = {};
  const pnl: Record<string, number> = Object.fromEntries(r.participants.map((p) => [p, 0]));
  const markets: RoundResult['markets'] = {};
  for (const m of r.markets) {
    const S = m === 'product' ? productValue(r.productCards, r.rule) : settlementValue(r.contract, r.rule);
    r.settlement[m] = S;
    const b = book(r, m);
    const mp: Record<string, number> = {};
    for (const pid of r.participants) {
      mp[pid] = (b.cash[pid] ?? 0) + (b.positions[pid] ?? 0) * S;
      pnl[pid] += mp[pid];
    }
    markets[m] = { settlement: S, pnl: mp, volume: r.trades.filter((t) => t.market === m).reduce((a, t) => a + t.qty, 0) };
  }
  for (const pid of r.participants) {
    const p = room.players[pid];
    if (p) p.total += pnl[pid];
  }
  room.results.push({
    number: r.number,
    type: r.type,
    settlement: r.settlement.sum!,
    pnl,
    volume: r.trades.reduce((a, t) => a + t.qty, 0),
    markets,
    productCards: r.productCards.slice(),
    contract: r.contract.slice(),
    rule: { ...r.rule },
    insiderId: r.insiderId,
  });
  try {
    const names = Object.fromEntries(Object.values(room.players).map((p) => [p.id, p.name]));
    room.reviews.push(...reviewRound(r, names, fvAtClose));
  } catch (e) {
    // A review bug must never block the game.
    console.error('review failed', e);
  }
  room.phase = 'results';
  room.phaseDeadline = ctx.now + room.config.resultsMs;
}

/** Run the decision review for each market and combine them per player. */
function reviewRound(r: Round, names: Record<string, string>, fvAtClose: Record<MarketId, Record<string, number>>): PlayerRoundReview[] {
  const per = r.markets.map((m) => {
    const b = book(r, m);
    const flat: ReviewRound = {
      number: r.number,
      participants: r.participants,
      roles: r.roles,
      startedAt: r.startedAt!,
      endsAt: r.endsAt!,
      activeMs: r.activeMs,
      settlement: r.settlement![m]!,
      trades: r.trades.filter((t) => t.market === m),
      decisions: r.decisions.filter((d) => d.market === m),
      infoEvents: r.infoEvents.map((e) => ({ at: e.at, kind: e.kind, stage: e.stage, shock: e.shock, publicNew: e.publicNew, ...e.m[m]! })),
      positions: b.positions,
      cash: b.cash,
      uptime: b.uptime,
    };
    return { m, reviews: analyzeMarket({ round: flat, market: m, names, fvAtClose: fvAtClose[m] }) };
  });
  return r.participants.map((pid) => combineReviews(r.number, pid, r.startedAt!, Object.fromEntries(per.map(({ m, reviews }) => [m, reviews[pid]]))));
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
      // The reveal interval and market length must fit together; the field changed last wins.
      if (cmd.marketMs !== undefined && (c.revealEveryMs ?? DEFAULT_REVEAL_EVERY_MS) > maxRevealEveryMs(c.marketMs))
        c.revealEveryMs = Math.max(REVEAL_EVERY_BOUNDS[0], maxRevealEveryMs(c.marketMs));
      if (cmd.revealEveryMs !== undefined) {
        const v = cmd.revealEveryMs;
        const [lo, hi] = REVEAL_EVERY_BOUNDS;
        if (!isInt(v) || v < lo || v > hi) throw new EngineError('bad_config', `Time between reveals must be ${lo / 1000} to ${hi / 1000} seconds.`);
        c.revealEveryMs = v;
        c.marketMs = Math.max(c.marketMs, minMarketMs(v));
      }
      if (cmd.shockCount !== undefined) {
        const v = cmd.shockCount;
        const [lo, hi] = SHOCK_COUNT_BOUNDS;
        if (!isInt(v) || v < lo || v > hi) throw new EngineError('bad_config', `News shocks per round must be ${lo} to ${hi}.`);
        c.shockCount = v;
      }
      if (cmd.productMarket !== undefined) {
        if (typeof cmd.productMarket !== 'boolean') throw new EngineError('bad_config', 'Turn the product market on or off.');
        c.productMarket = cmd.productMarket;
      }
      const counts = [
        ['privateStart', PRIVATE_START_BOUNDS, 'Private cards at the open'],
        ['privatePerReveal', PRIVATE_PER_REVEAL_BOUNDS, 'Private cards per reveal'],
        ['cluesPerReveal', CLUES_PER_REVEAL_BOUNDS, 'Clues per reveal'],
      ] as const;
      for (const [k, [lo, hi], label] of counts) {
        const v = cmd[k];
        if (v === undefined) continue;
        if (!isInt(v) || v < lo || v > hi) throw new EngineError('bad_config', `${label} must be ${lo} to ${hi}.`);
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
      const m = marketOf(r, cmd.market);
      const spec = MARKETS[m];
      const b = book(r, m);
      if (r.roles[pid] === 'taker') throw new EngineError('taker', 'Takers do not quote this round. Trade against the makers instead.');
      const { bid, ask, size } = cmd;
      if (!isInt(bid) || !isInt(ask) || !isInt(size)) throw new EngineError('bad_quote', 'Prices and size must be whole numbers.');
      if (bid < PRICE_MIN || ask > spec.priceMax) throw new EngineError('bad_quote', `Prices must be between ${PRICE_MIN} and ${spec.priceMax}.`);
      if (ask <= bid) throw new EngineError('bad_quote', 'Your ask must be above your bid.');
      const w = maxWidthFor(r, pid, m);
      if (ask - bid > w) throw new EngineError('too_wide', `Your ${spec.short.toLowerCase()} quote can be at most ${w} wide (bid ${bid}, so ask at most ${bid + w}).`);
      if (size < 1 || size > spec.maxSize) throw new EngineError('bad_size', `Size must be 1 to ${spec.maxSize}.`);
      const allowedAt = nextQuoteAt(r, pid, m);
      if (allowedAt !== null && ctx.now < allowedAt) {
        const secs = Math.ceil((allowedAt - ctx.now) / 1000);
        throw new EngineError('cooldown', `You can update your quote every ${Math.round(r.quoteCooldownMs / 1000)} s. Next update in ${secs} s.`);
      }
      const fv = playerFv(r, pid, m);
      b.lastQuoteAt[pid] = ctx.now;
      b.quotes[pid] = { id: ctx.newId(), bid, ask, bidSize: size, askSize: size, size, postedAt: ctx.now, fvAtPost: fv };
      r.decisions.push({ market: m, at: ctx.now, playerId: pid, kind: 'quote', bid, ask, size, fv, publicFv: publicFv(r, m), position: b.positions[pid] ?? 0 });
      // A quote through someone else's price trades at their price first, like a marketable limit order.
      const fills = [...sweep(room, pid, m, 'buy', ctx), ...sweep(room, pid, m, 'sell', ctx)];
      touchUptime(room, pid, ctx.now, m);
      const q = b.quotes[pid];
      const rest = q.bidSize > 0 || q.askSize > 0 ? `Quoting ${q.bidSize ? q.bid : '-'} / ${q.askSize ? q.ask : '-'}${q.bidSize === q.askSize ? `, ${q.bidSize} each side` : ` (${q.bidSize} bid, ${q.askSize} offered)`}.` : 'Your quote filled completely.';
      return { message: fills.length ? `${fills.join(' ')} ${rest}` : rest };
    }
    case 'pullQuote': {
      const { r, pid } = needParticipant(room, actor);
      const m = marketOf(r, cmd.market);
      const b = book(r, m);
      if (!b.quotes[pid]) return {};
      delete b.quotes[pid];
      r.decisions.push({ market: m, at: ctx.now, playerId: pid, kind: 'pull', fv: playerFv(r, pid, m), publicFv: publicFv(r, m), position: b.positions[pid] ?? 0 });
      touchUptime(room, pid, ctx.now, m);
      return { message: 'Quote pulled.' };
    }
    case 'trade':
      return trade(room, actor, cmd, ctx);
  }
  throw new EngineError('bad_command', 'Unknown command.');
}

function marketOf(r: Round, m: unknown): MarketId {
  const id = (m ?? 'sum') as MarketId;
  if (!r.markets.includes(id)) throw new EngineError('no_market', 'That market is not running this session.');
  return id;
}

/** Trades the player's newly posted quote against every opposite quote it crosses, best price first. */
function sweep(room: RoomState, pid: string, m: MarketId, side: Side, ctx: Ctx): string[] {
  const r = room.round!;
  const b = book(r, m);
  const buy = side === 'buy';
  const mine = b.quotes[pid];
  const out: string[] = [];
  const crossing = Object.entries(b.quotes)
    .filter(([oid, q]) => oid !== pid && (buy ? q.askSize > 0 && q.ask <= mine.bid : q.bidSize > 0 && q.bid >= mine.ask))
    .sort(([, a], [, c]) => (buy ? a.ask - c.ask : c.bid - a.bid) || a.postedAt - c.postedAt);
  for (const [oid, q] of crossing) {
    const qty = Math.min(available(r, pid, buy ? 'bid' : 'ask', m), available(r, oid, buy ? 'ask' : 'bid', m));
    if (qty <= 0) continue;
    out.push(trade(room, { kind: 'player', playerId: pid }, { market: m, targetId: oid, side, qty, price: buy ? q.ask : q.bid }, ctx, true).message!);
    if (buy) mine.bidSize -= qty;
    else mine.askSize -= qty;
  }
  // Whatever still crosses could not trade (position limits), so it does not rest.
  const stillCrosses = Object.entries(b.quotes).some(([oid, q]) => oid !== pid && (buy ? available(r, oid, 'ask', m) > 0 && q.ask <= mine.bid : available(r, oid, 'bid', m) > 0 && q.bid >= mine.ask));
  if (stillCrosses) {
    if (buy) mine.bidSize = 0;
    else mine.askSize = 0;
  }
  return out;
}

function trade(room: RoomState, actor: Actor, cmd: { market?: MarketId; targetId: string; side: Side; qty: number; price: number }, ctx: Ctx, sweeping = false): CommandResult {
  const { r, pid } = needParticipant(room, actor);
  const m = marketOf(r, cmd.market);
  const spec = MARKETS[m];
  const b = book(r, m);
  const role = r.roles[pid];
  if (cmd.targetId === pid) throw new EngineError('self', 'That is your own quote.');
  if (cmd.side !== 'buy' && cmd.side !== 'sell') throw new EngineError('bad_side', 'Buy or sell?');
  if (!isInt(cmd.qty) || cmd.qty < 1 || cmd.qty > spec.maxSize) throw new EngineError('bad_qty', `Trade 1 to ${spec.maxSize} lots.`);
  if (role !== 'taker' && !sweeping && !isLive(b.quotes[pid]))
    throw new EngineError('no_quote', `Post a two-sided ${spec.short.toLowerCase()} quote first: you can only trade with others while your own quote in that market is live.`);
  if (role === 'taker' && r.roles[cmd.targetId] !== 'maker') throw new EngineError('takers', 'Takers can only trade against makers.');
  const q = b.quotes[cmd.targetId];
  const who = room.players[cmd.targetId]?.name ?? 'That player';
  if (!q) throw new EngineError('no_quote_target', `${who} has no quote up.`);
  const buy = cmd.side === 'buy';
  const px = buy ? q.ask : q.bid;
  const size = buy ? q.askSize : q.bidSize;
  if (size <= 0) throw new EngineError('quote_changed', `${who}'s ${buy ? 'ask' : 'bid'} has already been filled.`);
  if (px !== cmd.price) throw new EngineError('quote_changed', `${who}'s ${buy ? 'ask' : 'bid'} moved to ${px}. Check the new price and try again.`);
  if (cmd.qty > size) throw new EngineError('quote_changed', `${who} only shows ${size} at ${px}.`);
  const lim = spec.positionLimit;
  const mine = b.positions[pid] ?? 0;
  const theirs = b.positions[cmd.targetId] ?? 0;
  if (buy ? mine + cmd.qty > lim : mine - cmd.qty < -lim) throw new EngineError('limit', `That would take you past your ${spec.short.toLowerCase()} position limit of ${lim} lots ${buy ? 'long' : 'short'}.`);
  if (buy ? theirs - cmd.qty < -lim : theirs + cmd.qty > lim)
    throw new EngineError('limit_target', `${who} is at their position limit and can only fill ${available(r, cmd.targetId, buy ? 'ask' : 'bid', m)}.`);

  const buyerId = buy ? pid : cmd.targetId;
  const sellerId = buy ? cmd.targetId : pid;
  const rebate = r.type === 'makers' && r.roles[cmd.targetId] === 'maker' ? spec.rebate * cmd.qty : 0;
  const t: Trade = {
    id: ctx.newId(),
    market: m,
    seq: r.trades.length + 1,
    at: ctx.now,
    buyerId,
    sellerId,
    aggressorId: pid,
    restingId: cmd.targetId,
    price: px,
    qty: cmd.qty,
    rebate,
    buyerFv: playerFv(r, buyerId, m),
    sellerFv: playerFv(r, sellerId, m),
    publicFv: publicFv(r, m),
    restingQuoteId: q.id,
    restingBid: q.bid,
    restingAsk: q.ask,
    restingFvAtPost: q.fvAtPost,
  };
  b.positions[buyerId] = (b.positions[buyerId] ?? 0) + cmd.qty;
  b.positions[sellerId] = (b.positions[sellerId] ?? 0) - cmd.qty;
  b.cash[buyerId] = (b.cash[buyerId] ?? 0) - px * cmd.qty;
  b.cash[sellerId] = (b.cash[sellerId] ?? 0) + px * cmd.qty;
  if (rebate) {
    b.cash[cmd.targetId] += rebate;
    b.rebates[cmd.targetId] = (b.rebates[cmd.targetId] ?? 0) + rebate;
  }
  if (buy) q.askSize -= cmd.qty;
  else q.bidSize -= cmd.qty;
  r.trades.push(t);
  b.lastPrice = px;
  touchUptime(room, cmd.targetId, ctx.now, m);
  return { message: `${buy ? 'Bought' : 'Sold'} ${cmd.qty} ${m === 'product' ? 'product ' : ''}${buy ? 'from' : 'to'} ${who} at ${px}.` };
}

/** Bring a room saved by an older version up to the current shape. */
export function upgradeRoom(room: RoomState): void {
  const c = room.config;
  c.productMarket ??= false;
  c.privateStart ??= DEFAULT_PRIVATE_START;
  c.privatePerReveal ??= DEFAULT_PRIVATE_PER_REVEAL;
  c.cluesPerReveal ??= DEFAULT_CLUES_PER_REVEAL;
  c.revealEveryMs ??= DEFAULT_REVEAL_EVERY_MS;
  c.shockCount ??= DEFAULT_SHOCK_COUNT;
  for (const res of room.results) res.markets ??= { sum: { settlement: res.settlement, pnl: res.pnl, volume: res.volume } };
  room.reviews = room.reviews.map((rv: any) => (rv.markets ? rv : combineReviews(rv.roundNumber, rv.playerId, rv.startedAt, { sum: { items: rv.items, summary: rv.summary } })));
  const r = room.round as any;
  if (r && !r.books) {
    // A round from before two markets existed cannot resume; close the session cleanly.
    room.round = null;
    room.phase = 'finished';
    room.phaseDeadline = null;
  }
}
