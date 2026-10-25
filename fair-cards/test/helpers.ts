import { type Actor, addPlayer, applyCommand, type Ctx, newRoomState, type RoomState, tick } from '../src/server/engine.js';
import type { Command } from '../src/shared/types.js';

export class Harness {
  now = 1_000_000;
  room: RoomState;
  private n = 0;
  /** By default the classic single sum market with no clues, so fair values are exact. */
  constructor(players: number, opts: { types?: RoomState['config']['roundTypes']; seed?: number; cooldownMs?: number; product?: boolean; clues?: number } = {}) {
    this.room = newRoomState({ id: 'room', code: 'TEST1', hostHash: 'h', devMode: true, now: this.now });
    this.room.config.productMarket = opts.product ?? false;
    this.room.config.cluesPerReveal = opts.clues ?? 0;
    if (opts.types) this.room.config.roundTypes = opts.types;
    if (opts.cooldownMs !== undefined) this.room.config.quoteCooldownMs = opts.cooldownMs;
    this.seedValue = opts.seed ?? 12345;
    for (let i = 0; i < players; i++) addPlayer(this.room, { id: `p${i}`, name: `P${i}`, sessionHash: `s${i}`, isBot: false, isHost: false, now: this.now + i });
  }
  seedValue: number;
  ctx(): Ctx {
    return { now: this.now, newId: () => `id${++this.n}`, seed: () => this.seedValue };
  }
  host(cmd: Command) {
    return applyCommand(this.room, { kind: 'host' }, cmd, this.ctx());
  }
  as(pid: string, cmd: Command) {
    const actor: Actor = { kind: 'player', playerId: pid };
    tick(this.room, this.ctx());
    return applyCommand(this.room, actor, cmd, this.ctx());
  }
  advance(ms: number) {
    this.now += ms;
    tick(this.room, this.ctx());
  }
  /** Start the session and open the first market. */
  open() {
    this.host({ kind: 'start' });
    this.host({ kind: 'advance' });
  }
  get r() {
    return this.room.round!;
  }
  /** The sum market's book. */
  get b() {
    return this.room.round!.books.sum!;
  }
  get p() {
    return this.room.round!.books.product!;
  }
}
