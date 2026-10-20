import { createReadStream, existsSync, statSync } from 'node:fs';
import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import type { ClientMessage, Command, ServerMessage } from '../shared/types.js';
import { privateAccount } from './engine/market.js';
import type { Actor } from './engine/room.js';
import { EngineError, type RoomState } from './engine/state.js';
import type { RoomManager } from './manager.js';
import { buildDelta, buildSnapshot, hostInfo } from './view.js';

interface Conn {
  ws: WebSocket;
  roomId: string;
  actor: Actor;
  /** Player identity for presence; host-only connections have none. */
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
  const connected = (roomId: string) => (pid: string) => manager.isConnected(roomId, pid);

  const snapshotFor = (room: RoomState, c: Conn) => buildSnapshot(room, c.actor, manager.clock.now(), connected(room.id));

  manager.onCommit((room, changes) => {
    const delta = changes.full ? null : buildDelta(room, changes, connected(room.id));
    for (const c of conns) {
      if (c.roomId !== room.id) continue;
      // Credentials are never part of any outgoing payload; actors are re-derived on commit.
      if (c.actor.kind === 'player' && !room.players[c.actor.playerId]) c.actor = { kind: 'spectator' };
      if (delta) {
        send(c.ws, {
          t: 'update',
          rev: room.revision,
          serverTime: manager.clock.now(),
          delta,
          account: c.actor.kind === 'player' && room.round ? privateAccount(room.round, c.actor.playerId) : null,
          host: c.actor.kind === 'host' ? hostInfo(room) : null,
        });
      } else {
        send(c.ws, { t: 'snapshot', data: snapshotFor(room, c) });
      }
    }
  });

  const broadcastPresence = (roomId: string) => {
    const msg: ServerMessage = { t: 'presence', connected: manager.connectedIds(roomId) };
    for (const c of conns) if (c.roomId === roomId) send(c.ws, msg);
  };

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://x');
      if (url.pathname === '/healthz') return json(res, 200, { ok: true, db: manager.db.kind });
      if (req.method === 'POST' && url.pathname === '/api/rooms') {
        const body = await readJson(req);
        const room = await manager.createRoom({ hostToken: body.hostToken, rounds: body.rounds, devMode: body.devMode });
        return json(res, 200, { roomId: room.id, code: room.code });
      }
      const m = url.pathname.match(/^\/api\/rooms\/([A-Za-z0-9]+)(\/join)?$/);
      if (m) {
        const room = await manager.findByCode(m[1]);
        if (!room) return json(res, 404, { error: 'No room with that code.' });
        if (req.method === 'POST' && m[2]) {
          const body = await readJson(req);
          const p = await manager.join(room, { name: body.name, token: body.token, hostToken: body.hostToken });
          return json(res, 200, { playerId: p.id, role: p.role, name: p.name, code: room.code });
        }
        if (req.method === 'GET' && !m[2]) {
          return json(res, 200, { code: room.code, phase: room.phase, players: Object.keys(room.players).length });
        }
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
          const actor = manager.authenticate(room, msg.token, !!msg.asHost);
          const playerId = actor.player?.id ?? null;
          const { player: _omit, ...clean } = actor as any;
          if (conn?.playerId) manager.setPresence(conn.roomId, conn.playerId, -1);
          conn = { ws, roomId: room.id, actor: clean as Actor, playerId };
          conns.add(conn);
          if (playerId && manager.setPresence(room.id, playerId, 1)) broadcastPresence(room.id);
          return send(ws, { t: 'snapshot', data: snapshotFor(manager.getRoom(room.id)!, conn) });
        }
        if (!conn) return send(ws, { t: 'error', error: 'Say hello first.' });
        if (msg.t === 'snapshot') return send(ws, { t: 'snapshot', data: snapshotFor(manager.getRoom(conn.roomId)!, conn) });
        if (msg.t === 'cmd') {
          const cmd = msg.cmd as Command;
          if (!cmd || typeof cmd !== 'object' || typeof cmd.kind !== 'string') {
            return send(ws, { t: 'receipt', receipt: { requestId: String(msg.requestId), ok: false, error: 'Bad command.', revision: 0 } });
          }
          const receipt = await manager.command(conn.roomId, conn.actor, msg.requestId, cmd);
          return send(ws, { t: 'receipt', receipt });
        }
      } catch (e) {
        console.error(e);
        if (msg.t === 'cmd') {
          send(ws, { t: 'receipt', receipt: { requestId: String(msg.requestId), ok: false, code: 'server_error', error: 'Server error; try again.', revision: 0 } });
        } else send(ws, { t: 'error', error: 'Server error.' });
      }
    });

    ws.on('close', () => {
      clearInterval(ping);
      if (!conn) return;
      conns.delete(conn);
      if (conn.playerId && manager.setPresence(conn.roomId, conn.playerId, -1)) broadcastPresence(conn.roomId);
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
