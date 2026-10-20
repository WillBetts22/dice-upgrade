import { CATALOG, type UpgradeId } from '../../shared/catalog.js';
import {
  CLOSEOUT_FALLBACK_PRICE,
  MAX_OPEN_ORDERS,
  MAX_PRICE,
  MAX_QTY,
  MAX_SHORT_UNITS,
  MIN_PRICE,
  MIN_QTY,
} from '../../shared/rules.js';
import type { Order, PrivateAccount, RoundAccount, Side, Trade } from '../../shared/types.js';
import { type Ctx, EngineError, type RoundState } from './state.js';

// ------------------------------------------------------------ account metrics

export function openOrdersOf(round: RoundState, playerId: string): Order[] {
  return Object.values(round.openOrders).filter((o) => o.playerId === playerId);
}

export function reservedForBids(round: RoundState, playerId: string): number {
  let b = 0;
  for (const o of Object.values(round.openOrders)) {
    if (o.playerId === playerId && o.side === 'bid') b += o.price * o.remaining;
  }
  return b;
}

export function openAskQty(round: RoundState, playerId: string, type: UpgradeId): number {
  let a = 0;
  for (const o of Object.values(round.openOrders)) {
    if (o.playerId === playerId && o.side === 'ask' && o.type === type) a += o.remaining;
  }
  return a;
}

/** S = sum over types of max(0, A[t] - q[t]). */
export function worstCaseShortUnits(round: RoundState, playerId: string): number {
  const acct = round.accounts[playerId];
  let s = 0;
  for (const t of round.pool) s += Math.max(0, openAskQty(round, playerId, t) - acct.positions[t]);
  return s;
}

export function owedUnits(acct: RoundAccount): number {
  let n = 0;
  for (const q of Object.values(acct.positions)) if (q < 0) n += -q;
  return n;
}

export function closeoutReference(round: RoundState, type: UpgradeId): { price: number; provisional: boolean } {
  const high = round.upgrades[type]?.highPrice ?? null;
  return high === null ? { price: CLOSEOUT_FALLBACK_PRICE, provisional: true } : { price: high, provisional: false };
}

export function estimatedDeduction(round: RoundState, acct: RoundAccount): { amount: number; provisional: boolean } {
  let amount = 0;
  let provisional = false;
  for (const t of round.pool) {
    const q = acct.positions[t];
    if (q < 0) {
      const ref = closeoutReference(round, t);
      amount += -q * ref.price;
      provisional ||= ref.provisional;
    }
  }
  return { amount, provisional };
}

export function privateAccount(round: RoundState, playerId: string): PrivateAccount | null {
  const acct = round.accounts[playerId];
  if (!acct) return null;
  const reserved = reservedForBids(round, playerId);
  const est = estimatedDeduction(round, acct);
  return {
    playerId,
    cash: acct.cash,
    reservedForBids: reserved,
    spendable: acct.cash - reserved,
    positions: { ...acct.positions },
    owedUnits: owedUnits(acct),
    worstCaseShortUnits: worstCaseShortUnits(round, playerId),
    estimatedDeduction: acct.shortDeductions > 0 ? acct.shortDeductions : est.amount,
    estimateProvisional: acct.shortDeductions > 0 ? false : est.provisional,
    shortDeductions: acct.shortDeductions,
    startingUpgrade: acct.startingUpgrade,
    equipment: acct.equipment.slice(),
    equipmentSubmitted: acct.equipmentSubmitted,
    settlement: round.settlements.filter((s) => s.playerId === playerId),
  };
}

/** Both invariants from section 5. Throws if the account is out of bounds. */
export function assertAccountInvariants(round: RoundState, playerId: string): void {
  const acct = round.accounts[playerId];
  const spendable = acct.cash - reservedForBids(round, playerId);
  if (spendable < 0) {
    throw new EngineError('insufficient_cash', `Not enough spendable cash: you would be ${-spendable} coins short.`);
  }
  const s = worstCaseShortUnits(round, playerId);
  if (s > MAX_SHORT_UNITS) {
    throw new EngineError(
      'short_limit',
      `That would let you owe up to ${s} units if your asks fill. The limit is ${MAX_SHORT_UNITS} units in total.`,
    );
  }
}

// ------------------------------------------------------------ validation helpers

function requireTrader(round: RoundState, playerId: string): RoundAccount {
  const acct = round.accounts[playerId];
  if (!acct) throw new EngineError('not_trader', 'Only players in this round can trade.');
  return acct;
}

function requireActiveType(round: RoundState, type: unknown): UpgradeId {
  if (typeof type !== 'string' || !round.pool.includes(type as UpgradeId)) {
    throw new EngineError('inactive_type', 'That upgrade is not active this round.');
  }
  return type as UpgradeId;
}

