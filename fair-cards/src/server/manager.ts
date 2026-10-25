import { createHash, randomInt, randomUUID } from 'node:crypto';
import type { PlayerRoundReview } from '../shared/review.js';
import type { Command, Receipt, Round } from '../shared/types.js';
import type { Db, Queryable } from './db.js';
import { type Actor, addPlayer, applyCommand, type Ctx, EngineError, newRoomState, nextDue, type Player, type RoomState, tick } from './engine.js';

export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

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

/** What has been written to fc_events for the current round, so commits only append the new tail. */
interface Persisted {
  round: number;
  trade: number;
  decision: number;
  info: number;
  reviews: number;
}

type EventKind = 'trade' | 'decision' | 'info';
const ARRAYS: Record<EventKind, 'trades' | 'decisions' | 'infoEvents'> = { trade: 'trades', decision: 'decisions', info: 'infoEvents' };

/** Room state as stored in fc_rooms: the round's append-only logs and reviews live in their own tables. */
function slim(room: RoomState): unknown {
  const { reviews: _r, round, ...rest } = room;
  if (!round) return { ...rest, round: null };
  const { trades: _t, decisions: _d, infoEvents: _i, ...r } = round;
  return { ...rest, round: r };
}

export type CommitListener = (room: RoomState) => void;

export class RoomManager {
  private rooms = new Map<string, RoomState>();
  private codes = new Map<string, string>();
  private persisted = new Map<string, Persisted>();
  private locks = new Map<string, Promise<unknown>>();
  private receipts = new Map<string, Receipt>();
  private listeners: CommitListener[] = [];

  constructor(
    public db: Db,
    public clock: Clock = systemClock,
    public seed: () => number = () => randomInt(0, 2 ** 31),
  ) {}

  onCommit(fn: CommitListener): void {
    this.listeners.push(fn);
  }

  async init(): Promise<void> {
    const { rows } = await this.db.query<{ id: string }>(`SELECT id FROM fc_rooms WHERE phase <> 'finished'`);
    for (const { id } of rows) await this.load(id);
    await this.tickAll();
  }

  private async load(id: string): Promise<RoomState | undefined> {
    const { rows } = await this.db.query<{ state: any; revision: number }>(`SELECT state, revision FROM fc_rooms WHERE id=$1`, [id]);
    if (!rows.length) return undefined;
    const room = (typeof rows[0].state === 'string' ? JSON.parse(rows[0].state) : rows[0].state) as RoomState;
    room.revision = rows[0].revision;
    const p: Persisted = { round: room.round?.number ?? 0, trade: 0, decision: 0, info: 0, reviews: 0 };
    if (room.round) {
      const r = room.round as Round;
      r.trades = [];
      r.decisions = [];
      r.infoEvents = [];
      const ev = await this.db.query<{ kind: EventKind; data: any }>(`SELECT kind, data FROM fc_events WHERE room_id=$1 AND round_number=$2 ORDER BY kind, seq`, [id, r.number]);
      for (const e of ev.rows) (r[ARRAYS[e.kind]] as unknown[]).push(typeof e.data === 'string' ? JSON.parse(e.data) : e.data);
      p.trade = r.trades.length;
      p.decision = r.decisions.length;
      p.info = r.infoEvents.length;
    }
    const rv = await this.db.query<{ data: any }>(`SELECT data FROM fc_reviews WHERE room_id=$1 ORDER BY round_number, player_id`, [id]);
    room.reviews = rv.rows.map((x) => (typeof x.data === 'string' ? JSON.parse(x.data) : x.data) as PlayerRoundReview);
    p.reviews = room.reviews.length;
    this.rooms.set(id, room);
    this.codes.set(room.code, id);
    this.persisted.set(id, p);
    return room;
  }

  getRoom(id: string): RoomState | undefined {
    return this.rooms.get(id);
  }

  allRooms(): RoomState[] {
    return [...this.rooms.values()];
  }

