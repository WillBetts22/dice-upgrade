import type { Snapshot } from '../shared/types.js';
import { type Actor, available, book, isLive, knownCards, nextQuoteAt, playerFv, publicFv, type RoomState } from './engine.js';

const TRADE_TAIL = 40;

/** What one viewer may see. Hidden contract cards and other players' private cards never leave the server mid-round. */
export function buildSnapshot(room: RoomState, actor: Actor, now: number, connected: (pid: string) => boolean): Snapshot {
  const r = room.round;
  const playerId = actor.kind === 'player' ? actor.playerId : null;
  const done = room.phase === 'results' || room.phase === 'finished';
  const roundDone = !!r && r.settlement !== null;
  const hostPlays = Object.values(room.players).some((p) => p.isHost && !p.spectator);
  // Fair values are never shown during the market: players work them out. A host who is not playing sees the public one.
  const showPublic = roundDone || (actor.kind === 'host' && !hostPlays);

  let round: Snapshot['round'] = null;
  if (r) {
    const pub = r.publicOrder.slice(0, r.revealed);
    let privateHolders: Record<number, number> | null = null;
    if (roundDone) {
      privateHolders = {};
      for (const cards of Object.values(r.privateCards)) for (const c of cards) privateHolders[c] = (privateHolders[c] ?? 0) + 1;
    }
    const nextStage = room.phase === 'market' ? r.schedule.find((e) => !e.done && e.kind === 'stage' && e.at !== null && e.at < r.endsAt!) : undefined;
    const seen = new Set(roundDone ? r.productCards : playerId ? knownCards(r, playerId) : pub);
    const markets: NonNullable<Snapshot['round']>['markets'] = {};
    for (const m of r.markets) {
      const b = book(r, m);
      const trades = r.trades.filter((t) => t.market === m);
      markets[m] = {
        quotes: Object.entries(b.quotes)
          .filter(([, q]) => q.bidSize > 0 || q.askSize > 0)
          .map(([pid, q]) => ({
            playerId: pid,
            bid: q.bid,
            ask: q.ask,
            bidSize: q.bidSize,
            askSize: q.askSize,
            bidAvail: available(r, pid, 'bid', m),
            askAvail: available(r, pid, 'ask', m),
            postedAt: q.postedAt,
          })),
        trades: trades.slice(-TRADE_TAIL).map((t) => ({ id: t.id, market: m, at: t.at, buyerId: t.buyerId, sellerId: t.sellerId, aggressorId: t.aggressorId, price: t.price, qty: t.qty })),
        chart: trades.map((t) => [t.at, t.price] as [number, number]),
        // Public fair value after each information event, as a step series for the chart.
        publicFvSeries: showPublic ? r.infoEvents.filter((e) => e.m[m]).map((e) => [e.at, Math.round(e.m[m]!.publicFvAfter * 100) / 100] as [number, number]) : null,
        publicFv: showPublic ? publicFv(r, m) : null,
        volume: trades.reduce((a, t) => a + t.qty, 0),
        lastPrice: b.lastPrice,
        settlement: r.settlement?.[m] ?? null,
      };
    }
    round = {
      number: r.number,
      type: r.type,
      startedAt: r.startedAt,
      endsAt: r.endsAt,
      nextInfoAt: nextStage?.at ?? null,
      stageTimes: r.schedule.filter((e) => e.kind === 'stage' && e.at !== null).map((e) => e.at!),
      contractSize: r.contract.length,
      publicCards: pub,
      productKnown: r.markets.includes('product') ? r.productCards.filter((c) => seen.has(c)) : [],
      productCount: r.markets.includes('product') ? r.productCards.length : 0,
      rule: r.rule,
      shocks: r.shocks,
      roles: r.roles,
      marketIds: r.markets,
      markets,
      contract: roundDone ? r.contract : null,
      insiderId: roundDone ? r.insiderId : null,
      privateHolders,
    };
  }

  let me: Snapshot['me'] = null;
  if (r && playerId && r.participants.includes(playerId)) {
    const books: NonNullable<Snapshot['me']>['books'] = {};
    for (const m of r.markets) {
      const b = book(r, m);
      const u = b.uptime[playerId];
      books[m] = {
        position: b.positions[playerId] ?? 0,
        cash: b.cash[playerId] ?? 0,
        rebates: b.rebates[playerId] ?? 0,
        fv: roundDone ? playerFv(r, playerId, m) : null,
        nextQuoteAt: nextQuoteAt(r, playerId, m),
        quote: b.quotes[playerId] ?? null,
        uptimeMs: u ? u.ms + (u.since !== null && room.pausedAt === null && room.phase === 'market' ? now - u.since : 0) : 0,
      };
    }
    me = {
      role: r.roles[playerId],
      privateCards: r.privateCards[playerId] ?? [],
      clues: r.clues[playerId] ?? [],
      isInsider: r.insiderId === playerId,
      books,
    };
  }

  // Players see their own reviews; the host sees everyone's once a round has settled.
  const reviews = actor.kind === 'host' ? room.reviews : playerId ? room.reviews.filter((x) => x.playerId === playerId) : [];

  return {
    serverTime: now,
    revision: room.revision,
    code: room.code,
    phase: room.phase,
    phaseDeadline: room.phaseDeadline,
    paused: room.pausedAt !== null,
    pausedRemainingMs: room.pausedAt !== null && room.phaseDeadline !== null ? Math.max(0, room.phaseDeadline - room.pausedAt) : null,
    config: room.config,
    you: { kind: actor.kind, playerId },
    players: Object.values(room.players)
      .sort((a, b) => a.joinedAt - b.joinedAt)
      .map((p) => ({ id: p.id, name: p.name, isBot: p.isBot, isHost: p.isHost, spectator: p.spectator, connected: p.isBot || connected(p.id), total: p.total })),
    round,
    me,
    results: room.results,
    reviews: done || actor.kind === 'host' ? reviews : reviews.filter((x) => x.roundNumber < room.roundNumber),
    host:
      actor.kind === 'host' && r
        ? {
            // Live positions are hidden from a host who is also playing, until the round settles.
            positions:
              hostPlays && !roundDone
                ? []
                : r.markets.flatMap((m) => r.participants.map((pid) => ({ playerId: pid, market: m, position: book(r, m).positions[pid] ?? 0, live: isLive(book(r, m).quotes[pid]) }))),
            quoting: Object.fromEntries(r.markets.map((m) => [m, r.participants.filter((pid) => isLive(book(r, m).quotes[pid])).length])),
          }
        : null,
  };
}