function requireInt(x: unknown, min: number, max: number, what: string): number {
  if (typeof x !== 'number' || !Number.isInteger(x) || x < min || x > max) {
    throw new EngineError('invalid_input', `${what} must be a whole number from ${min} to ${max}.`);
  }
  return x;
}

function crosses(side: Side, price: number, resting: Order): boolean {
  return side === 'bid' ? price >= resting.price : price <= resting.price;
}

/** Opposite-side resting orders in price then time priority. */
function oppositeBook(round: RoundState, type: UpgradeId, side: Side): Order[] {
  const want: Side = side === 'bid' ? 'ask' : 'bid';
  return Object.values(round.openOrders)
    .filter((o) => o.type === type && o.side === want)
    .sort((a, b) => (want === 'ask' ? a.price - b.price : b.price - a.price) || a.seq - b.seq);
}

function name(type: UpgradeId): string {
  return CATALOG[type].name;
}

// ------------------------------------------------------------ execution

function execute(
  round: RoundState,
  ctx: Ctx,
  args: {
    type: UpgradeId;
    buyerId: string;
    sellerId: string;
    resting: Order;
    incomingOrderId: string | null;
    qty: number;
    kind: Trade['kind'];
  },
): Trade {
  const { type, buyerId, sellerId, resting, qty } = args;
  if (buyerId === sellerId) throw new EngineError('self_trade', 'You cannot trade with yourself.');
  const price = resting.price;
  const buyer = round.accounts[buyerId];
  const seller = round.accounts[sellerId];

  buyer.cash -= price * qty;
  seller.cash += price * qty;
  buyer.positions[type] += qty;
  seller.positions[type] -= qty;
  buyer.revision++;
  seller.revision++;

  resting.remaining -= qty;
  if (resting.remaining === 0) {
    resting.status = 'filled';
    delete round.openOrders[resting.id];
  }
  ctx.changes.orders.set(resting.id, resting);

  const u = round.upgrades[type];
  const raisedHigh = u.highPrice === null || price > u.highPrice;
  if (raisedHigh) u.highPrice = price;
  u.lastPrice = price;
  u.volume += qty;

  const trade: Trade = {
    id: ctx.newId(),
    roundId: round.id,
    type,
    buyerId,
    sellerId,
    restingOrderId: resting.id,
    incomingOrderId: args.incomingOrderId,
    price,
    qty,
    seq: round.nextSeq++,
    kind: args.kind,
    raisedHigh,
    createdAt: ctx.now,
  };
  ctx.changes.trades.push(trade);
  ctx.changes.accounts.add(buyerId).add(sellerId);
  ctx.changes.upgrades.add(type);
  ctx.changes.bookTypes.add(type);
  const ledger = ctx.changes.ledger;
  ledger.push(
    { roundId: round.id, playerId: buyerId, kind: 'trade_cash', cashDelta: -price * qty, type, positionDelta: 0, scoreDelta: 0, ref: trade.id },
    { roundId: round.id, playerId: sellerId, kind: 'trade_cash', cashDelta: price * qty, type, positionDelta: 0, scoreDelta: 0, ref: trade.id },
    { roundId: round.id, playerId: buyerId, kind: 'trade_unit', cashDelta: 0, type, positionDelta: qty, scoreDelta: 0, ref: trade.id },
    { roundId: round.id, playerId: sellerId, kind: 'trade_unit', cashDelta: 0, type, positionDelta: -qty, scoreDelta: 0, ref: trade.id },
  );
  // Verify each execution state: cash never goes negative mid-sweep.
  if (buyer.cash < 0) throw new EngineError('insufficient_cash', 'Not enough cash for that purchase.');
  return trade;
}

export interface PlaceOrderInput {
  type: unknown;
  side: unknown;
  price: unknown;
  qty: unknown;
}

/**
 * Post a limit order. Crossing quantity sweeps the opposite book in price then
 * time priority at resting prices; any remainder rests. The caller passes a
 * draft round: on any thrown error, the draft is discarded.
 */