  async findByCode(code: unknown): Promise<RoomState | undefined> {
    const c = normalizeCode(code);
    if (!c) return undefined;
    let id = this.codes.get(c);
    if (!id) {
      const { rows } = await this.db.query<{ id: string }>(`SELECT id FROM fc_rooms WHERE code=$1`, [c]);
      if (!rows.length) return undefined;
      id = rows[0].id;
    }
    return this.rooms.get(id) ?? (await this.load(id));
  }

  private serialize<T>(roomId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(roomId) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.locks.set(
      roomId,
      next.catch(() => {}),
    );
    return next;
  }

  private ctx(): Ctx {
    return { now: this.clock.now(), newId: () => randomUUID(), seed: this.seed };
  }

  async createRoom(args: { hostToken: unknown; devMode?: unknown }): Promise<RoomState> {
    if (!validToken(args.hostToken)) throw new EngineError('invalid_token', 'Missing host credential.');
    for (let attempt = 0; attempt < 20; attempt++) {
      let code = '';
      for (let i = 0; i < 5; i++) code += CODE_ALPHABET[randomInt(0, CODE_ALPHABET.length)];
      if (this.codes.has(code)) continue;
      const now = this.clock.now();
      const room = newRoomState({ id: randomUUID(), code, hostHash: hashToken(args.hostToken), devMode: args.devMode === true, now });
      try {
        await this.db.query(`INSERT INTO fc_rooms (id, code, phase, revision, state, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$6)`, [
          room.id,
          code,
          room.phase,
          room.revision,
          JSON.stringify(slim(room)),
          now,
        ]);
      } catch {
        continue; // code collision
      }
      this.rooms.set(room.id, room);
      this.codes.set(code, room.id);
      this.persisted.set(room.id, { round: 0, trade: 0, decision: 0, info: 0, reviews: 0 });
      return room;
    }
    throw new Error('could not allocate a room code');
  }

  authenticate(room: RoomState, token: unknown, asHost: boolean): { actor: Actor; player: Player | null } {
    if (!validToken(token)) return { actor: { kind: 'spectator' }, player: null };
    const h = hashToken(token);
    if (asHost) return h === room.hostHash ? { actor: { kind: 'host' }, player: null } : { actor: { kind: 'spectator' }, player: null };
    const p = Object.values(room.players).find((x) => x.sessionHash === h);
    return p ? { actor: { kind: 'player', playerId: p.id }, player: p } : { actor: { kind: 'spectator' }, player: null };
  }

  async join(room: RoomState, args: { name: unknown; token: unknown; hostToken?: unknown }): Promise<Player> {
    if (!validToken(args.token)) throw new EngineError('invalid_token', 'Missing session credential.');
    const hash = hashToken(args.token);
    const isHost = validToken(args.hostToken) && hashToken(args.hostToken) === room.hostHash;
    let joined: Player | null = null;
    await this.mutate(room.id, (draft, ctx) => {
      const existing = Object.values(draft.players).find((p) => p.sessionHash === hash);
      if (existing) {
        joined = existing;
        return false;
      }
      joined = addPlayer(draft, { id: ctx.newId(), name: typeof args.name === 'string' ? args.name : '', sessionHash: hash, isBot: false, isHost, now: ctx.now });
      return true;
    });
    return joined!;
  }

  /** Run fn on a copy of the room; if it reports a change, commit with an optimistic revision check. */
  private mutate(roomId: string, fn: (draft: RoomState, ctx: Ctx) => boolean, receipt?: { actorKey: string; receipt: Receipt }): Promise<RoomState> {
    return this.serialize(roomId, async () => {
      const room = this.rooms.get(roomId);
      if (!room) throw new EngineError('no_room', 'Room not found.');
      const draft = structuredClone(room);
      const ctx = this.ctx();
      const changed = fn(draft, ctx);
      if (!changed && !receipt) return room;
      if (changed) draft.revision = room.revision + 1;
      await this.commit(room, draft, ctx.now, changed, receipt);
      this.rooms.set(roomId, draft);
      if (changed) for (const l of this.listeners) l(draft);
      return draft;
    });
  }

