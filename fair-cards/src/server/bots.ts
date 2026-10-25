// Test-mode bots: noisy fair-value traders that quote around their estimate and take obvious edges.
import { randomUUID } from 'node:crypto';
import { type MarketId, MARKETS } from '../shared/rules.js';
import type { Command } from '../shared/types.js';
import { book, isLive, maxWidthFor, nextQuoteAt, playerFv, type RoomState } from './engine.js';
import type { RoomManager } from './manager.js';

interface BotMemory {
  nextAt: number;
  noise: number;
  noiseStage: number;
}

export function botDecision(room: RoomState, pid: string, noise: number, rand: () => number, now: number, m: MarketId = 'sum'): Command | null {
  const r = room.round;
  if (!r || room.phase !== 'market' || room.pausedAt !== null || !r.participants.includes(pid) || !r.books[m]) return null;
  const spec = MARKETS[m];
  const b = book(r, m);
  const lim = spec.positionLimit;
  // Noise is drawn for the sum market; scale it to this market's typical uncertainty.
  const scale = spec.maxWidth / MARKETS.sum.maxWidth;
  const role = r.roles[pid];
  const fv = playerFv(r, pid, m) + noise * scale;
  const pos = b.positions[pid] ?? 0;
  const mine = b.quotes[pid];
  const canTrade = role === 'taker' || isLive(mine);

  if (canTrade) {
    let best: Command | null = null;
    let bestEdge = (role === 'taker' ? 1.5 : 2) * scale;
    for (const [oid, q] of Object.entries(b.quotes)) {
      if (oid === pid) continue;
      if (role === 'taker' && r.roles[oid] !== 'maker') continue;
      if (q.askSize > 0 && fv - q.ask > bestEdge && pos < lim && (b.positions[oid] ?? 0) > -lim) {
        bestEdge = fv - q.ask;
        best = { kind: 'trade', market: m, targetId: oid, side: 'buy', qty: 1, price: q.ask };
      }
      if (q.bidSize > 0 && q.bid - fv > bestEdge && pos > -lim && (b.positions[oid] ?? 0) < lim) {
        bestEdge = q.bid - fv;
        best = { kind: 'trade', market: m, targetId: oid, side: 'sell', qty: 1, price: q.bid };
      }
    }
    if (best) return best;
  }
  if (role === 'taker') return null;

  const width = Math.max(1, maxWidthFor(r, pid, m) - (rand() < 0.4 ? Math.ceil(scale) : 0));
  const mid = fv - (0.35 * scale * pos * MARKETS.sum.positionLimit) / lim;
  let bid = Math.round(mid - width / 2);
  let ask = bid + width;
  let bestAsk = Infinity;
  let bestBid = -Infinity;
  for (const [oid, q] of Object.entries(b.quotes)) {
    if (oid === pid) continue;
    if (q.askSize > 0) bestAsk = Math.min(bestAsk, q.ask);
    if (q.bidSize > 0) bestBid = Math.max(bestBid, q.bid);
  }
  const wanted = bid;
  if (bid >= bestAsk) {
    bid = bestAsk - 1;
    ask = bid + width;
  } else if (ask <= bestBid) {
    ask = bestBid + 1;
    bid = ask - width;
  }
  // Stale quotes elsewhere would drag this quote far from fair value; step away instead.
  if (Math.abs(bid - wanted) > width) return mine ? { kind: 'pullQuote', market: m } : null;
  if (bid < 0) return null;
  const allowed = nextQuoteAt(r, pid, m);
  if (allowed !== null && now < allowed) {
    // Cannot requote yet: step away if the current quote is badly off.
    return mine && Math.abs((mine.bid + mine.ask) / 2 - mid) > width ? { kind: 'pullQuote', market: m } : null;
  }
  if (isLive(mine) && Math.abs((mine.bid + mine.ask) / 2 - (bid + ask) / 2) < 1.5 * scale && rand() < 0.85) return null;
  return { kind: 'setQuote', market: m, bid, ask, size: Math.min(spec.maxSize, 1 + Math.floor(rand() * 3)) };
}

export function startBots(manager: RoomManager): () => void {
  const memory = new Map<string, BotMemory>();
  const timer = setInterval(() => {
    const now = manager.clock.now();
    for (const room of manager.allRooms()) {
      if (room.phase !== 'market' || room.pausedAt !== null || !room.round) continue;
      const stage = room.round.infoEvents.length;
      for (const p of Object.values(room.players)) {
        if (!p.isBot) continue;
        const key = `${room.id}:${p.id}`;
        let m = memory.get(key);
        if (!m || m.noiseStage !== stage) {
          m = { nextAt: m?.nextAt ?? now + Math.random() * 2000, noise: (Math.random() * 2 - 1) * 4, noiseStage: stage };
          memory.set(key, m);
        }
        if (now < m.nextAt) continue;
        m.nextAt = now + 1500 + Math.random() * 3500;
        const markets = room.round.markets;
        const cmd = botDecision(room, p.id, m.noise, Math.random, now, markets[Math.floor(Math.random() * markets.length)]);
        if (cmd) void manager.command(room.id, { kind: 'player', playerId: p.id }, randomUUID(), cmd).catch(() => {});
      }
    }
  }, 400);
  return () => clearInterval(timer);
}
