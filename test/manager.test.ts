import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { type Db, openDb } from '../src/server/db.js';
import type { Env } from '../src/server/engine/room.js';
import { RoomManager } from '../src/server/manager.js';
import { buildSnapshot } from '../src/server/view.js';
import { DEFAULT_DURATIONS } from '../src/shared/rules.js';
import type { Command } from '../src/shared/types.js';

class FakeClock {
  t = 1_000_000;
  now() {
    return this.t;
  }
}

let seedN = 1;
const testEnv: Env = {
  dealSeed: () => seedN++,
  drawFor: () => {
    let i = 0;
    const faces = [2, 3, 4, 5, 6, 1, 6, 3];
    return () => faces[i++ % faces.length];
  },
};

const tok = () => randomUUID() + randomUUID();

async function setup(opts: { players?: number; rounds?: number; db?: Db } = {}) {
  const db = opts.db ?? (await openDb());
  const clock = new FakeClock();
  const m = new RoomManager(db, clock, testEnv);
  await m.init();
  const hostToken = tok();
  const room = await m.createRoom({ hostToken, rounds: opts.rounds ?? 2 });
  const players: { id: string; token: string }[] = [];
  for (let i = 0; i < (opts.players ?? 4); i++) {
    const token = tok();
    const p = await m.join(room, { name: `P${i}`, token });
    players.push({ id: p.id, token });
  }
  const host = { kind: 'host' as const };
  const as = (i: number) => ({ kind: 'player' as const, playerId: players[i].id });
  const cmd = (actor: any, c: Command, rid: string = randomUUID()) => m.command(room.id, actor, rid, c);
  const state = () => m.getRoom(room.id)!;
  const advanceTo = async (phase: string) => {
    for (let i = 0; i < 20 && state().phase !== phase; i++) {
      clock.t = Math.max(clock.t, state().phaseDeadline ?? clock.t);
      await m.tick();
    }
    expect(state().phase).toBe(phase);
  };
  return { db, m, clock, room, hostToken, players, host, as, cmd, state, advanceTo };
}

/** Find a type player i owns in the current round. */
function owned(s: ReturnType<RoomManager['getRoom']>, pid: string) {
  const a = s!.round!.accounts[pid];
  return s!.round!.pool.find((t) => a.positions[t] > 0)!;
}

describe('room lifecycle', () => {
  for (const rounds of [1, 2, 6]) {
    it(`runs a ${rounds}-round session to Finished`, async () => {
      const { cmd, host, state, advanceTo, clock, m } = await setup({ rounds });
      expect((await cmd(host, { kind: 'startSession' })).ok).toBe(true);
      for (let r = 1; r <= rounds; r++) {
        expect(state().phase).toBe('market');
        expect(state().roundNumber).toBe(r);
        const accts = Object.values(state().round!.accounts);
        expect(accts.every((a) => a.cash === 100 && a.shortDeductions === 0)).toBe(true);
        expect(state().round!.trades).toHaveLength(0);
        await advanceTo('selection');
        await advanceTo('reveal');
        await advanceTo('results');
        expect(state().completedRounds).toHaveLength(r);
        if (r < rounds) await advanceTo('market');
      }
      clock.t = state().phaseDeadline!;
      await m.tick();
      expect(state().phase).toBe('finished');
      expect(state().completedRounds).toHaveLength(rounds);
      expect(state().players[Object.keys(state().players)[0]].dealHistory).toHaveLength(rounds);
    });
  }

  it('locks settings and roster at start; late arrivals spectate', async () => {
    const { cmd, host, m, room, state } = await setup();
    expect((await cmd(host, { kind: 'setConfig', rounds: 3 })).ok).toBe(true);
    await cmd(host, { kind: 'startSession' });
    expect((await cmd(host, { kind: 'setConfig', rounds: 4 })).code).toBe('wrong_phase');
    const late = await m.join(room, { name: 'Late', token: tok() });
    expect(late.role).toBe('spectator');
    expect(state().round!.accounts[late.id]).toBeUndefined();
    expect(state().config.rounds).toBe(3);
  });

  it('requires two players and rejects duplicate names', async () => {
    const { cmd, host, m, room } = await setup({ players: 1 });
    expect((await cmd(host, { kind: 'startSession' })).code).toBe('too_few');
    await expect(m.join(room, { name: '  p0 ', token: tok() })).rejects.toMatchObject({ code: 'duplicate_name' });
  });

  it('reconnect with the same token restores the same identity', async () => {
    const { m, room, players } = await setup();
    const again = await m.join(room, { name: 'Different', token: players[0].token });
    expect(again.id).toBe(players[0].id);
  });

  it('cannot remove an active player after start', async () => {
    const { cmd, host, players } = await setup();
    await cmd(host, { kind: 'startSession' });
    expect((await cmd(host, { kind: 'removePlayer', playerId: players[0].id })).code).toBe('forbidden');
  });
});

