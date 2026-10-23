import { createHash, randomInt, randomUUID } from 'node:crypto';
import { DEFAULT_POOL_VERSION } from '../shared/catalog.js';
import { DEFAULT_DURATIONS, DEFAULT_ROUNDS, MAX_ROUNDS, MIN_ROUNDS } from '../shared/rules.js';
import type { Command, Receipt } from '../shared/types.js';
import type { Db } from './db.js';
import { type Actor, type Env, advancePhase, applyCommand, joinRoom } from './engine/room.js';
import { Changes, type Ctx, EngineError, type Player, type RoomState, draftRoom } from './engine/state.js';
import { activeRoomIds, commit, findReceipt, insertNewRoom, insertReceipt, loadRoom, roomIdByCode } from './persist.js';

export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

export const cryptoEnv: Env = {
  dealSeed: () => randomInt(0, 2 ** 31),
  drawFor: () => () => randomInt(1, 7),
};

export type CommitListener = (room: RoomState, changes: Changes) => void;

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function normalizeCode(code: unknown): string {
  return typeof code === 'string' ? code.trim().toUpperCase().replace(/[^A-Z0-9]/g, '') : '';
}

function validToken(t: unknown): t is string {
  return typeof t === 'string' && t.length >= 16 && t.length <= 200;
}

export class RoomManager {
  private rooms = new Map<string, RoomState>();
  private codes = new Map<string, string>();
  private locks = new Map<string, Promise<unknown>>();
  private receipts = new Map<string, Receipt>();
  private advancing = new Set<string>();
  private listeners: CommitListener[] = [];
  private presence = new Map<string, Map<string, number>>();

  constructor(
    public db: Db,
    public clock: Clock = systemClock,
    public env: Env = cryptoEnv,
  ) {}

  onCommit(fn: CommitListener): void {
    this.listeners.push(fn);
  }

  /** Load unfinished rooms and finish any overdue phase exactly once. */
  async init(): Promise<void> {
    for (const id of await activeRoomIds(this.db)) {
      const room = await loadRoom(this.db, id);
      if (room) this.register(room);
    }
    for (const id of this.rooms.keys()) await this.advanceDue(id);
  }

  private register(room: RoomState): void {
    this.rooms.set(room.id, room);
    this.codes.set(room.code, room.id);
  }

  getRoom(roomId: string): RoomState | undefined {
    return this.rooms.get(roomId);
  }

  allRooms(): RoomState[] {
    return [...this.rooms.values()];
  }

  async findByCode(code: unknown): Promise<RoomState | undefined> {
    const c = normalizeCode(code);
    if (!c) return undefined;
    const id = this.codes.get(c) ?? (await roomIdByCode(this.db, c));
    if (!id) return undefined;
    if (!this.rooms.has(id)) {
      const room = await loadRoom(this.db, id);
      if (room) this.register(room);
    }
    return this.rooms.get(id);
  }

  /** Commands for one room run strictly one at a time. */
  private serialize<T>(roomId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(roomId) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.locks.set(
      roomId,
      next.catch(() => {}),
    );
    return next;
  }

  private ctx(changes: Changes): Ctx {
    return { now: this.clock.now(), changes, newId: () => randomUUID() };
  }

