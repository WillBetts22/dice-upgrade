import type { Snapshot } from '../shared/types.js';
import { type Actor, available, isLive, nextQuoteAt, playerFv, publicFv, type RoomState } from './engine.js';

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
    // Public fair value after each information event, as a step series for the chart.
    const series: [number, number][] | null =
      showPublic ? r.infoEvents.map((e) => [e.at, Math.round(e.publicFvAfter * 100) / 100] as [number, number]) : null;
    let privateHolders: Record<number, number> | null = null;
    if (roundDone) {
      privateHolders = {};
      for (const cards of Object.values(r.privateCards)) for (const c of cards) privateHolders[c] = (privateHolders[c] ?? 0) + 1;
    }
    const nextStage = room.phase === 'market' ? r.schedule.find((e) => !e.done && e.kind === 'stage' && e.at !== null && e.at < r.endsAt!) : undefined;
    round = {
      number: r.number,
      type: r.type,
      startedAt: r.startedAt,
      endsAt: r.endsAt,
      nextInfoAt: nextStage?.at ?? null,
      stageTimes: r.schedule.filter((e) => e.kind === 'stage' && e.at !== null).map((e) => e.at!),
      contractSize: r.contract.length,
      publicCards: pub,
      rule: r.rule,
      shocks: r.shocks,
      roles: r.roles,
      quotes: Object.entries(r.quotes)
        .filter(([, q]) => q.bidSize > 0 || q.askSize > 0)
        .map(([pid, q]) => ({
          playerId: pid,
          bid: q.bid,
          ask: q.ask,
          bidSize: q.bidSize,
          askSize: q.askSize,
          bidAvail: available(r, pid, 'bid'),
          askAvail: available(r, pid, 'ask'),
          postedAt: q.postedAt,
        })),
      trades: r.trades.slice(-TRADE_TAIL).map((t) => ({ id: t.id, at: t.at, buyerId: t.buyerId, sellerId: t.sellerId, aggressorId: t.aggressorId, price: t.price, qty: t.qty })),
      chart: r.trades.map((t) => [t.at, t.price] as [number, number]),
      publicFvSeries: series,
      publicFv: showPublic ? publicFv(r) : null,
      volume: r.trades.reduce((a, t) => a + t.qty, 0),
      lastPrice: r.lastPrice,
      contract: roundDone ? r.contract : null,
      settlement: r.settlement,
      insiderId: roundDone ? r.insiderId : null,
      privateHolders,
    };
  }

  let me: Snapshot['me'] = null;
  if (r && playerId && r.participants.includes(playerId)) {
    me = {
      role: r.roles[playerId],
      privateCards: r.privateCards[playerId] ?? [],
      position: r.positions[playerId] ?? 0,
      cash: r.cash[playerId] ?? 0,
      rebates: r.rebates[playerId] ?? 0,
      fv: roundDone ? playerFv(r, playerId) : null,
      nextQuoteAt: nextQuoteAt(r, playerId),
      quote: r.quotes[playerId] ?? null,
      uptimeMs: (() => {
        const u = r.uptime[playerId];
        if (!u) return 0;
        return u.ms + (u.since !== null && room.pausedAt === null && room.phase === 'market' ? now - u.since : 0);
      })(),
      isInsider: r.insiderId === playerId,
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
                : r.participants.map((pid) => ({ playerId: pid, position: r.positions[pid] ?? 0, live: isLive(r.quotes[pid]) })),
            quoting: r.participants.filter((pid) => isLive(r.quotes[pid])).length,
          }
        : null,
  };
}
