import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startBots } from './bots.js';
import { openDb } from './db.js';
import { RoomManager } from './manager.js';
import { createAppServer } from './server.js';

const here = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT ?? 3000);
const staticDir = process.env.STATIC_DIR ?? resolve(here, '../client');

const db = await openDb({ url: process.env.DATABASE_URL, pgliteDir: process.env.DATABASE_URL ? undefined : (process.env.PGLITE_DIR ?? join(process.cwd(), 'data/pglite')) });
const manager = new RoomManager(db);
await manager.init();

const { server } = createAppServer(manager, { staticDir });
const ticker = setInterval(() => void manager.tickAll(), 250);
const stopBots = startBots(manager);

server.listen(port, () => {
  console.log(`fair-cards listening on :${port} (db: ${db.kind})`);
});

const shutdown = async () => {
  clearInterval(ticker);
  stopBots();
  server.close();
  await db.close().catch(() => {});
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