  async createRoom(args: { hostToken: unknown; rounds?: unknown; devMode?: unknown }): Promise<RoomState> {
    if (!validToken(args.hostToken)) throw new EngineError('invalid_token', 'Missing host credential.');
    const rounds =
      typeof args.rounds === 'number' && Number.isInteger(args.rounds) && args.rounds >= MIN_ROUNDS && args.rounds <= MAX_ROUNDS
        ? args.rounds
        : DEFAULT_ROUNDS;
    for (let attempt = 0; attempt < 20; attempt++) {
      let code = '';
      for (let i = 0; i < 5; i++) code += CODE_ALPHABET[randomInt(0, CODE_ALPHABET.length)];
      if (this.codes.has(code) || (await roomIdByCode(this.db, code))) continue;
      const room: RoomState = {
        id: randomUUID(),
        code,
        hostHash: hashToken(args.hostToken),
        config: { rounds, durations: { ...DEFAULT_DURATIONS }, poolVersion: DEFAULT_POOL_VERSION, devMode: args.devMode === true },
        phase: 'lobby',
        roundNumber: 0,
        phaseDeadline: null,
        pausedRemainingMs: null,
        revision: 1,
        rosterFrozen: false,
        createdAt: this.clock.now(),
        players: {},
        round: null,
        completedRounds: [],
        reviews: [],
      };
      try {
        await insertNewRoom(this.db, room);
      } catch {
        continue; // code collision across processes
      }
      this.register(room);
      return room;
    }
    throw new Error('could not allocate a room code');
  }

  /** Resolve a credential to an actor. A room code alone never grants host rights. */
  authenticate(room: RoomState, token: unknown, asHost: boolean): Actor & { player?: Player } {
    if (!validToken(token)) return { kind: 'spectator' };
    const h = hashToken(token);
    if (asHost) return h === room.hostHash ? { kind: 'host' } : { kind: 'spectator' };
    const p = Object.values(room.players).find((x) => x.sessionHash === h);
    if (!p) return { kind: 'spectator' };
    return p.role === 'player' ? { kind: 'player', playerId: p.id, player: p } : { kind: 'spectator', player: p };
  }

  /** Join or reconnect. The client generates the session token so a retried join is idempotent. */
  async join(room: RoomState, args: { name: unknown; token: unknown; hostToken?: unknown }): Promise<Player> {
    if (!validToken(args.token)) throw new EngineError('invalid_token', 'Missing session credential.');
    const sessionHash = hashToken(args.token);
    const isHost = args.hostToken !== undefined && validToken(args.hostToken) && hashToken(args.hostToken) === room.hostHash;
    return this.serialize(room.id, async () => {
      const current = this.rooms.get(room.id)!;
      const existing = Object.values(current.players).find((p) => p.sessionHash === sessionHash);
      if (existing) return existing;
      if (args.hostToken !== undefined && !isHost) throw new EngineError('forbidden', 'Invalid host credential.');
      if (isHost && Object.values(current.players).some((p) => p.isHost)) {
        throw new EngineError('duplicate', 'The host is already playing.');
      }
      const draft = draftRoom(current);
      const changes = new Changes();
      const p = joinRoom(draft, { name: args.name, sessionHash, isHost }, this.ctx(changes));
      draft.revision++;
      await commit(this.db, draft, current.revision, changes, null);
      this.finalize(draft, changes);
      return draft.players[p.id];
    });
  }

  /**
   * Run one mutating command: authenticate (done by caller), serialize, dedupe the
   * request ID, validate, commit everything plus the receipt in one transaction,
   * then broadcast the committed revision.
   */
  async command(roomId: string, actor: Actor, requestId: unknown, cmd: Command): Promise<Receipt> {
    if (typeof requestId !== 'string' || requestId.length < 1 || requestId.length > 100) {
      return { requestId: String(requestId), ok: false, code: 'invalid_request', error: 'Missing request ID.', revision: 0 };
    }
    if (actor.kind === 'spectator') {
      return { requestId, ok: false, code: 'forbidden', error: 'Spectators cannot change the game.', revision: 0 };
    }
    const actorId = actor.kind === 'host' ? 'host' : actor.playerId;
    const key = `${roomId}|${actorId}|${requestId}`;
    const receipt = await this.serialize(roomId, async () => {
      const cached = this.receipts.get(key) ?? (await findReceipt(this.db, roomId, actorId, requestId));
      if (cached) return cached;
      const current = this.rooms.get(roomId);
      if (!current) return { requestId, ok: false, code: 'not_found', error: 'Room not found.', revision: 0 };
      const draft = draftRoom(current);
      const changes = new Changes();
      try {
        applyCommand(draft, actor, cmd, this.ctx(changes), this.env);
      } catch (e) {
        if (!(e instanceof EngineError)) throw e;
        const rejected: Receipt = { requestId, ok: false, code: e.code, error: e.message, revision: current.revision };
        await insertReceipt(this.db, roomId, actorId, rejected).catch(() => {});
        this.receipts.set(key, rejected);
        return rejected;
      }
      draft.revision++;
      const ok: Receipt = { requestId, ok: true, revision: draft.revision, message: changes.message, data: changes.data };
      const removed = cmd.kind === 'removePlayer' ? [cmd.playerId] : [];
      await commit(this.db, draft, current.revision, changes, { actorId, receipt: ok }, removed);
      this.receipts.set(key, ok);
      this.finalize(draft, changes);
      return ok;
    });
    if (receipt.ok) await this.advanceDue(roomId);
    return receipt;
  }

