import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDb } from '../src/server/db.js';
import { RoomManager } from '../src/server/manager.js';
import { DEFAULT_DURATIONS } from '../src/shared/rules.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function clock(start = 5_000_000) {
  const c = { t: start, now: () => c.t };
  return c;
}

describe('room manager', () => {
  it('persists, restarts mid-round, and replays receipts idempotently', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fc-'));
    dirs.push(dir);
    const c = clock();
    let db = await openDb({ pgliteDir: dir });
    let m = new RoomManager(db, c, () => 99);
    const room = await m.createRoom({ hostToken: 'h'.repeat(32), devMode: true });
    const a = await m.join(room, { name: 'Ann', token: 'a'.repeat(32) });
    const b = await m.join(room, { name: 'Bob', token: 'b'.repeat(32) });
    expect((await m.join(room, { name: 'Ann again', token: 'a'.repeat(32) })).id).toBe(a.id);
    const host = { kind: 'host' } as const;
    expect((await m.command(room.id, host, 'r1', { kind: 'start' })).ok).toBe(true);
    expect((await m.command(room.id, host, 'r2', { kind: 'advance' })).ok).toBe(true);
    const A = { kind: 'player', playerId: a.id } as const;
    const B = { kind: 'player', playerId: b.id } as const;
    expect((await m.command(room.id, A, 'q1', { kind: 'setQuote', bid: 68, ask: 72, size: 2 })).ok).toBe(true);
    expect((await m.command(room.id, B, 'q2', { kind: 'setQuote', bid: 67, ask: 71, size: 1 })).ok).toBe(true);
    const t1 = await m.command(room.id, B, 't1', { kind: 'trade', targetId: a.id, side: 'buy', qty: 1, price: 72 });
    expect(t1.ok).toBe(true);
    // Same request again: same receipt, no second trade.
    expect(await m.command(room.id, B, 't1', { kind: 'trade', targetId: a.id, side: 'buy', qty: 1, price: 72 })).toEqual(t1);
    expect(m.getRoom(room.id)!.round!.trades).toHaveLength(1);
    c.t += DEFAULT_DURATIONS.marketMs * 0.3;
    await m.tickAll();
    const before = m.getRoom(room.id)!;
    expect(before.round!.revealed).toBe(2);
    await db.close();

    // Restart from disk.
    db = await openDb({ pgliteDir: dir });
    m = new RoomManager(db, c, () => 99);
    await m.init();
    const after = (await m.findByCode(room.code))!;
    expect(after.revision).toBe(before.revision);
    expect(after.round!.trades).toEqual(before.round!.trades);
    expect(after.round!.decisions).toEqual(before.round!.decisions);
    expect(after.round!.infoEvents).toEqual(before.round!.infoEvents);
    expect(after.round!.books.sum!.positions).toEqual(before.round!.books.sum!.positions);
    // Receipt survives the restart.
    expect(await m.command(room.id, B, 't1', { kind: 'trade', targetId: a.id, side: 'buy', qty: 1, price: 72 })).toEqual(t1);
    expect(m.getRoom(room.id)!.round!.trades).toHaveLength(1);

    // Overdue close happens once on the next tick, and reviews persist.
    c.t += DEFAULT_DURATIONS.marketMs;
    await m.tickAll();
    expect(m.getRoom(room.id)!.phase).toBe('results');
    expect(m.getRoom(room.id)!.reviews).toHaveLength(2);
    await db.close();
    db = await openDb({ pgliteDir: dir });
    m = new RoomManager(db, c, () => 99);
    await m.init();
    const again = (await m.findByCode(room.code))!;
    expect(again.reviews).toHaveLength(2);
    expect(again.results).toHaveLength(1);
    await db.close();
  });

  it('rejects bad input cleanly', async () => {
    const db = await openDb({ memory: true });
    const m = new RoomManager(db, clock());
    const room = await m.createRoom({ hostToken: 'h'.repeat(32) });
    await expect(m.join(room, { name: '', token: 'x'.repeat(32) })).rejects.toThrow(/name/);
    const p = await m.join(room, { name: 'Zed', token: 'z'.repeat(32) });
    await expect(m.join(room, { name: 'zed', token: 'y'.repeat(32) })).rejects.toThrow(/taken/);
    const r = await m.command(room.id, { kind: 'player', playerId: p.id }, 'x', { kind: 'start' });
    expect(r.ok).toBe(false);
    const bots = await m.command(room.id, { kind: 'host' }, 'y', { kind: 'addBots', count: 3 });
    expect(bots.ok).toBe(false); // not test mode
    await db.close();
  });
});
