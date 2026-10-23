import type { UpgradeId } from '../shared/catalog.js';
import type { Order, Receipt, RoundAccount, Trade, UpgradeRoundState } from '../shared/types.js';
import type { Db, Queryable } from './db.js';
import type { Changes, Player, RoomState, RoundState } from './engine/state.js';

export class RevisionConflict extends Error {}

const n = (x: unknown) => (x === null || x === undefined ? null : Number(x));

async function writeRoom(q: Queryable, room: RoomState, expectedRevision: number | null): Promise<void> {
  const cols = [
    room.id,
    room.code,
    room.hostHash,
    JSON.stringify(room.config),
    room.phase,
    room.roundNumber,
    room.phaseDeadline,
    room.pausedRemainingMs,
    room.revision,
    room.rosterFrozen,
    JSON.stringify(room.completedRounds),
    room.createdAt,
  ];
  if (expectedRevision === null) {
    await q.query(
      `INSERT INTO rooms (id, code, host_hash, config, phase, round_number, phase_deadline, paused_remaining_ms, revision, roster_frozen, completed_rounds, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      cols,
    );
    return;
  }
  // Optimistic revision check doubles as cross-process serialization.
  const r = await q.query(
    `UPDATE rooms SET config=$4, phase=$5, round_number=$6, phase_deadline=$7, paused_remaining_ms=$8, revision=$9,
       roster_frozen=$10, completed_rounds=$11
     WHERE id=$1 AND code=$2 AND host_hash=$3 AND revision=$12`,
    [...cols.slice(0, 11), expectedRevision],
  );
  if (r.rowCount !== 1) throw new RevisionConflict(`room ${room.id} revision moved past ${expectedRevision}`);
}

async function upsertPlayer(q: Queryable, p: Player): Promise<void> {
  await q.query(
    `INSERT INTO players (id, room_id, name, name_key, session_hash, is_host, is_bot, role, ready, deal_history, joined_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (id) DO UPDATE SET role=EXCLUDED.role, ready=EXCLUDED.ready, deal_history=EXCLUDED.deal_history, is_host=EXCLUDED.is_host`,
    [p.id, p.roomId, p.name, p.nameKey, p.sessionHash, p.isHost, p.isBot, p.role, p.ready, JSON.stringify(p.dealHistory), p.joinedAt],
  );
}

async function upsertAccount(q: Queryable, roundId: string, a: RoundAccount): Promise<void> {
  await q.query(
    `INSERT INTO round_accounts (round_id, player_id, cash, short_deductions, starting_upgrade, positions, equipment, equipment_submitted, revision)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (round_id, player_id) DO UPDATE SET cash=EXCLUDED.cash, short_deductions=EXCLUDED.short_deductions,
       positions=EXCLUDED.positions, equipment=EXCLUDED.equipment, equipment_submitted=EXCLUDED.equipment_submitted, revision=EXCLUDED.revision`,
    [roundId, a.playerId, a.cash, a.shortDeductions, a.startingUpgrade, JSON.stringify(a.positions), JSON.stringify(a.equipment), a.equipmentSubmitted, a.revision],
  );
}

async function upsertOrder(q: Queryable, o: Order): Promise<void> {
  await q.query(
    `INSERT INTO orders (id, round_id, player_id, type, side, price, original_qty, remaining, seq, status, created_at, closed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT (id) DO UPDATE SET remaining=EXCLUDED.remaining, status=EXCLUDED.status, closed_at=EXCLUDED.closed_at`,
    [o.id, o.roundId, o.playerId, o.type, o.side, o.price, o.originalQty, o.remaining, o.seq, o.status, o.createdAt, o.closedAt ?? null],
  );
}

async function upsertUpgrade(q: Queryable, roundId: string, u: UpgradeRoundState): Promise<void> {
  await q.query(
    `INSERT INTO upgrade_round_state (round_id, type, last_price, high_price, volume, initial_supply, short_closeouts)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (round_id, type) DO UPDATE SET last_price=EXCLUDED.last_price, high_price=EXCLUDED.high_price,
       volume=EXCLUDED.volume, short_closeouts=EXCLUDED.short_closeouts`,
    [roundId, u.type, u.lastPrice, u.highPrice, u.volume, u.initialSupply, u.shortCloseouts],
  );
}

async function insertTrade(q: Queryable, t: Trade): Promise<void> {
  await q.query(
    `INSERT INTO trades (id, round_id, type, buyer_id, seller_id, resting_order_id, incoming_order_id, price, qty, seq, kind, raised_high, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [t.id, t.roundId, t.type, t.buyerId, t.sellerId, t.restingOrderId, t.incomingOrderId, t.price, t.qty, t.seq, t.kind, t.raisedHigh, t.createdAt],
  );
}

export async function insertReceipt(q: Queryable, roomId: string, actorId: string, receipt: Receipt): Promise<void> {
  await q.query(
    `INSERT INTO command_receipts (room_id, actor_id, request_id, outcome, committed_revision) VALUES ($1,$2,$3,$4,$5)`,
    [roomId, actorId, receipt.requestId, JSON.stringify(receipt), receipt.revision],
  );
}

export async function findReceipt(db: Db, roomId: string, actorId: string, requestId: string): Promise<Receipt | null> {
  const r = await db.query(`SELECT outcome FROM command_receipts WHERE room_id=$1 AND actor_id=$2 AND request_id=$3`, [roomId, actorId, requestId]);
  return r.rows[0]?.outcome ?? null;
}

export async function insertNewRoom(db: Db, room: RoomState): Promise<void> {
  await db.tx(async (q) => {
    await writeRoom(q, room, null);
  });
}

/** Persist one committed command or phase step atomically. */
export async function commit(
  db: Db,
  room: RoomState,
  expectedRevision: number,
  changes: Changes,
  receipt: { actorId: string; receipt: Receipt } | null,
  removedPlayers: string[] = [],
): Promise<void> {
  await db.tx(async (q) => {
    await writeRoom(q, room, expectedRevision);
    for (const pid of removedPlayers) await q.query(`DELETE FROM players WHERE id=$1 AND room_id=$2`, [pid, room.id]);
    for (const pid of changes.players) if (room.players[pid]) await upsertPlayer(q, room.players[pid]);
    const round = room.round;
    if (changes.newRound) {
      const nr = changes.newRound;
      await q.query(`INSERT INTO rounds (id, room_id, number, pool, deal_seed) VALUES ($1,$2,$3,$4,$5)`, [
        nr.id,
        room.id,
        nr.number,
        JSON.stringify(nr.pool),
        nr.dealSeed,
      ]);
    }
    if (round) {
      if (changes.roundUpdated) {
        await q.query(`UPDATE rounds SET market_closed_at=$2 WHERE id=$1`, [round.id, round.marketClosedAt]);
      }
      for (const pid of changes.accounts) if (round.accounts[pid]) await upsertAccount(q, round.id, round.accounts[pid]);
      for (const o of changes.orders.values()) await upsertOrder(q, o);
      for (const t of changes.trades) await insertTrade(q, t);
      for (const t of changes.upgrades) await upsertUpgrade(q, round.id, round.upgrades[t]);
      for (const s of changes.settlements) {
        // Primary key (round, player, type) prevents a second closeout.
        await q.query(
          `INSERT INTO settlements (round_id, player_id, type, units, closeout_price, deduction, bank_units, fallback_price)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [round.id, s.playerId, s.type, s.units, s.closeoutPrice, s.deduction, s.bankUnits, s.fallbackPrice],
        );
      }
      for (const d of changes.dice) {
        // Primary key (round, player) prevents generating dice twice.
        await q.query(
          `INSERT INTO dice_results (round_id, player_id, equipment, resolution, trading_cash, short_deductions, score)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [round.id, d.playerId, JSON.stringify(d.resolution.equipment), JSON.stringify(d.resolution), d.tradingCash, d.shortDeductions, d.score],
        );
      }
      for (const e of changes.decisions) {
        await q.query(`INSERT INTO decisions (id, round_id, player_id, revision, at, kind, payload) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [
          e.id,
          e.roundId,
          e.playerId,
          e.revision,
          e.at,
          e.kind,
          JSON.stringify(e),
        ]);
      }
      for (const r of changes.reviews) {
        // Primary key (round, player) prevents a second review.
        await q.query(`INSERT INTO decision_reviews (round_id, player_id, review) VALUES ($1,$2,$3)`, [r.roundId, r.playerId, JSON.stringify(r)]);
      }
    }
    for (const l of changes.ledger) {
      await q.query(
        `INSERT INTO ledger (room_id, round_id, player_id, kind, cash_delta, type, position_delta, score_delta, ref, revision)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [room.id, l.roundId, l.playerId, l.kind, l.cashDelta, l.type, l.positionDelta, l.scoreDelta, l.ref, room.revision],
      );
    }
    if (receipt) await insertReceipt(q, room.id, receipt.actorId, receipt.receipt);
  });
}

export async function loadRoom(db: Db, roomId: string): Promise<RoomState | null> {
  const rr = await db.query(`SELECT * FROM rooms WHERE id=$1`, [roomId]);
  const row = rr.rows[0];
  if (!row) return null;
  const players: Record<string, Player> = {};
  for (const p of (await db.query(`SELECT * FROM players WHERE room_id=$1`, [roomId])).rows) {
    players[p.id] = {
      id: p.id,
      roomId,
      name: p.name,
      nameKey: p.name_key,
      sessionHash: p.session_hash,
      isHost: p.is_host,
      isBot: p.is_bot,
      role: p.role,
      ready: p.ready,
      connected: false,
      dealHistory: p.deal_history,
      joinedAt: Number(p.joined_at),
    };
  }
  const room: RoomState = {
    id: row.id,
    code: row.code,
    hostHash: row.host_hash,
    config: row.config,
    phase: row.phase,
    roundNumber: row.round_number,
    phaseDeadline: n(row.phase_deadline),
    pausedRemainingMs: n(row.paused_remaining_ms),
    revision: row.revision,
    rosterFrozen: row.roster_frozen,
    createdAt: Number(row.created_at),
    players,
    round: null,
    completedRounds: row.completed_rounds,
    reviews: (
      await db.query(
        `SELECT dr.review FROM decision_reviews dr JOIN rounds r ON r.id = dr.round_id WHERE r.room_id=$1 ORDER BY r.number, dr.player_id`,
        [roomId],
      )
    ).rows.map((x) => x.review),
  };
  if (room.roundNumber > 0) room.round = await loadRound(db, roomId, room.roundNumber);
  return room;
}

async function loadRound(db: Db, roomId: string, number: number): Promise<RoundState> {
  const r = (await db.query(`SELECT * FROM rounds WHERE room_id=$1 AND number=$2`, [roomId, number])).rows[0];
  const id: string = r.id;
  const round: RoundState = {
    id,
    roomId,
    number,
    pool: r.pool,
    dealSeed: Number(r.deal_seed),
    accounts: {},
    openOrders: {},
    trades: [],
    upgrades: {},
    settlements: [],
    dice: {},
    nextSeq: 1,
    closedOrders: [],
    decisions: [],
    marketClosedAt: n(r.market_closed_at),
  };
  for (const a of (await db.query(`SELECT * FROM round_accounts WHERE round_id=$1`, [id])).rows) {
    round.accounts[a.player_id] = {
      playerId: a.player_id,
      cash: a.cash,
      shortDeductions: a.short_deductions,
      startingUpgrade: a.starting_upgrade,
      positions: a.positions,
      equipment: a.equipment,
      equipmentSubmitted: a.equipment_submitted,
      revision: a.revision,
    };
  }
  let maxSeq = 0;
  for (const o of (await db.query(`SELECT * FROM orders WHERE round_id=$1 ORDER BY seq`, [id])).rows) {
    maxSeq = Math.max(maxSeq, o.seq);
    const order = {
      id: o.id,
      roundId: id,
      playerId: o.player_id,
      type: o.type,
      side: o.side,
      price: o.price,
      originalQty: o.original_qty,
      remaining: o.remaining,
      seq: o.seq,
      status: o.status,
      createdAt: Number(o.created_at),
      closedAt: n(o.closed_at),
    };
    if (o.status === 'open') round.openOrders[o.id] = order;
    else round.closedOrders.push(order);
  }
  for (const d of (await db.query(`SELECT payload FROM decisions WHERE round_id=$1 ORDER BY revision, at`, [id])).rows) {
    round.decisions.push(d.payload);
  }
  for (const t of (await db.query(`SELECT * FROM trades WHERE round_id=$1 ORDER BY seq`, [id])).rows) {
    maxSeq = Math.max(maxSeq, t.seq);
    round.trades.push({
      id: t.id,
      roundId: id,
      type: t.type,
      buyerId: t.buyer_id,
      sellerId: t.seller_id,
      restingOrderId: t.resting_order_id,
      incomingOrderId: t.incoming_order_id,
      price: t.price,
      qty: t.qty,
      seq: t.seq,
      kind: t.kind,
      raisedHigh: t.raised_high,
      createdAt: Number(t.created_at),
    });
  }
  round.nextSeq = maxSeq + 1;
  for (const u of (await db.query(`SELECT * FROM upgrade_round_state WHERE round_id=$1`, [id])).rows) {
    round.upgrades[u.type] = {
      type: u.type as UpgradeId,
      lastPrice: u.last_price,
      highPrice: u.high_price,
      volume: u.volume,
      initialSupply: u.initial_supply,
      shortCloseouts: u.short_closeouts,
    };
  }
  for (const s of (await db.query(`SELECT * FROM settlements WHERE round_id=$1`, [id])).rows) {
    round.settlements.push({
      playerId: s.player_id,
      type: s.type,
      units: s.units,
      closeoutPrice: s.closeout_price,
      deduction: s.deduction,
      bankUnits: s.bank_units,
      fallbackPrice: s.fallback_price,
    });
  }
  for (const d of (await db.query(`SELECT * FROM dice_results WHERE round_id=$1`, [id])).rows) {
    round.dice[d.player_id] = {
      playerId: d.player_id,
      resolution: d.resolution,
      tradingCash: d.trading_cash,
      shortDeductions: d.short_deductions,
      score: d.score,
    };
  }
  return round;
}

export async function activeRoomIds(db: Db): Promise<string[]> {
  return (await db.query(`SELECT id FROM rooms WHERE phase <> 'finished'`)).rows.map((r) => r.id);
}

export async function roomIdByCode(db: Db, code: string): Promise<string | null> {
  return (await db.query(`SELECT id FROM rooms WHERE code=$1`, [code])).rows[0]?.id ?? null;
}
