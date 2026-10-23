import { CATALOG, UPGRADE_IDS, type UpgradeId } from './catalog.js';
import { V, bestPair, mu } from './ev-table.js';
import type { PlayerRoundReview, ReviewItem, RoundReviewInput, Verdict } from './review.js';
import { CLOSEOUT_FALLBACK_PRICE, STARTING_CASH } from './rules.js';

// Decision review. Risk-neutral model from docs/strategy/strategy.tex:
//   expected score at close = cash - short deductions + V(owned set),
// so each trade is scored by how much it changed that quantity. Use value
// comes from the exact expected-payout table; short deductions use the final
// round high (ex-post) or the high at the time of the trade (ex-ante).
// With ex-post valuation the trade EVs telescope exactly:
//   sum = (cash - 100) + V(S_final) - V(S_start) - deductions.

const name = (t: UpgradeId) => CATALOG[t].name;
const listNames = (ts: UpgradeId[]) => (ts.length ? ts.map(name).join(' + ') : 'nothing');
const fmt = (x: number) => (Math.abs(x) < 0.005 ? '0.00' : x.toFixed(2));
const signed = (x: number) => (x >= 0.005 ? `+${fmt(x)}` : fmt(x));
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

function verdictFor(ev: number): Verdict {
  return ev > 1 ? 'good' : ev < -1 ? 'bad' : 'ok';
}

function ownedSet(pool: UpgradeId[], q: Record<string, number>): UpgradeId[] {
  return pool.filter((t) => (q[t] ?? 0) > 0);
}

interface UnitValue {
  /** Units that changed the use value, and by how much in total. */
  useUnits: number;
  useValue: number;
  /** Units beyond the first copy (worth nothing at close). */
  spareUnits: number;
  /** Units that covered or created a short, valued at the deduction ex-post / ex-ante. */
  shortUnits: number;
  shortPost: number;
  shortAnte: number;
}

