import { CATALOG, UPGRADE_IDS, type UpgradeId } from '../../shared/catalog.js';
import { type DrawFn, resolveDice } from '../../shared/dice.js';
import { MAX_DEDUCTION_PER_ROUND, MAX_EQUIPPED, STARTING_CASH } from '../../shared/rules.js';
import type { CompletedRound, Leaderboard, RoundAccount, SettlementLine } from '../../shared/types.js';
import { planDeal } from './deal.js';
import { closeoutReference, owedUnits } from './market.js';
import { type Ctx, EngineError, type Player, type RoomState, type RoundState } from './state.js';

export function tradingPlayers(room: RoomState): Player[] {
  return Object.values(room.players)
    .filter((p) => p.role === 'player')
    .sort((a, b) => a.joinedAt - b.joinedAt || a.id.localeCompare(b.id));
}

function zeroPositions(): Record<UpgradeId, number> {
  return Object.fromEntries(UPGRADE_IDS.map((t) => [t, 0])) as Record<UpgradeId, number>;
}

/**
 * Create a fresh round: new pool, fair deal, 100 coins each. Everything except
 * identities, deal history and completed results resets.
 */
export function createRound(room: RoomState, number: number, seed: number, ctx: Ctx): RoundState {
  const players = tradingPlayers(room);
  const accumulated: Record<string, number> = {};
  for (const p of players) accumulated[p.id] = p.dealHistory.reduce((a, d) => a + d.value, 0);
  const plan = planDeal({ poolVersion: room.config.poolVersion, roundNumber: number, accumulated, seed });

  const id = `${room.id}:r${number}`;
  const round: RoundState = {
    id,
    roomId: room.id,
    number,
    pool: plan.pool,
    dealSeed: seed,
    accounts: {},
    openOrders: {},
    trades: [],
    upgrades: {},
    settlements: [],
    dice: {},
    nextSeq: 1,
    closedOrders: [],
    decisions: [],
    marketClosedAt: null,
  };
  for (const t of plan.pool) {
    round.upgrades[t] = { type: t, lastPrice: null, highPrice: null, volume: 0, initialSupply: plan.supply[t] ?? 0, shortCloseouts: 0 };
  }
  for (const p of players) {
    const t = plan.assignment[p.id];
    const positions = zeroPositions();
    positions[t] = 1;
    const acct: RoundAccount = {
      playerId: p.id,
      cash: STARTING_CASH,
      shortDeductions: 0,
      startingUpgrade: t,
      positions,
      equipment: [],
      equipmentSubmitted: false,
      revision: 0,
    };
    round.accounts[p.id] = acct;
    room.players[p.id].dealHistory = [...p.dealHistory, { round: number, type: t, value: CATALOG[t].standaloneIncrement }];
    ctx.changes.players.add(p.id);
    ctx.changes.accounts.add(p.id);
    ctx.changes.ledger.push(
      { roundId: id, playerId: p.id, kind: 'endowment_cash', cashDelta: STARTING_CASH, type: null, positionDelta: 0, scoreDelta: 0, ref: null },
      { roundId: id, playerId: p.id, kind: 'endowment_unit', cashDelta: 0, type: t, positionDelta: 1, scoreDelta: 0, ref: null },
    );
  }
  for (const t of plan.pool) ctx.changes.upgrades.add(t);
  ctx.changes.newRound = round;
  return round;
}

/**
 * Market close: cancel every open order, freeze round highs, then close each
 * negative position exactly once against the bank at the frozen high.
 */
export function closeMarket(round: RoundState, ctx: Ctx): void {
  for (const o of Object.values(round.openOrders)) {
    o.status = 'closed';
    o.closedAt = ctx.now;
    ctx.changes.orders.set(o.id, o);
    ctx.changes.bookTypes.add(o.type);
  }
  round.openOrders = {};
}

export function settleShorts(round: RoundState, ctx: Ctx): void {
  if (round.settlements.length > 0) throw new EngineError('already_settled', 'Round already settled.');
  const frozen: Record<string, { price: number; provisional: boolean }> = {};
  for (const t of round.pool) frozen[t] = closeoutReference(round, t);

  for (const acct of Object.values(round.accounts)) {
    let total = 0;
    for (const t of round.pool) {
      const q = acct.positions[t];
      if (q >= 0) continue;
      const units = -q;
      const ref = frozen[t];
      const deduction = Math.min(units * ref.price, MAX_DEDUCTION_PER_ROUND - total);
      total += deduction;
      const line: SettlementLine = {
        playerId: acct.playerId,
        type: t,
        units,
        closeoutPrice: ref.price,
        deduction,
        bankUnits: units,
        fallbackPrice: ref.provisional,
      };
      acct.positions[t] = 0;
      acct.shortDeductions += deduction;
      acct.revision++;
      round.settlements.push(line);
      round.upgrades[t].shortCloseouts += units;
      ctx.changes.settlements.push(line);
      ctx.changes.upgrades.add(t);
      ctx.changes.accounts.add(acct.playerId);
      ctx.changes.ledger.push(
        { roundId: round.id, playerId: acct.playerId, kind: 'bank_issue', cashDelta: 0, type: t, positionDelta: units, scoreDelta: 0, ref: 'closeout' },
        { roundId: round.id, playerId: acct.playerId, kind: 'score_deduction', cashDelta: 0, type: t, positionDelta: 0, scoreDelta: -deduction, ref: 'closeout' },
      );
    }
    if (owedUnits(acct) !== 0) throw new Error('settlement left an owed unit');
  }
}