export function placeLimitOrder(round: RoundState, playerId: string, input: PlaceOrderInput, ctx: Ctx): { order: Order; trades: Trade[] } {
  requireTrader(round, playerId);
  const type = requireActiveType(round, input.type);
  if (input.side !== 'bid' && input.side !== 'ask') throw new EngineError('invalid_input', 'Side must be bid or ask.');
  const side: Side = input.side;
  const price = requireInt(input.price, MIN_PRICE, MAX_PRICE, 'Price');
  const qty = requireInt(input.qty, MIN_QTY, MAX_QTY, 'Quantity');

  // Self-trade prevention: reject before any mutation.
  const ownConflict = Object.values(round.openOrders).find(
    (o) => o.playerId === playerId && o.type === type && o.side !== side && crosses(side, price, o),
  );
  if (ownConflict) {
    const what = ownConflict.side === 'ask' ? 'ask (sell)' : 'bid (buy)';
    throw new EngineError(
      'self_cross',
      `This would trade against your own ${what} at ${ownConflict.price}. Cancel that quote first, then post again.`,
    );
  }

  const order: Order = {
    id: ctx.newId(),
    roundId: round.id,
    playerId,
    type,
    side,
    price,
    originalQty: qty,
    remaining: qty,
    seq: round.nextSeq++,
    status: 'open',
    createdAt: ctx.now,
  };

  const trades: Trade[] = [];
  for (const resting of oppositeBook(round, type, side)) {
    if (order.remaining === 0 || !crosses(side, price, resting)) break;
    const fill = Math.min(order.remaining, resting.remaining);
    const buyerId = side === 'bid' ? playerId : resting.playerId;
    const sellerId = side === 'bid' ? resting.playerId : playerId;
    trades.push(execute(round, ctx, { type, buyerId, sellerId, resting, incomingOrderId: order.id, qty: fill, kind: 'match' }));
    order.remaining -= fill;
  }

  if (order.remaining > 0) {
    round.openOrders[order.id] = order;
    ctx.changes.bookTypes.add(type);
  } else {
    order.status = 'filled';
  }
  ctx.changes.orders.set(order.id, order);
  ctx.changes.accounts.add(playerId);

  if (openOrdersOf(round, playerId).length > MAX_OPEN_ORDERS) {
    throw new EngineError('order_limit', `You can have at most ${MAX_OPEN_ORDERS} open orders. Cancel one first.`);
  }
  // Validate final balances and exposure of every affected player.
  for (const pid of ctx.changes.accounts) assertAccountInvariants(round, pid);

  const filled = trades.reduce((a, t) => a + t.qty, 0);
  const verb = side === 'bid' ? 'Bought' : 'Sold';
  const parts: string[] = [];
  if (filled > 0) parts.push(`${verb} ${filled} ${name(type)} at ${trades.map((t) => t.price).join(', ')}`);
  if (order.remaining > 0) parts.push(`${side === 'bid' ? 'Bid' : 'Ask'} for ${order.remaining} at ${price} is on the book`);
  ctx.changes.message = parts.join('. ') + '.';
  return { order, trades };
}

export interface AcceptInput {
  orderId: unknown;
  expectedRemaining: unknown;
  qty: unknown;
}

/** Bilateral execution against one named resting order at its price. */
export function acceptQuote(round: RoundState, playerId: string, input: AcceptInput, ctx: Ctx): Trade {
  requireTrader(round, playerId);
  const resting = typeof input.orderId === 'string' ? round.openOrders[input.orderId] : undefined;
  if (!resting || resting.remaining !== input.expectedRemaining) {
    throw new EngineError('stale_quote', 'That quote has changed or is gone. Refresh the book and try again.');
  }
  if (resting.playerId === playerId) throw new EngineError('self_trade', 'That is your own quote. Cancel it instead.');
  const qty = requireInt(input.qty, MIN_QTY, resting.remaining, 'Quantity');
  const takerBuys = resting.side === 'ask';
  const trade = execute(round, ctx, {
    type: resting.type,
    buyerId: takerBuys ? playerId : resting.playerId,
    sellerId: takerBuys ? resting.playerId : playerId,
    resting,
    incomingOrderId: null,
    qty,
    kind: 'accept',
  });
  for (const pid of ctx.changes.accounts) assertAccountInvariants(round, pid);
  ctx.changes.message = `${takerBuys ? 'Bought' : 'Sold'} ${qty} ${name(resting.type)} at ${resting.price}.`;
  return trade;
}

export function cancelOrder(round: RoundState, playerId: string, orderId: unknown, ctx: Ctx): Order {
  const o = typeof orderId === 'string' ? round.openOrders[orderId] : undefined;
  if (!o) throw new EngineError('not_found', 'That order is no longer open.');
  if (o.playerId !== playerId) throw new EngineError('forbidden', 'You can only cancel your own orders.');
  o.status = 'cancelled';
  delete round.openOrders[o.id];
  ctx.changes.orders.set(o.id, o);
  ctx.changes.accounts.add(playerId);
  ctx.changes.bookTypes.add(o.type);
  ctx.changes.message = `Cancelled ${o.side} for ${o.remaining} ${name(o.type)} at ${o.price}.`;
  return o;
}