describe('commands', () => {
  it('a retried request ID returns the original receipt without executing again', async () => {
    const { cmd, host, as, state } = await setup();
    await cmd(host, { kind: 'startSession' });
    const rid = 'fixed-request';
    const c: Command = { kind: 'placeLimitOrder', type: state().round!.pool[0], side: 'bid', price: 10, qty: 1 };
    const a = await cmd(as(0), c, rid);
    const b = await cmd(as(0), c, rid);
    expect(a.ok).toBe(true);
    expect(b).toEqual(a);
    expect(Object.keys(state().round!.openOrders)).toHaveLength(1);
  });

  it('retries survive a restart (receipt comes from the database)', async () => {
    const s = await setup();
    await s.cmd(s.host, { kind: 'startSession' });
    const c: Command = { kind: 'placeLimitOrder', type: s.state().round!.pool[0], side: 'bid', price: 10, qty: 1 };
    const a = await s.cmd(s.as(0), c, 'rid-1');
    const m2 = new RoomManager(s.db, s.clock, testEnv);
    await m2.init();
    const b = await m2.command(s.room.id, s.as(0), 'rid-1', c);
    expect(b).toEqual(a);
    expect(Object.keys(m2.getRoom(s.room.id)!.round!.openOrders)).toHaveLength(1);
  });

  it('concurrent accepts of the final unit produce exactly one fill', async () => {
    const { cmd, host, as, state, players } = await setup({ players: 6 });
    await cmd(host, { kind: 'startSession' });
    const t = owned(state(), players[0].id);
    await cmd(as(0), { kind: 'placeLimitOrder', type: t, side: 'ask', price: 5, qty: 1 });
    const orderId = Object.keys(state().round!.openOrders)[0];
    const results = await Promise.all(
      [1, 2, 3, 4, 5].map((i) => cmd(as(i), { kind: 'acceptQuote', orderId, expectedRemaining: 1, qty: 1 })),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => r.code === 'stale_quote')).toHaveLength(4);
    expect(state().round!.trades).toHaveLength(1);
  });

  it('simultaneous cancel and accept never duplicates money or inventory', async () => {
    const { cmd, host, as, state, players } = await setup();
    await cmd(host, { kind: 'startSession' });
    const t = owned(state(), players[0].id);
    await cmd(as(0), { kind: 'placeLimitOrder', type: t, side: 'ask', price: 5, qty: 1 });
    const orderId = Object.keys(state().round!.openOrders)[0];
    const [x, y] = await Promise.all([
      cmd(as(0), { kind: 'cancelOrder', orderId }),
      cmd(as(1), { kind: 'acceptQuote', orderId, expectedRemaining: 1, qty: 1 }),
    ]);
    expect([x.ok, y.ok].filter(Boolean)).toHaveLength(1);
    const cash = Object.values(state().round!.accounts).reduce((a, b) => a + b.cash, 0);
    expect(cash).toBe(400);
  });

  it('rejects market commands at or after the deadline even before the timer runs', async () => {
    const { cmd, host, as, state, clock } = await setup();
    await cmd(host, { kind: 'startSession' });
    clock.t = state().phaseDeadline!;
    const r = await cmd(as(0), { kind: 'placeLimitOrder', type: state().round!.pool[0], side: 'bid', price: 5, qty: 1 });
    expect(r.ok).toBe(false);
    expect(['deadline', 'wrong_phase']).toContain(r.code);
    expect(Object.keys(state().round!.openOrders)).toHaveLength(0);
  });

  it('spectators and players cannot use host controls; the room code is not host authorization', async () => {
    const { cmd, as, m, room, state } = await setup();
    expect((await cmd(as(0), { kind: 'startSession' })).code).toBe('forbidden');
    expect((await m.command(room.id, { kind: 'spectator' }, 'x', { kind: 'startSession' })).code).toBe('forbidden');
    expect(m.authenticate(state(), room.code, true).kind).toBe('spectator');
  });

  it('isolates rooms and credentials', async () => {
    const a = await setup();
    const roomB = await a.m.createRoom({ hostToken: tok() });
    // Room A's host token gives no rights in room B, and A's players are strangers there.
    expect(a.m.authenticate(roomB, a.hostToken, true).kind).toBe('spectator');
    expect(a.m.authenticate(roomB, a.players[0].token, false).kind).toBe('spectator');
    const r = await a.m.command(roomB.id, a.as(0), 'x', { kind: 'setReady', ready: true });
    expect(r.ok).toBe(false);
  });

  it('pause blocks trading and preserves remaining time', async () => {
    const { cmd, host, as, state, clock, m } = await setup();
    await cmd(host, { kind: 'startSession' });
    clock.t += 60_000;
    await cmd(host, { kind: 'pauseRoom' });
    expect(state().pausedRemainingMs).toBe(DEFAULT_DURATIONS.marketMs - 60_000);
    const r = await cmd(as(0), { kind: 'placeLimitOrder', type: state().round!.pool[0], side: 'bid', price: 5, qty: 1 });
    expect(r.code).toBe('paused');
    clock.t += 10 * 60_000;
    await m.tick();
    expect(state().phase).toBe('market');
    await cmd(host, { kind: 'resumeRoom' });
    expect(state().phaseDeadline).toBe(clock.t + DEFAULT_DURATIONS.marketMs - 60_000);
  });

  it('host cannot advance out of an active market without test mode', async () => {
    const { cmd, host } = await setup();
    await cmd(host, { kind: 'startSession' });
    expect((await cmd(host, { kind: 'devSkipPhase' })).code).toBe('forbidden');
    expect((await cmd(host, { kind: 'advanceResults' })).code).toBe('wrong_phase');
  });
});

