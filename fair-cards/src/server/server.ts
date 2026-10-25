import { createReadStream, existsSync, statSync } from 'node:fs';
import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import type { ClientMessage, ServerMessage } from '../shared/types.js';
import { type Actor, EngineError, type RoomState } from './engine.js';
import type { RoomManager } from './manager.js';
import { buildSnapshot } from './view.js';

interface Conn {
  ws: WebSocket;
  roomId: string;
  actor: Actor;
  playerId: string | null;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
};

/** Snapshots are coalesced per room so a burst of trades sends one update per viewer. */
const BROADCAST_MS = 120;

function send(ws: WebSocket, msg: ServerMessage): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

async function readJson(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 10_000) throw new EngineError('too_large', 'Request too large.');
    chunks.push(c as Buffer);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new EngineError('invalid_json', 'Invalid JSON.');
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

export function createAppServer(manager: RoomManager, opts: { staticDir?: string } = {}): { server: Server; wss: WebSocketServer; conns: Set<Conn> } {
  const conns = new Set<Conn>();
  const presence = new Map<string, Map<string, number>>();
  const pending = new Map<string, NodeJS.Timeout>();

  const isConnected = (roomId: string) => (pid: string) => (presence.get(roomId)?.get(pid) ?? 0) > 0;

  const pushRoom = (room: RoomState) => {
    const now = manager.clock.now();
    for (const c of conns) {
      if (c.roomId !== room.id) continue;
      send(c.ws, { t: 'snapshot', data: buildSnapshot(room, c.actor, now, isConnected(room.id)) });
    }
  };

  const schedule = (roomId: string) => {
    if (pending.has(roomId)) return;
    pending.set(
      roomId,
      setTimeout(() => {
        pending.delete(roomId);
        const room = manager.getRoom(roomId);
        if (room) pushRoom(room);
      }, BROADCAST_MS),
    );
  };

  manager.onCommit((room) => schedule(room.id));

  const setPresence = (roomId: string, pid: string, delta: number) => {
    const m = presence.get(roomId) ?? new Map<string, number>();
    presence.set(roomId, m);
    const before = m.get(pid) ?? 0;
    const after = Math.max(0, before + delta);
    m.set(pid, after);
    if ((before > 0) !== (after > 0)) schedule(roomId);
  };

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://x');
      if (url.pathname === '/healthz') return json(res, 200, { ok: true, db: manager.db.kind });
      if (req.method === 'POST' && url.pathname === '/api/rooms') {
        const body = await readJson(req);
        const room = await manager.createRoom({ hostToken: body.hostToken, devMode: body.devMode });
        return json(res, 200, { code: room.code });
      }
      const m = url.pathname.match(/^\/api\/rooms\/([A-Za-z0-9]+)(\/join)?$/);
      if (m) {
        const room = await manager.findByCode(m[1]);
        if (!room) return json(res, 404, { error: 'No room with that code.' });
        if (req.method === 'POST' && m[2]) {
          const body = await readJson(req);
          const p = await manager.join(room, { name: body.name, token: body.token, hostToken: body.hostToken });
          return json(res, 200, { playerId: p.id, name: p.name, spectator: p.spectator, code: room.code });
        }
        if (req.method === 'GET' && !m[2]) return json(res, 200, { code: room.code, phase: room.phase, players: Object.keys(room.players).length });
      }
      if (url.pathname.startsWith('/api/')) return json(res, 404, { error: 'Not found.' });
      return serveStatic(opts.staticDir, url.pathname, res);
    } catch (e) {
      if (e instanceof EngineError) return json(res, 400, { error: e.message, code: e.code });
      console.error(e);
      return json(res, 500, { error: 'Server error.' });
    }
  });

  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 16_384 });
  wss.on('connection', (ws) => {
    let conn: Conn | null = null;
    let alive = true;
    ws.on('pong', () => (alive = true));
    const ping = setInterval(() => {
      if (!alive) return ws.terminate();
      alive = false;
      ws.ping();
    }, 20_000);

    ws.on('message', async (raw) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return send(ws, { t: 'error', error: 'Bad message.' });
      }
      try {
        if (msg.t === 'ping') return send(ws, { t: 'pong', clientTime: msg.clientTime, serverTime: manager.clock.now() });
        if (msg.t === 'hello') {
          const room = await manager.findByCode(msg.code);
          if (!room) return send(ws, { t: 'error', error: 'No room with that code.' });
          const { actor, player } = manager.authenticate(room, msg.token, !!msg.asHost);
          if (conn) {
            conns.delete(conn);
            if (conn.playerId) setPresence(conn.roomId, conn.playerId, -1);
          }
          conn = { ws, roomId: room.id, actor, playerId: player?.id ?? null };
          conns.add(conn);
          if (conn.playerId) setPresence(room.id, conn.playerId, 1);
          return send(ws, { t: 'snapshot', data: buildSnapshot(manager.getRoom(room.id)!, actor, manager.clock.now(), isConnected(room.id)) });
        }
        if (!conn) return send(ws, { t: 'error', error: 'Say hello first.' });
        if (msg.t === 'cmd') {
          const cmd = msg.cmd;
          if (!cmd || typeof cmd !== 'object' || typeof cmd.kind !== 'string') {
            return send(ws, { t: 'receipt', receipt: { requestId: String(msg.requestId), ok: false, error: 'Bad command.' } });
          }
          if (conn.actor.kind === 'spectator') return send(ws, { t: 'receipt', receipt: { requestId: String(msg.requestId), ok: false, error: 'Spectators cannot act.' } });
          const receipt = await manager.command(conn.roomId, conn.actor, msg.requestId, cmd);
          return send(ws, { t: 'receipt', receipt });
        }
      } catch (e) {
        console.error(e);
        if (msg.t === 'cmd') send(ws, { t: 'receipt', receipt: { requestId: String(msg.requestId), ok: false, code: 'server_error', error: 'Server error; try again.' } });
        else send(ws, { t: 'error', error: 'Server error.' });
      }
    });

    ws.on('close', () => {
      clearInterval(ping);
      if (!conn) return;
      conns.delete(conn);
      if (conn.playerId) setPresence(conn.roomId, conn.playerId, -1);
    });
  });

  return { server, wss, conns };
}

function serveStatic(dir: string | undefined, pathname: string, res: ServerResponse): void {
  if (!dir || !existsSync(dir)) {
    res.writeHead(404);
    res.end('Client not built. Run npm run build, or use npm run dev.');
    return;
  }
  const safe = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, '');
  let file = join(dir, safe);
  if (!file.startsWith(dir) || !existsSync(file) || statSync(file).isDirectory()) file = join(dir, 'index.html');
  const ext = extname(file);
  res.writeHead(200, {
    'content-type': MIME[ext] ?? 'application/octet-stream',
    'cache-control': ext === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable',
  });
  createReadStream(file).pipe(res);
}
