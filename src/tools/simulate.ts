// Drive 30 headless players through a live server: npm run simulate -- http://localhost:3000 [rounds]
import { randomBytes } from 'node:crypto';
import { MAX_PLAYERS } from '../shared/rules.js';
import { SimClient, http } from './sim-client.js';

const base = process.argv[2] ?? 'http://localhost:3000';
const rounds = Number(process.argv[3] ?? 2);
const players = Number(process.env.PLAYERS ?? MAX_PLAYERS);
const tradeSeconds = Number(process.env.TRADE_SECONDS ?? 20);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const hostToken = randomBytes(24).toString('hex');
const { code } = await http(base, '/api/rooms', { hostToken, rounds, devMode: true });
console.log(`room ${code} at ${base}/screen/${code}`);
const host = new SimClient(base, code, { asHost: true, token: hostToken });
await host.connect();
await host.command({ kind: 'setConfig', durations: { marketMs: 60_000, selectionMs: 15_000, revealMs: 15_000, resultsMs: 15_000 } });

const clients: SimClient[] = [];
for (let i = 0; i < players; i++) {
  const c = new SimClient(base, code);
  await http(base, `/api/rooms/${code}/join`, { name: `Sim ${i + 1}`, token: c.token });
  clients.push(c);
}
await Promise.all(clients.map((c) => c.connect()));
await Promise.all(clients.map((c) => c.command({ kind: 'setReady', ready: true })));
const start = await host.command({ kind: 'startSession' });
if (!start.ok) throw new Error(start.error);

let ok = 0;
let rejected = 0;
for (let r = 1; r <= rounds; r++) {
  await Promise.all(clients.map((c) => c.until(() => c.snapshot!.phase === 'market' && c.snapshot!.roundNumber === r, 30_000)));
  const until = Date.now() + tradeSeconds * 1000;
  while (Date.now() < until) {
    await Promise.all(
      clients.map(async (c, i) => {
        const s = c.snapshot!;
        const pool = s.round!.pool;
        const t = pool[Math.floor(Math.random() * pool.length)];
        const a = s.account!;
        const mine = Object.values(s.round!.books).flat().filter((o) => o.playerId === s.you.playerId);
        let res;
        if (mine.length > 3) res = await c.command({ kind: 'cancelOrder', orderId: mine[0].id });
        else {
          const sell = a.positions[t] > 0 ? Math.random() < 0.6 : Math.random() < 0.15;
          const fair = 16 + (i % 5) - 2;
          const price = Math.max(1, Math.min(50, Math.round(fair + (sell ? 2 : -2) + (Math.random() * 6 - 3))));
          res = await c.command({ kind: 'placeLimitOrder', type: t, side: sell ? 'ask' : 'bid', price, qty: 1 });
        }
        res.ok ? ok++ : rejected++;
      }),
    );
    await sleep(400);
  }
  const trades = host.snapshot!.round!.tape.length;
  console.log(`round ${r}: ${trades} trades so far (${ok} accepted / ${rejected} rejected commands total)`);
  // Test mode lets the host skip the rest of each phase.
  for (const phase of ['market', 'selection', 'reveal', 'results']) {
    await host.until(() => host.snapshot!.phase === phase, 30_000);
    await sleep(500);
    await host.command({ kind: 'devSkipPhase' });
  }
}
await host.until(() => host.snapshot!.phase === 'finished', 30_000);
const lb = host.snapshot!.leaderboard.rows;
console.log(`finished: ${host.snapshot!.completedRounds.length} rounds, ${lb.length} ranked players`);
console.log('top 3:', lb.slice(0, 3).map((r) => `${r.rank}. ${r.name} ${r.total}`).join(' | '));
console.log(`snapshot gaps recovered: ${clients.reduce((a, c) => a + c.gaps, 0)}`);
for (const c of [host, ...clients]) c.close();
process.exit(0);