describe('phase transitions and persistence', () => {
  it('a double-fired timer settles once, and dice are hidden until reveal', async () => {
    const { cmd, host, as, state, clock, m, players, room, db } = await setup();
    await cmd(host, { kind: 'startSession' });
    // Player 1 shorts something player 0 buys.
    const t = state().round!.pool.find((x) => state().round!.accounts[players[1].id].positions[x] === 0)!;
    await cmd(as(0), { kind: 'placeLimitOrder', type: t, side: 'bid', price: 20, qty: 1 });
    await cmd(as(1), { kind: 'placeLimitOrder', type: t, side: 'ask', price: 20, qty: 1 });
    expect(state().round!.accounts[players[1].id].positions[t]).toBe(-1);
    clock.t = state().phaseDeadline!;
    await Promise.all([m.tick(), m.tick(), m.advanceDue(room.id), m.tick()]);
    expect(state().phase).toBe('selection');
    expect(state().round!.settlements).toHaveLength(1);
    expect(state().round!.accounts[players[1].id].shortDeductions).toBe(20);
    const rows = await db.query(`SELECT count(*)::int AS n FROM settlements`);
    expect(rows.rows[0].n).toBe(1);
    // No future dice: none generated or exposed during selection.
    expect(Object.keys(state().round!.dice)).toHaveLength(0);
    const snap = buildSnapshot(state(), as(0), clock.t, () => true);
    expect(snap.round!.dice).toBeNull();
    expect(JSON.stringify(snap)).not.toMatch(/sessionHash|hostHash|dealSeed|session_hash/);
    clock.t = state().phaseDeadline!;
    await Promise.all([m.tick(), m.tick()]);
    expect(state().phase).toBe('reveal');
    const dice1 = structuredClone(state().round!.dice);
    // Refresh: a new snapshot (or a restarted server) returns the identical stored result.
    const m2 = new RoomManager(db, clock, testEnv);
    await m2.init();
    expect(m2.getRoom(room.id)!.round!.dice).toEqual(dice1);
    expect((await db.query(`SELECT count(*)::int AS n FROM dice_results`)).rows[0].n).toBe(4);
  });

  it('recovers from a crash between Settling and Selection exactly once', async () => {
    const real = await openDb();
    let failAt = Infinity;
    let calls = 0;
    const flaky: Db = {
      kind: real.kind,
      query: real.query.bind(real),
      exec: real.exec.bind(real),
      close: real.close.bind(real),
      tx: (fn) => {
        calls++;
        if (calls >= failAt) return Promise.reject(new Error('simulated crash'));
        return real.tx(fn);
      },
    };
    const s = await setup({ db: flaky });
    await s.cmd(s.host, { kind: 'startSession' });
    const t = s.state().round!.pool.find((x) => s.state().round!.accounts[s.players[1].id].positions[x] === 0)!;
    await s.cmd(s.as(0), { kind: 'placeLimitOrder', type: t, side: 'bid', price: 25, qty: 1 });
    await s.cmd(s.as(1), { kind: 'placeLimitOrder', type: t, side: 'ask', price: 25, qty: 1 });
    s.clock.t = s.state().phaseDeadline!;
    failAt = calls + 2; // market->settling commits, the settlement transaction "crashes"
    const origError = console.error;
    console.error = () => {};
    await s.m.tick();
    console.error = origError;
    const persisted = await real.query(`SELECT phase FROM rooms WHERE id=$1`, [s.room.id]);
    expect(persisted.rows[0].phase).toBe('settling');
    failAt = Infinity;
    const m2 = new RoomManager(real, s.clock, testEnv);
    await m2.init();
    const room = m2.getRoom(s.room.id)!;
    expect(room.phase).toBe('selection');
    expect(room.round!.accounts[s.players[1].id].shortDeductions).toBe(25);
    await m2.tick();
    await m2.advanceDue(s.room.id);
    expect((await real.query(`SELECT count(*)::int AS n FROM settlements`)).rows[0].n).toBe(1);
    const ledger = await real.query(`SELECT count(*)::int AS n FROM ledger WHERE kind='score_deduction'`);
    expect(ledger.rows[0].n).toBe(1);
  });

  it('next round resets market data while previous results persist', async () => {
    const { cmd, host, as, state, advanceTo, players } = await setup();
    await cmd(host, { kind: 'startSession' });
    const t = owned(state(), players[0].id);
    await cmd(as(1), { kind: 'placeLimitOrder', type: t, side: 'bid', price: 30, qty: 1 });
    await cmd(as(0), { kind: 'placeLimitOrder', type: t, side: 'ask', price: 30, qty: 1 });
    await advanceTo('results');
    const r1 = state().completedRounds[0];
    expect(r1.upgrades.find((u) => u.type === t)!.highPrice).toBe(30);
    await advanceTo('market');
    const r2 = state().round!;
    expect(r2.number).toBe(2);
    expect(r2.trades).toHaveLength(0);
    expect(Object.values(r2.upgrades).every((u) => u.highPrice === null && u.volume === 0)).toBe(true);
    expect(Object.values(r2.accounts).every((a) => a.cash === 100 && Object.values(a.positions).reduce((x, y) => x + y, 0) === 1)).toBe(true);
    expect(state().completedRounds[0]).toEqual(r1);
  });

  it('equipment selection validates ownership and the fallback fills empty slots', async () => {
    const { cmd, host, as, state, advanceTo, players } = await setup();
    await cmd(host, { kind: 'startSession' });
    await advanceTo('selection');
    const acct = state().round!.accounts[players[0].id];
    expect(acct.equipment).toEqual([acct.startingUpgrade]);
    const notOwned = state().round!.pool.find((t) => acct.positions[t] <= 0)!;
    expect((await cmd(as(0), { kind: 'selectEquipment', types: [notOwned] })).code).toBe('not_owned');
    expect((await cmd(as(0), { kind: 'selectEquipment', types: [] })).ok).toBe(true);
    await advanceTo('reveal');
    expect(state().round!.dice[players[0].id].resolution.equipment).toEqual([acct.startingUpgrade]);
  });
});
