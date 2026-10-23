import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { type Db, openDb } from '../src/server/db.js';
import type { Env } from '../src/server/engine/room.js';
import { RoomManager } from '../src/server/manager.js';
import { buildSnapshot } from '../src/server/view.js';
import type { UpgradeId } from '../src/shared/catalog.js';
import type { Command } from '../src/shared/types.js';

class FakeClock {
  t = 2_000_000;
  now() {
    return this.t;
  }
}

let seedN = 100;
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
  const room = await m.createRoom({ hostToken: tok(), rounds: opts.rounds ?? 1 });
  const players: string[] = [];
  for (let i = 0; i < (opts.players ?? 4); i++) players.push((await m.join(room, { name: `P${i}`, token: tok() })).id);
  const host = { kind: 'host' as const };
  const as = (i: number) => ({ kind: 'player' as const, playerId: players[i] });
  const cmd = (actor: any, c: Command) => m.command(room.id, actor, randomUUID(), c);
  const state = () => m.getRoom(room.id)!;
  const advanceTo = async (phase: string) => {
    for (let i = 0; i < 20 && state().phase !== phase; i++) {
      clock.t = Math.max(clock.t, state().phaseDeadline ?? clock.t);
      await m.tick();
    }
    expect(state().phase).toBe(phase);
  };
  await cmd(host, { kind: 'startSession' });
  return { db, m, clock, room, players, host, as, cmd, state, advanceTo };
}

/** A pool type player i owns, and one they do not. */
function types(s: ReturnType<RoomManager['getRoom']>, pid: string) {
  const a = s!.round!.accounts[pid];
  return {
    owned: s!.round!.pool.find((t) => a.positions[t] > 0) as UpgradeId,
    notOwned: s!.round!.pool.find((t) => a.positions[t] === 0) as UpgradeId,
  };
}