  private async commit(prev: RoomState, next: RoomState, now: number, changed: boolean, receipt?: { actorKey: string; receipt: Receipt }): Promise<void> {
    const p = this.persisted.get(prev.id)!;
    const np: Persisted = { ...p };
    await this.db.tx(async (q: Queryable) => {
      if (changed) {
        const r = await q.query(`UPDATE fc_rooms SET state=$1, revision=$2, phase=$3, updated_at=$4 WHERE id=$5 AND revision=$6`, [
          JSON.stringify(slim(next)),
          next.revision,
          next.phase,
          now,
          next.id,
          prev.revision,
        ]);
        if (r.rowCount !== 1) throw new Error('revision conflict');
        const r2 = next.round;
        if (r2) {
          if (np.round !== r2.number) Object.assign(np, { round: r2.number, trade: 0, decision: 0, info: 0 });
          for (const kind of Object.keys(ARRAYS) as EventKind[]) {
            const arr = r2[ARRAYS[kind]] as unknown[];
            for (let i = np[kind]; i < arr.length; i++) {
              await q.query(`INSERT INTO fc_events (room_id, round_number, kind, seq, data) VALUES ($1,$2,$3,$4,$5)`, [next.id, r2.number, kind, i, JSON.stringify(arr[i])]);
            }
            np[kind] = arr.length;
          }
        }
        for (let i = np.reviews; i < next.reviews.length; i++) {
          const rv = next.reviews[i];
          await q.query(`INSERT INTO fc_reviews (room_id, round_number, player_id, data) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [next.id, rv.roundNumber, rv.playerId, JSON.stringify(rv)]);
        }
        np.reviews = next.reviews.length;
      }
      if (receipt) {
        await q.query(`INSERT INTO fc_receipts (room_id, actor_key, request_id, receipt) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [
          next.id,
          receipt.actorKey,
          receipt.receipt.requestId,
          JSON.stringify(receipt.receipt),
        ]);
      }
    });
    this.persisted.set(prev.id, np);
  }

  /** Idempotent command: a retried request ID returns the original receipt. */
  async command(roomId: string, actor: Actor, requestId: unknown, cmd: Command): Promise<Receipt> {
    const rid = typeof requestId === 'string' && requestId.length <= 100 ? requestId : '';
    if (!rid) return { requestId: String(requestId), ok: false, error: 'Missing request id.' };
    const actorKey = actor.kind === 'player' ? `p:${actor.playerId}` : actor.kind;
    const key = `${roomId}|${actorKey}|${rid}`;
    const cached = this.receipts.get(key);
    if (cached) return cached;
    const { rows } = await this.db.query<{ receipt: any }>(`SELECT receipt FROM fc_receipts WHERE room_id=$1 AND actor_key=$2 AND request_id=$3`, [roomId, actorKey, rid]);
    if (rows.length) return typeof rows[0].receipt === 'string' ? JSON.parse(rows[0].receipt) : rows[0].receipt;

    // The receipt commits in the same transaction as the change it describes.
    const holder = { actorKey, receipt: { requestId: rid, ok: true } as Receipt };
    try {
      await this.mutate(
        roomId,
        (draft, ctx) => {
          // Bring the room up to date first so commands see the current information stage.
          tick(draft, ctx);
          const res = applyCommand(draft, actor, cmd, ctx, { newBotId: () => `bot-${randomUUID()}` });
          holder.receipt = { requestId: rid, ok: true, message: res.message };
          return true;
        },
        holder,
      );
    } catch (e) {
      if (e instanceof EngineError) holder.receipt = { requestId: rid, ok: false, code: e.code, error: e.message };
      else throw e;
    }
    this.receipts.set(key, holder.receipt);
    if (this.receipts.size > 20_000) this.receipts.delete(this.receipts.keys().next().value!);
    return holder.receipt;
  }

  /** Advance every room whose deadline or information drop is due. */
  async tickAll(): Promise<void> {
    const now = this.clock.now();
    await Promise.all(
      [...this.rooms.values()]
        .filter((r) => {
          const due = nextDue(r);
          return due !== null && due <= now;
        })
        .map((r) => this.mutate(r.id, (draft, ctx) => tick(draft, ctx)).catch((e) => console.error('tick failed', r.code, e))),
    );
  }
}