  private finalize(draft: RoomState, changes: Changes): void {
    const round = draft.round;
    if (round) {
      // Append-only round logs are shared with the previous state and only grow after a commit.
      if (changes.trades.length) round.trades.push(...changes.trades);
      if (changes.decisions.length) round.decisions.push(...changes.decisions);
      for (const o of changes.orders.values()) {
        if (o.status !== 'open' && o.roundId === round.id && !round.closedOrders.some((c) => c.id === o.id)) round.closedOrders.push(o);
      }
    }
    this.rooms.set(draft.id, draft);
    for (const fn of this.listeners) {
      try {
        fn(draft, changes);
      } catch (e) {
        console.error('listener failed', e);
      }
    }
  }

  /** Run every due phase step. Safe to call repeatedly: a double-fired timer is a no-op. */
  async advanceDue(roomId: string): Promise<void> {
    await this.serialize(roomId, async () => {
      for (let step = 0; step < 10; step++) {
        const current = this.rooms.get(roomId);
        if (!current) return;
        const draft = draftRoom(current);
        const changes = new Changes();
        if (!advancePhase(draft, this.ctx(changes), this.env)) return;
        draft.revision++;
        await commit(this.db, draft, current.revision, changes, null);
        this.finalize(draft, changes);
      }
    });
  }

  /** Called by the server ticker; deadlines come from persisted state, not callbacks. */
  async tick(): Promise<void> {
    const now = this.clock.now();
    const due = [...this.rooms.values()].filter(
      (r) => r.pausedRemainingMs === null && (r.phase === 'settling' || (r.phaseDeadline !== null && now >= r.phaseDeadline)),
    );
    await Promise.all(
      due.map(async (r) => {
        if (this.advancing.has(r.id)) return;
        this.advancing.add(r.id);
        try {
          await this.advanceDue(r.id);
        } catch (e) {
          console.error('phase advance failed', r.id, e);
        } finally {
          this.advancing.delete(r.id);
        }
      }),
    );
  }

  // ------------------------------------------------------------ presence (ephemeral)

  setPresence(roomId: string, playerId: string, delta: 1 | -1): boolean {
    let m = this.presence.get(roomId);
    if (!m) this.presence.set(roomId, (m = new Map()));
    const before = (m.get(playerId) ?? 0) > 0;
    const n = Math.max(0, (m.get(playerId) ?? 0) + delta);
    if (n === 0) m.delete(playerId);
    else m.set(playerId, n);
    return before !== n > 0;
  }

  isConnected(roomId: string, playerId: string): boolean {
    const p = this.rooms.get(roomId)?.players[playerId];
    if (p?.isBot) return true;
    return (this.presence.get(roomId)?.get(playerId) ?? 0) > 0;
  }

  connectedIds(roomId: string): string[] {
    return [...(this.presence.get(roomId)?.keys() ?? [])];
  }
}
