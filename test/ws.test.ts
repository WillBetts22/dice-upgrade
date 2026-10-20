import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDb } from '../src/server/db.js';
import { RoomManager } from '../src/server/manager.js';
import { createAppServer } from '../src/server/server.js';
import { MAX_PLAYERS } from '../src/shared/rules.js';
import { SimClient, http } from '../src/tools/sim-client.js';

class FakeClock {
  t = Date.now();
  now() {
    return this.t;
  }
}

let base = '';
let manager: RoomManager;
let clock: FakeClock;
let close: () => void;

beforeAll(async () => {
  const db = await openDb();
  clock = new FakeClock();
  manager = new RoomManager(db, clock);
  await manager.init();
  const { server } = createAppServer(manager);
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => server.close();
});
afterAll(() => close());

async function advance(phase: string, host: SimClient) {
  for (let i = 0; i < 10 && manager.getRoom(host.snapshot!.roomId)!.phase !== phase; i++) {
    clock.t = Math.max(clock.t, manager.getRoom(host.snapshot!.roomId)!.phaseDeadline ?? clock.t);
    await manager.tick();
  }
  await host.until(() => host.snapshot!.phase === phase);
}

describe('websocket end to end', () => {
  it(`${MAX_PLAYERS} clients trade through a full 2-round session`, async () => {
    const hostToken = 'h'.repeat(40);
    const { code } = await http(base, '/api/rooms', { hostToken, rounds: 2 });
    const host = new SimClient(base, code, { asHost: true, token: hostToken });
    await host.connect();
    expect(host.snapshot!.you.kind).toBe('host');

    const players: SimClient[] = [];
    for (let i = 0; i < MAX_PLAYERS; i++) {
      const c = new SimClient(base, code);
      await http(base, `/api/rooms/${code.toLowerCase()}/join`, { name: `Player ${i}`, token: c.token });
      players.push(c);
    }
    await Promise.all(players.map((p) => p.connect()));
    expect(players.every((p) => p.snapshot!.you.kind === 'player')).toBe(true);
    // The 31st joiner is a spectator, and the projector needs no credential.
    const extra = new SimClient(base, code);
    await http(base, `/api/rooms/${code}/join`, { name: 'Extra', token: extra.token });
    await extra.connect();
    expect(extra.snapshot!.you.kind).toBe('spectator');
    expect((await extra.command({ kind: 'placeLimitOrder', type: 'extra_die', side: 'bid', price: 5, qty: 1 })).ok).toBe(false);

    // Snapshots never carry credentials.
    expect(JSON.stringify(host.snapshot)).not.toContain(hostToken);
    expect(JSON.stringify(players[0].snapshot)).not.toMatch(/sessionHash|hostHash|dealSeed/);

    // Players cannot drive host controls even with the room code.
    expect((await players[0].command({ kind: 'startSession' })).ok).toBe(false);
    expect((await host.command({ kind: 'startSession' })).ok).toBe(true);
    await Promise.all(players.map((p) => p.until(() => p.snapshot!.phase === 'market')));

    for (let round = 1; round <= 2; round++) {
      // Every client places and cancels orders concurrently.
      let accepted = 0;
      let rejected = 0;
      for (let wave = 0; wave < 4; wave++) {
        await Promise.all(
          players.map(async (p, i) => {
            const s = p.snapshot!;
            const pool = s.round!.pool;
            const t = pool[(i + wave) % pool.length];
            const owns = (s.account?.positions[t] ?? 0) > 0;
            const side = owns || (i + wave) % 5 === 0 ? 'ask' : 'bid';
            const price = 10 + ((i * 7 + wave * 3) % 15);
            const r = await p.command({ kind: 'placeLimitOrder', type: t, side, price, qty: 1 });
            r.ok ? accepted++ : rejected++;
            if (wave === 3) {
              const mine = Object.values(p.snapshot!.round!.books).flat().filter((o) => o.playerId === s.you.playerId);
              if (mine[0]) await p.command({ kind: 'cancelOrder', orderId: mine[0].id });
            }
          }),
        );
      }
      expect(accepted).toBeGreaterThan(60);
      const room = manager.getRoom(host.snapshot!.roomId)!;
      const r = room.round!;
      expect(r.trades.length).toBeGreaterThan(5);
      const cash = Object.values(r.accounts).reduce((a, x) => a + x.cash, 0);
      expect(cash).toBe(100 * MAX_PLAYERS);
      for (const t of r.pool) {
        const net = Object.values(r.accounts).reduce((a, x) => a + x.positions[t], 0);
        expect(net).toBe(r.upgrades[t].initialSupply);
      }
      // Every client converged on the server's books.
      await Promise.all(players.map((p) => p.until(() => p.snapshot!.revision === room.revision)));
      for (const p of players) {
        expect(p.snapshot!.round!.tape.length).toBe(r.trades.length);
        expect(p.snapshot!.account!.cash).toBe(r.accounts[p.snapshot!.you.playerId!].cash);
      }

      await advance('selection', host);
      await advance('reveal', host);
      await Promise.all(players.map((p) => p.until(() => p.snapshot!.phase === 'reveal')));
      const mine = players[0].snapshot!.round!.dice![players[0].snapshot!.you.playerId!];
      expect(mine.score).toBe(mine.tradingCash + mine.resolution.payout - mine.shortDeductions);
      // Reconnecting returns the identical stored roll.
      const again = new SimClient(base, code, { token: players[0].token });
      await again.connect();
      expect(again.snapshot!.round!.dice![again.snapshot!.you.playerId!]).toEqual(mine);
      again.close();
      await advance('results', host);
      if (round === 1) await advance('market', host);
    }
    await advance('finished', host);
    const fin = host.snapshot!;
    expect(fin.completedRounds).toHaveLength(2);
    const lb = fin.leaderboard.rows;
    expect(lb).toHaveLength(MAX_PLAYERS);
    for (const row of lb) expect(row.total).toBe(row.perRound.reduce<number>((a, b) => a + (b ?? 0), 0));
    for (const c of [host, extra, ...players]) c.close();
  }, 60_000);

  it('rejects bad host credentials and unknown rooms', async () => {
    const { code } = await http(base, '/api/rooms', { hostToken: 'x'.repeat(40) });
    const fake = new SimClient(base, code, { asHost: true, token: 'y'.repeat(40) });
    await fake.connect();
    expect(fake.snapshot!.you.kind).toBe('spectator');
    expect((await fake.command({ kind: 'startSession' })).ok).toBe(false);
    fake.close();
    await expect(http(base, '/api/rooms/ZZZZZ/join', { name: 'a', token: 'z'.repeat(40) })).rejects.toThrow(/No room/);
    await expect(http(base, `/api/rooms/${code}/join`, { name: '<b>', token: 'short' })).rejects.toThrow();
  });
});