describe('decision log', () => {
  it('logs accepted decisions with before-state, revision and trade ids; rejections are not logged', async () => {
    const { cmd, as, state, players, db } = await setup();
    const t = types(state(), players[0]).owned;

    const r1 = await cmd(as(1), { kind: 'placeLimitOrder', type: t, side: 'bid', price: 12, qty: 1 });
    expect(r1.ok).toBe(true);
    const d1 = state().round!.decisions.at(-1)!;
    expect(d1).toMatchObject({ kind: 'order', playerId: players[1], revision: r1.revision, tradeIds: [] });
    expect(d1.order).toMatchObject({ type: t, side: 'bid', price: 12, qty: 1 });
    expect(d1.before).toMatchObject({ cash: 100, spendable: 100 });
    expect(d1.before.highs[t]).toBeNull();

    // Rejected command: price out of range. Nothing logged.
    const n = state().round!.decisions.length;
    expect((await cmd(as(2), { kind: 'placeLimitOrder', type: t, side: 'bid', price: 0, qty: 1 })).ok).toBe(false);
    expect(state().round!.decisions).toHaveLength(n);

    // Player 0 sells into the resting bid: immediate fill for P0, passive fill for P1's logged order.
    const r2 = await cmd(as(0), { kind: 'placeLimitOrder', type: t, side: 'ask', price: 10, qty: 1 });
    expect(r2.ok).toBe(true);
    const d2 = state().round!.decisions.at(-1)!;
    const trade = state().round!.trades.at(-1)!;
    expect(d2.playerId).toBe(players[0]);
    expect(d2.tradeIds).toEqual([trade.id]);
    expect(d2.before.positions[t]).toBe(1);
    expect(d2.before.cash).toBe(100);
    expect(trade.restingOrderId).toBe(d1.order!.orderId);
    expect(trade.price).toBe(12);

    // Accept and cancel are logged with details; before-state reflects the earlier trade and high.
    await cmd(as(2), { kind: 'placeLimitOrder', type: t, side: 'ask', price: 20, qty: 1 }); // a short ask
    const ask = Object.values(state().round!.openOrders).find((o) => o.playerId === players[2])!;
    await cmd(as(3), { kind: 'placeLimitOrder', type: t, side: 'bid', price: 5, qty: 1 });
    const bid = Object.values(state().round!.openOrders).find((o) => o.playerId === players[3])!;
    const ra = await cmd(as(1), { kind: 'acceptQuote', orderId: ask.id, expectedRemaining: 1, qty: 1 });
    expect(ra.ok).toBe(true);
    const da = state().round!.decisions.at(-1)!;
    expect(da).toMatchObject({ kind: 'accept', playerId: players[1] });
    expect(da.accept).toEqual({ orderId: ask.id, type: t, takerSide: 'bid', price: 20, qty: 1 });
    expect(da.before.highs[t]).toBe(12);
    expect(da.before.cash).toBe(88);
    const rc = await cmd(as(3), { kind: 'cancelOrder', orderId: bid.id });
    expect(rc.ok).toBe(true);
    expect(state().round!.decisions.at(-1)).toMatchObject({ kind: 'cancel', cancel: { orderId: bid.id, side: 'bid', price: 5, remaining: 1 } });

    // Persisted in the same transaction as the commands.
    const rows = (await db.query(`SELECT kind, revision, payload FROM decisions WHERE round_id=$1 ORDER BY revision`, [state().round!.id])).rows;
    expect(rows.map((r) => r.kind)).toEqual(['order', 'order', 'order', 'order', 'accept', 'cancel']);
    expect(rows[0].payload).toEqual(d1);
  });

  it('sets closed_at on fill, cancel and market close, and keeps closed orders in memory', async () => {
    const { cmd, as, state, players, db, clock, advanceTo } = await setup();
    const t = types(state(), players[0]).owned;
    await cmd(as(1), { kind: 'placeLimitOrder', type: t, side: 'bid', price: 9, qty: 1 }); // filled below
    await cmd(as(0), { kind: 'placeLimitOrder', type: t, side: 'ask', price: 9, qty: 1 }); // incoming, fully filled
    await cmd(as(2), { kind: 'placeLimitOrder', type: t, side: 'bid', price: 3, qty: 1 }); // cancelled
    const cancelId = Object.values(state().round!.openOrders).find((o) => o.playerId === players[2])!.id;
    clock.t += 1000;
    const cancelAt = clock.t;
    await cmd(as(2), { kind: 'cancelOrder', orderId: cancelId });
    await cmd(as(3), { kind: 'placeLimitOrder', type: t, side: 'bid', price: 2, qty: 1 }); // closed at market close
    await advanceTo('selection');
    const closeAt = state().round!.marketClosedAt!;
    expect(closeAt).toBeGreaterThan(0);
    const rows = (await db.query(`SELECT player_id, status, closed_at FROM orders WHERE round_id=$1 ORDER BY seq`, [state().round!.id])).rows;
    expect(rows.map((r) => r.status)).toEqual(['filled', 'filled', 'cancelled', 'closed']);
    expect(rows.every((r) => r.closed_at !== null)).toBe(true);
    expect(Number(rows[2].closed_at)).toBe(cancelAt);
    expect(Number(rows[3].closed_at)).toBe(closeAt);
    expect(state().round!.closedOrders.map((o) => o.status).sort()).toEqual(['cancelled', 'closed', 'filled', 'filled']);
    const rr = (await db.query(`SELECT market_closed_at FROM rounds WHERE id=$1`, [state().round!.id])).rows[0];
    expect(Number(rr.market_closed_at)).toBe(closeAt);
  });

  it('logs equip_final with the auto flag', async () => {
    const { cmd, as, state, players, advanceTo } = await setup();
    await advanceTo('selection');
    const acct = state().round!.accounts[players[0]];
    // P0 explicitly keeps their single owned upgrade: final == submitted.
    expect((await cmd(as(0), { kind: 'selectEquipment', types: [acct.startingUpgrade] })).ok).toBe(true);
    // P1 clears the slots: the timeout rule refills them, so the final choice is automatic.
    expect((await cmd(as(1), { kind: 'selectEquipment', types: [] })).ok).toBe(true);
    await advanceTo('reveal');
    const finals = state().round!.decisions.filter((d) => d.kind === 'equip_final');
    expect(finals).toHaveLength(4);
    const by = (i: number) => finals.find((d) => d.playerId === players[i])!;
    expect(by(0).equip).toEqual({ types: [acct.startingUpgrade], auto: false });
    expect(by(1).equip!.auto).toBe(true);
    expect(by(2).equip!.auto).toBe(true); // never submitted
    expect(state().round!.decisions.filter((d) => d.kind === 'equip')).toHaveLength(2);
  });
});

