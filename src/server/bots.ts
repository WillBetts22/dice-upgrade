import { randomUUID } from 'node:crypto';
import { CATALOG } from '../shared/catalog.js';
import { MAX_PRICE, MIN_PRICE } from '../shared/rules.js';
import type { Command } from '../shared/types.js';
import { openOrdersOf, worstCaseShortUnits } from './engine/market.js';
import type { RoomManager } from './manager.js';

/**
 * Test-mode bots. They exist only in rooms the host created with test mode on,
 * and they go through exactly the same command path as real players.
 */
export function startBots(manager: RoomManager, intervalMs = 1500): () => void {
  const timer = setInterval(() => {
    for (const room of manager.allRooms()) {
      if (!room.config.devMode || room.phase !== 'market' || room.pausedRemainingMs !== null || !room.round) continue;
      const round = room.round;
      for (const p of Object.values(room.players)) {
        if (!p.isBot || p.role !== 'player' || Math.random() > 0.35) continue;
        const acct = round.accounts[p.id];
        if (!acct) continue;
        const type = round.pool[Math.floor(Math.random() * round.pool.length)];
        const value = CATALOG[type].standaloneIncrement + (Math.random() * 8 - 4);
        const mine = openOrdersOf(round, p.id);
        let cmd: Command;
        if (mine.length >= 4 && Math.random() < 0.5) {
          cmd = { kind: 'cancelOrder', orderId: mine[0].id };
        } else if (acct.positions[type] < 0 && Math.random() < 0.6) {
          cmd = { kind: 'placeLimitOrder', type, side: 'bid', price: clamp(Math.round(value + 2)), qty: 1 };
        } else {
          const owns = acct.positions[type] > 0;
          const sell = owns ? Math.random() < 0.6 : Math.random() < 0.25 && worstCaseShortUnits(round, p.id) < 1;
          const price = clamp(Math.round(sell ? value + 1 + Math.random() * 3 : value - 1 - Math.random() * 3));
          cmd = { kind: 'placeLimitOrder', type, side: sell ? 'ask' : 'bid', price, qty: 1 };
        }
        void manager.command(room.id, { kind: 'player', playerId: p.id }, `bot-${randomUUID()}`, cmd).catch(() => {});
      }
    }
  }, intervalMs);
  return () => clearInterval(timer);
}

function clamp(x: number): number {
  return Math.max(MIN_PRICE, Math.min(MAX_PRICE, x));
}