export function analyzeRound(input: RoundReviewInput): PlayerRoundReview[] {
  const { pool } = input;
  const trades = input.trades.slice().sort((a, b) => a.seq - b.seq);
  const names = new Map(input.players.map((p) => [p.id, p.name]));
  const who = (id: string) => names.get(id) ?? 'another player';
  const orderOwner = new Map(input.orders.map((o) => [o.id, o.playerId]));

  // Deduction reference at close: the frozen round high, or the disclosed fallback.
  const closeRef: Record<string, number> = {};
  for (const t of pool) closeRef[t] = input.finalHighs[t] ?? CLOSEOUT_FALLBACK_PRICE;
  for (const s of input.settlements) closeRef[s.type] = s.closeoutPrice;

  // Ex-ante high: the highest executed price for the type up to and including each trade.
  const highAt = new Map<string, number>();
  const running: Record<string, number> = {};
  for (const tr of trades) {
    running[tr.type] = Math.max(running[tr.type] ?? 0, tr.price);
    highAt.set(tr.id, running[tr.type]);
  }

  return input.players.map((player) => {
    const pid = player.id;
    const q: Record<string, number> = Object.fromEntries(UPGRADE_IDS.map((t) => [t, 0]));
    q[player.startingUpgrade] = 1;
    const startSet = ownedSet(pool, q);
    const items: ReviewItem[] = [];
    let tradingEV = 0;
    // Short history per type, for missed-cover search: [start, end) intervals while q < 0.
    const shortSince: Record<string, number | null> = {};
    const shortIntervals: Record<string, [number, number][]> = {};
    // Open short lots for linking a short to the trade that later covered it (FIFO).
    const openShortLots: Record<string, { price: number; itemIndex: number }[]> = {};
    const coverOf = new Map<number, { units: number; net: number; prices: number[] }>();
    const shortUnitsAt = new Map<number, number>();

    const markPosition = (t: UpgradeId, at: number) => {
      if (q[t] < 0 && shortSince[t] == null) shortSince[t] = at;
      if (q[t] >= 0 && shortSince[t] != null) {
        (shortIntervals[t] ??= []).push([shortSince[t]!, at]);
        shortSince[t] = null;
      }
    };

    for (const tr of trades) {
      if (tr.buyerId !== pid && tr.sellerId !== pid) continue;
      const t = tr.type;
      const buying = tr.buyerId === pid;
      const counterparty = who(buying ? tr.sellerId : tr.buyerId);
      const passive = orderOwner.get(tr.restingOrderId) === pid;
      const ante = highAt.get(tr.id)!;
      const v: UnitValue = { useUnits: 0, useValue: 0, spareUnits: 0, shortUnits: 0, shortPost: 0, shortAnte: 0 };
      const heldBefore = ownedSet(pool, q);
      const coveredLots: number[] = [];

      for (let u = 0; u < tr.qty; u++) {
        const S = ownedSet(pool, q);
        if (buying) {
          if (q[t] < 0) {
            v.shortUnits++;
            v.shortPost += closeRef[t];
            v.shortAnte += ante;
            const lot = openShortLots[t]?.shift();
            if (lot) {
              coveredLots.push(lot.price);
              const c = coverOf.get(lot.itemIndex) ?? { units: 0, net: 0, prices: [] };
              c.units++;
              c.net += lot.price - tr.price;
              c.prices.push(tr.price);
              coverOf.set(lot.itemIndex, c);
            }
          } else if (q[t] === 0) {
            v.useUnits++;
            v.useValue += V([...S, t]) - V(S);
          } else v.spareUnits++;
          q[t]++;
        } else {
          if (q[t] >= 2) v.spareUnits++;
          else if (q[t] === 1) {
            v.useUnits++;
            v.useValue += V(S) - V(S.filter((x) => x !== t));
          } else {
            v.shortUnits++;
            v.shortPost += closeRef[t];
            v.shortAnte += ante;
          }
          q[t]--;
        }
      }
      markPosition(t, tr.createdAt);

      const cash = tr.price * tr.qty;
      const evPost = buying ? v.useValue + v.shortPost - cash : cash - v.useValue - v.shortPost;
      const evAnte = buying ? v.useValue + v.shortAnte - cash : cash - v.useValue - v.shortAnte;
      tradingEV += evPost;

      const kind: ReviewItem['kind'] = buying ? (v.shortUnits > 0 ? 'cover' : 'buy') : v.shortUnits > 0 ? 'short' : 'sell';
      const how = passive
        ? `Your resting ${buying ? 'bid' : 'ask'} was filled: ${counterparty} ${buying ? 'sold you' : 'bought'} ${plural(tr.qty, 'unit')} of ${name(t)} at ${tr.price}.`
        : `You ${buying ? 'bought' : 'sold'} ${plural(tr.qty, 'unit')} of ${name(t)} ${buying ? 'from' : 'to'} ${counterparty} at ${tr.price}.`;
      const parts: string[] = [];
      if (v.useUnits > 0) {
        parts.push(
          buying
            ? `${heldBefore.length ? `With ${listNames(heldBefore)} it` : 'On its own it'} adds about ${fmt(v.useValue)} to your expected dice payout.`
            : `Giving it up lowers your expected dice payout by about ${fmt(v.useValue)}${heldBefore.length > 1 ? ` (you still had ${listNames(heldBefore.filter((x) => x !== t))})` : ''}.`,
        );
      }
      if (v.spareUnits > 0) parts.push(`${plural(v.spareUnits, 'unit')} ${buying ? 'was an extra copy, worth nothing to equip' : 'was a spare copy you could not have equipped'}.`);
      if (v.shortUnits > 0) {
        parts.push(
          buying
            ? `It covered ${plural(v.shortUnits, 'owed unit')}, avoiding a deduction of ${fmt(v.shortPost)} at the final round high (${fmt(v.shortAnte)} at the high when you bought).`
            : `That was a short sale: you then owed ${plural(v.shortUnits, 'unit')}, which would cost ${fmt(v.shortPost)} at the final round high unless bought back. On its own a short can at best break even, because the round high is never below your own sale price.`,
        );
      }
      if (coveredLots.length) {
        const net = coveredLots.reduce((a, p) => a + p, 0) - tr.price * coveredLots.length;
        parts.push(`Together with your short sale${coveredLots.length > 1 ? 's' : ''} at ${coveredLots.join(', ')}, that round trip made ${signed(net)}.`);
      }
      parts.push(`Net effect on your expected score: ${signed(evPost)}.`);

      const verdict = verdictFor(evPost);
      let better: string | undefined;
      if (kind === 'short') {
        for (let u = 0; u < v.shortUnits; u++) (openShortLots[t] ??= []).push({ price: tr.price, itemIndex: items.length });
        shortUnitsAt.set(items.length, v.shortUnits);
      }
      if (verdict === 'bad') {
        if (kind === 'buy') {
          better =
            v.useUnits === 0
              ? `You already owned ${name(t)}, and extra copies give no extra effect, so this purchase could not add value. Only buy types you do not own yet, or units you need to cover a short.`
              : `It was worth about ${fmt(v.useValue / v.useUnits)} per unit you could use${v.spareUnits ? ` (the other ${plural(v.spareUnits, 'unit')} was a spare copy worth nothing)` : ''}. Bidding at most ${Math.floor(v.useValue / tr.qty)} each would have kept this trade positive.`;
        }
        else if (kind === 'sell') better = `This upgrade was worth about ${fmt(v.useValue)} to you. Asking at least ${Math.ceil(v.useValue / Math.max(1, v.useUnits)) + 1} would have kept the sale positive.`;
        else if (kind === 'short') better = `Only sell short if you can buy back below ${tr.price}. Buying back at any price up to the current round high beats staying short to the close.`;
        else if (kind === 'cover') better = `Covering above the final round high cost more than the deduction would have. Covering earlier, before the high rose, usually costs less.`;
      }
      items.push({
        at: tr.createdAt,
        kind,
        title: `${kind === 'buy' ? 'Bought' : kind === 'sell' ? 'Sold' : kind === 'short' ? 'Sold short' : 'Bought back'} ${tr.qty > 1 ? `${tr.qty} × ` : ''}${name(t)} at ${tr.price}: ${signed(evPost)}`,
        detail: `${how} ${parts.join(' ')}`,
        evExAnte: evAnte,
        evExPost: evPost,
        verdict,
        better,
        tradeId: tr.id,
      });
    }

    // A short later bought back is judged on the round trip, not on the short alone.
    for (const [idx, c] of coverOf) {
      const item = items[idx];
      if (c.units < (shortUnitsAt.get(idx) ?? 1)) continue;
      item.verdict = verdictFor(c.net);
      item.title = `${item.title.replace(/: [+-]?[\d.]+$/, '')}, bought back at ${c.prices.join(', ')}: round trip ${signed(c.net)}`;
      item.detail += ` You bought ${c.units === 1 ? 'it' : 'them'} back at ${c.prices.join(', ')}, so the round trip made ${signed(c.net)}.`;
      if (item.verdict !== 'bad') item.better = undefined;
    }

    // Close of market: remaining short intervals end at the close.
    for (const t of pool) {
      if (shortSince[t] != null) {
        (shortIntervals[t] ??= []).push([shortSince[t]!, input.marketClosedAt]);
        shortSince[t] = null;
      }
    }

    // Missed covers: owed units at close while a cheaper ask from someone else was on the book.
    for (const s of input.settlements.filter((x) => x.playerId === pid && x.units > 0)) {
      const t = s.type;
      const intervals = shortIntervals[t] ?? [];
      let cheapest: { price: number; owner: string; at: number } | null = null;
      for (const o of input.orders) {
        if (o.type !== t || o.side !== 'ask' || o.playerId === pid || o.price >= s.closeoutPrice) continue;
        const end = o.closedAt ?? input.marketClosedAt;
        for (const [a, b] of intervals) {
          if (o.createdAt < b && end > a && (!cheapest || o.price < cheapest.price)) {
            cheapest = { price: o.price, owner: o.playerId, at: Math.max(o.createdAt, a) };
          }
        }
      }
      if (cheapest) {
        const saving = (s.closeoutPrice - cheapest.price) * s.units;
        items.push({
          at: cheapest.at,
          kind: 'missed_cover',
          title: `Missed a cheaper buy-back of ${name(t)}: could have saved ${fmt(saving)}`,
          detail: `You still owed ${plural(s.units, 'unit')} of ${name(t)} at the close and were charged ${s.closeoutPrice} each. While you were short, ${who(cheapest.owner)} was offering it at ${cheapest.price}. Buying back there (if you had the cash) would have saved ${fmt(saving)}.`,
          evExAnte: null,
          evExPost: null,
          verdict: 'info',
          better: `Accept the ask at ${cheapest.price} while you are short. Covering at or below the current round high is never worse than waiting.`,
        });
      }
    }

    // Unfilled and cancelled orders: information only.
    for (const o of input.orders.filter((x) => x.playerId === pid)) {
      if (o.status === 'closed' && o.remaining > 0) {
        items.push({
          at: input.marketClosedAt,
          kind: 'unfilled',
          title: `${o.side === 'bid' ? 'Bid' : 'Ask'} for ${name(o.type)} at ${o.price} never ${o.remaining === o.originalQty ? 'filled' : 'fully filled'}`,
          detail: `${plural(o.remaining, 'unit')} of your ${o.side === 'bid' ? 'bid to buy' : 'offer to sell'} ${name(o.type)} at ${o.price} ${o.remaining === 1 ? 'was' : 'were'} still on the book when the market closed and ${o.remaining === 1 ? 'was' : 'were'} cancelled automatically.`,
          evExAnte: null,
          evExPost: null,
          verdict: 'info',
        });
      } else if (o.status === 'cancelled') {
        items.push({
          at: o.closedAt ?? o.createdAt,
          kind: 'cancel',
          title: `Cancelled ${o.side === 'bid' ? 'bid' : 'ask'} for ${name(o.type)} at ${o.price}`,
          detail: `You withdrew ${plural(o.remaining, 'unit')} of your ${o.side === 'bid' ? 'bid' : 'ask'} at ${o.price}. Cancelling has no direct effect on your score.`,
          evExAnte: null,
          evExPost: null,
          verdict: 'info',
        });
      }
    }

    // Equipment and leftover inventory at the close (after the bank closed out shorts).
    const finalSet = ownedSet(pool, q);
    const rec = input.dice[pid];
    const finalDecision = input.decisions.filter((d) => d.playerId === pid && d.kind === 'equip_final').at(-1);
    const equipped: UpgradeId[] = rec?.resolution.equipment ?? finalDecision?.equip?.types ?? bestPair(finalSet);
    const best = bestPair(finalSet);
    const muEquipped = mu(equipped);
    const vFinal = V(finalSet);
    const equipmentLoss = vFinal - muEquipped;
    const auto = finalDecision?.equip?.auto;
    items.push({
      at: input.marketClosedAt + 1,
      kind: 'equip',
      title: `Equipped ${listNames(equipped)}: expected payout ${fmt(muEquipped)}${equipmentLoss > 0.005 ? `, ${fmt(equipmentLoss)} below your best option` : ''}`,
      detail:
        (finalSet.length === 0
          ? 'You owned no active upgrades at the close, so you rolled five plain dice (expected 87.50).'
          : equipmentLoss <= 0.005
            ? `That was the best choice available from what you owned (${listNames(finalSet)}).`
            : `From what you owned (${listNames(finalSet)}) the best choice was ${listNames(best)}, expected ${fmt(vFinal)}.`) +
        (auto === true ? ' The timeout rule chose this for you.' : auto === false ? ' You chose this yourself.' : ''),
      evExAnte: -equipmentLoss,
      evExPost: -equipmentLoss,
      verdict: verdictFor(-equipmentLoss),
      better: equipmentLoss > 0.005 ? `Equip ${listNames(best)}. Pick manually before the timer ends: the timeout rule fills slots in catalog order, not by value.` : undefined,
    });

    const dead: string[] = [];
    let deadUnits = 0;
    for (const t of pool) {
      const n = q[t] > 0 ? q[t] - (equipped.includes(t) ? 1 : 0) : 0;
      if (n > 0) {
        dead.push(`${n} × ${name(t)}`);
        deadUnits += n;
      }
    }
    if (deadUnits > 0) {
      items.push({
        at: input.marketClosedAt,
        kind: 'dead_inventory',
        title: `Held ${plural(deadUnits, 'unit')} you could not use`,
        detail: `At the close you held ${dead.join(', ')} that you did not equip. Unequipped units are worth nothing to your score, so selling each at any price of 1 or more would have added that much.`,
        evExAnte: null,
        evExPost: null,
        verdict: 'info',
        better: 'Sell spare copies and upgrades outside your best pair before the market closes.',
      });
    }

    items.sort((a, b) => a.at - b.at);
    const payout = rec?.resolution.payout ?? muEquipped;
    return {
      roundId: input.roundId,
      roundNumber: input.roundNumber,
      playerId: pid,
      items,
      summary: {
        startValue: STARTING_CASH + V(startSet),
        tradingEV,
        equipmentLoss,
        luck: payout - muEquipped,
        score: rec?.score ?? 0,
        expectedPayoutEquipped: muEquipped,
        bestPossiblePair: best,
      },
    };
  });
}