export function ownedTypes(round: RoundState, acct: RoundAccount): UpgradeId[] {
  return UPGRADE_IDS.filter((t) => round.pool.includes(t) && acct.positions[t] > 0);
}

/** Preselect the starting upgrade if it is still owned. */
export function preselectEquipment(round: RoundState, ctx: Ctx): void {
  for (const acct of Object.values(round.accounts)) {
    acct.equipment = acct.positions[acct.startingUpgrade] > 0 ? [acct.startingUpgrade] : [];
    acct.equipmentSubmitted = false;
    ctx.changes.accounts.add(acct.playerId);
  }
}

export function validateEquipment(round: RoundState, acct: RoundAccount, types: unknown): UpgradeId[] {
  if (!Array.isArray(types)) throw new EngineError('invalid_input', 'Choose up to two upgrades.');
  if (types.length > MAX_EQUIPPED) throw new EngineError('invalid_input', `You can equip at most ${MAX_EQUIPPED} upgrades.`);
  const out: UpgradeId[] = [];
  for (const t of types) {
    if (typeof t !== 'string' || !round.pool.includes(t as UpgradeId)) throw new EngineError('inactive_type', 'That upgrade is not active this round.');
    if (out.includes(t as UpgradeId)) throw new EngineError('invalid_input', 'You cannot equip two copies of one upgrade.');
    if (acct.positions[t as UpgradeId] <= 0) throw new EngineError('not_owned', `You do not own ${CATALOG[t as UpgradeId].name}.`);
    out.push(t as UpgradeId);
  }
  return out;
}

/** Selection timeout rule: keep valid selections, fill vacant slots from owned types in catalog row order. */
export function finalEquipment(round: RoundState, acct: RoundAccount): UpgradeId[] {
  const kept = acct.equipment.filter((t, i, a) => round.pool.includes(t) && acct.positions[t] > 0 && a.indexOf(t) === i).slice(0, MAX_EQUIPPED);
  for (const t of ownedTypes(round, acct)) {
    if (kept.length >= MAX_EQUIPPED) break;
    if (!kept.includes(t)) kept.push(t);
  }
  return kept;
}

/** Generate each player's dice exactly once and store the full breakdown. */
export function resolveRound(round: RoundState, drawFor: (playerId: string) => DrawFn, ctx: Ctx): void {
  for (const acct of Object.values(round.accounts)) {
    if (round.dice[acct.playerId]) continue;
    const equipment = finalEquipment(round, acct);
    acct.equipment = equipment;
    acct.revision++;
    const resolution = resolveDice(equipment, drawFor(acct.playerId));
    const score = acct.cash + resolution.payout - acct.shortDeductions;
    const rec = { playerId: acct.playerId, resolution, tradingCash: acct.cash, shortDeductions: acct.shortDeductions, score };
    round.dice[acct.playerId] = rec;
    ctx.changes.dice.push(rec);
    ctx.changes.accounts.add(acct.playerId);
    ctx.changes.ledger.push({
      roundId: round.id,
      playerId: acct.playerId,
      kind: 'dice_payout',
      cashDelta: 0,
      type: null,
      positionDelta: 0,
      scoreDelta: resolution.payout,
      ref: null,
    });
  }
}

export function summarizeRound(room: RoomState, round: RoundState): CompletedRound {
  return {
    number: round.number,
    pool: round.pool.slice(),
    players: Object.values(round.dice).map((d) => ({
      playerId: d.playerId,
      name: room.players[d.playerId]?.name ?? '?',
      tradingCash: d.tradingCash,
      dicePayout: d.resolution.payout,
      shortDeductions: d.shortDeductions,
      roundScore: d.score,
      netTradingResult: d.tradingCash - STARTING_CASH - d.shortDeductions,
      equipment: d.resolution.equipment,
    })),
    upgrades: round.pool.map((t) => {
      const u = round.upgrades[t];
      return { type: t, highPrice: u.highPrice, lastPrice: u.lastPrice, volume: u.volume, shortCloseouts: u.shortCloseouts };
    }),
  };
}

/** Sum of round scores (negatives included). Equal totals share a rank. */
export function leaderboard(room: RoomState): Leaderboard {
  const rounds = room.completedRounds;
  const rows = Object.values(room.players)
    .filter((p) => p.role === 'player')
    .map((p) => {
      const perRound = rounds.map((r) => r.players.find((x) => x.playerId === p.id)?.roundScore ?? null);
      const total = perRound.reduce<number>((a, b) => a + (b ?? 0), 0);
      return { playerId: p.id, name: p.name, total, rank: 0, perRound };
    })
    .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
  rows.forEach((r, i) => {
    r.rank = i > 0 && rows[i - 1].total === r.total ? rows[i - 1].rank : i + 1;
  });
  return { rows };
}