describe('decision reviews', () => {
  it('are generated once at results, survive restart, and are private until finished', async () => {
    const { db, m, cmd, as, state, players, room, clock, host, advanceTo } = await setup({ rounds: 2 });
    const t = types(state(), players[0]).owned;
    await cmd(as(1), { kind: 'placeLimitOrder', type: t, side: 'bid', price: 12, qty: 1 });
    await cmd(as(0), { kind: 'placeLimitOrder', type: t, side: 'ask', price: 12, qty: 1 });
    await advanceTo('reveal');
    clock.t = state().phaseDeadline!;
    await Promise.all([m.tick(), m.tick(), m.advanceDue(room.id), m.tick()]);
    expect(state().phase).toBe('results');
    expect(state().reviews).toHaveLength(4);
    const count = async () => (await db.query(`SELECT count(*)::int AS n FROM decision_reviews`)).rows[0].n;
    expect(await count()).toBe(4);
    expect(state().reviews.every((r) => r.roundNumber === 1)).toBe(true);

    // Privacy during the session.
    const snap = (actor: any) => buildSnapshot(state(), actor, clock.t, () => true);
    const s0 = snap(as(0));
    expect(s0.reviews).toHaveLength(1);
    expect(s0.reviews[0].playerId).toBe(players[0]);
    expect(snap(as(1)).reviews.map((r) => r.playerId)).toEqual([players[1]]);
    expect(JSON.stringify(snap(as(1)))).not.toContain(`"playerId":"${players[0]}","items"`);
    expect(snap(host).reviews).toEqual([]);
    expect(snap({ kind: 'spectator' }).reviews).toEqual([]);

    // Restart: reviews, decisions and closed orders reload; no duplicate review on re-advance.
    const decisionsBefore = state().round!.decisions.length;
    const closedBefore = state().round!.closedOrders.length;
    const m2 = new RoomManager(db, clock, testEnv);
    await m2.init();
    const r2 = m2.getRoom(room.id)!;
    expect(r2.reviews).toHaveLength(4);
    expect(r2.round!.decisions).toHaveLength(decisionsBefore);
    expect(r2.round!.closedOrders).toHaveLength(closedBefore);
    await m2.advanceDue(room.id);
    expect(await count()).toBe(4);

    // Round 2 to finished: host now sees everyone's reviews for both rounds.
    for (let i = 0; i < 20 && r2.phase !== 'finished' && m2.getRoom(room.id)!.phase !== 'finished'; i++) {
      clock.t = Math.max(clock.t, m2.getRoom(room.id)!.phaseDeadline ?? clock.t);
      await m2.tick();
    }
    const fin = m2.getRoom(room.id)!;
    expect(fin.phase).toBe('finished');
    expect(await count()).toBe(8);
    expect(buildSnapshot(fin, host, clock.t, () => true).reviews).toHaveLength(8);
    expect(buildSnapshot(fin, as(2), clock.t, () => true).reviews.every((r) => r.playerId === players[2])).toBe(true);
  });
});
