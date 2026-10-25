// Decision review: every trade and quote valued against the player's exact fair value at the time.
import { cardLabel, SHOCKS } from './cards.js';
import { EDGE_NOISE, MISSED_EDGE, MISSED_WINDOW_MS, STALE_MS } from './rules.js';
import type { InfoEvent, Round } from './types.js';

export type Verdict = 'good' | 'ok' | 'bad' | 'missed' | 'info';

export interface ReviewItem {
  at: number;
  kind: 'buy' | 'sell' | 'fill_buy' | 'fill_sell' | 'quote' | 'stale' | 'missed' | 'inventory';
  title: string;
  detail: string;
  /** Coins of expected value given what you knew at that moment (includes rebate on fills). */
  evThen: number | null;
  /** Coins actually made once the contract settled. */
  evFinal: number | null;
  verdict: Verdict;
  better?: string;
}

/**
 * Exact identity: pnl = decisionEdge + infoLuck, where decisionEdge sums every fill's
 * (your fair value - price) x lots x direction plus rebates, and infoLuck sums
 * (settlement - your fair value) x lots x direction.
 */
export interface PlayerRoundReview {
  roundNumber: number;
  playerId: string;
  startedAt: number;
  items: ReviewItem[];
  summary: {
    pnl: number;
    decisionEdge: number;
    infoLuck: number;
    rebates: number;
    aggressiveEdge: number;
    passiveEdge: number;
    fills: number;
    lots: number;
    finalPosition: number;
    settlement: number;
    fvAtClose: number;
    /** Share of the market you had a live two-sided quote; null for takers. */
    uptime: number | null;
    goodCount: number;
    badCount: number;
  };
}

const f1 = (x: number) => (Math.round(x * 10) / 10).toFixed(1);
const signed = (x: number) => `${x >= 0 ? '+' : '-'}${Math.abs(x).toFixed(1)}`;
const lots = (q: number) => `${q} lot${q === 1 ? '' : 's'}`;

function clock(at: number, start: number): string {
  const s = Math.max(0, Math.round((at - start) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function verdictOf(ev: number): Verdict {
  return ev >= EDGE_NOISE ? 'good' : ev <= -EDGE_NOISE ? 'bad' : 'ok';
}

function eventName(e: InfoEvent, start: number): string {
  if (e.kind === 'shock') return `the "${SHOCKS[e.shock!].label}" news at ${clock(e.at, start)}`;
  if (e.stage === 0) return 'the opening deal';
  return `the ${clock(e.at, start)} reveal${e.publicNew.length ? ` (${e.publicNew.map(cardLabel).join(' ')})` : ''}`;
}

export interface AnalyzeInput {
  round: Round;
  names: Record<string, string>;
  /** Fair value of each participant just before the final reveal. */
  fvAtClose: Record<string, number>;
}

export function analyzeRound({ round: r, names, fvAtClose }: AnalyzeInput): PlayerRoundReview[] {
  const S = r.settlement!;
  const start = r.startedAt!;
  const end = r.endsAt!;
  const name = (id: string) => names[id] ?? '?';
  const out: PlayerRoundReview[] = [];

  for (const pid of r.participants) {
    const items: ReviewItem[] = [];
    const role = r.roles[pid];
    let decisionEdge = 0;
    let infoLuck = 0;
    let aggressiveEdge = 0;
    let passiveEdge = 0;
    let rebates = 0;
    let fills = 0;
    let lotCount = 0;
    const mine = r.trades.filter((t) => t.buyerId === pid || t.sellerId === pid);

    for (const t of mine) {
      const buyer = t.buyerId === pid;
      const dir = buyer ? 1 : -1;
      const fv = buyer ? t.buyerFv : t.sellerFv;
      const cpId = buyer ? t.sellerId : t.buyerId;
      const cpFv = buyer ? t.sellerFv : t.buyerFv;
      const aggressor = t.aggressorId === pid;
      const rebate = aggressor ? 0 : t.rebate;
      const edgeThen = dir * (fv - t.price) * t.qty + rebate;
      const edgeFinal = dir * (S - t.price) * t.qty + rebate;
      decisionEdge += edgeThen;
      infoLuck += edgeFinal - edgeThen;
      rebates += rebate;
      fills++;
      lotCount += t.qty;
      if (aggressor) aggressiveEdge += edgeThen;
      else passiveEdge += edgeThen;

      const verb = buyer ? 'Bought' : 'Sold';
      const prep = buyer ? 'from' : 'to';
      const knew = `Your fair value was ${f1(fv)}`;
      const settled = `It settled at ${S}, so the trade made ${signed(edgeFinal)}.`;
      const cpKnewMore = Math.abs(cpFv - S) + 1 < Math.abs(fv - S);
      const cpNote = cpKnewMore ? ` ${name(cpId)} was better informed: their estimate was ${f1(cpFv)}.` : '';
      let verdict = verdictOf(edgeThen);
      let detail: string;
      let better: string | undefined;

      if (aggressor) {
        detail = `${knew}, so ${buyer ? 'paying' : 'selling at'} ${t.price} was worth ${signed(edgeThen)} for ${lots(t.qty)}. ${settled}`;
        if (verdict === 'bad') better = buyer ? `Only buy below your fair value: an ask of ${Math.floor(fv) - 1} or less.` : `Only sell above your fair value: a bid of ${Math.ceil(fv) + 1} or more.`;
        if (verdict === 'ok') better = 'Close to fair: the trade gained little. Fine if it reduced inventory risk.';
      } else {
        const quoteText = `${t.restingBid}/${t.restingAsk}`;
        const containedAtPost = t.restingFvAtPost >= t.restingBid && t.restingFvAtPost <= t.restingAsk;
        detail = `${name(cpId)} ${buyer ? 'sold to your bid' : 'bought from your ask'} at ${t.price} on your ${quoteText} quote. ${knew}, worth ${signed(edgeThen)}${rebate ? ` including a ${rebate} coin rebate` : ''}. ${settled}${cpNote}`;
        if (verdict === 'good') detail = `Earned the spread. ${detail}`;
        if (verdict === 'bad') {
          if (containedAtPost && Math.abs(fv - t.restingFvAtPost) >= 0.5) {
            detail = `Picked off on a stale quote. You posted ${quoteText} when your fair value was ${f1(t.restingFvAtPost)}; by the fill it was ${f1(fv)}. ${detail}`;
            better = 'Move or pull your quote right after every reveal or news event.';
          } else {
            detail = `Your quote did not contain your own fair value, so this fill cost you. ${detail}`;
            better = `Center your quote on your fair value (about ${Math.round(fv)}) unless you are deliberately cutting inventory.`;
          }
        }
      }
      items.push({
        at: t.at,
        kind: aggressor ? (buyer ? 'buy' : 'sell') : buyer ? 'fill_buy' : 'fill_sell',
        title: `${aggressor ? verb : buyer ? 'Your bid was hit:' : 'Your ask was lifted:'} ${lots(t.qty)} ${prep} ${name(cpId)} at ${t.price}`,
        detail,
        evThen: edgeThen,
        evFinal: edgeFinal,
        verdict,
        better,
      });
    }

    // Quotes that left out the poster's own fair value.
    const myDecisions = r.decisions.filter((d) => d.playerId === pid);
    for (const d of myDecisions) {
      if (d.kind !== 'quote') continue;
      const inside = d.fv >= d.bid! && d.fv <= d.ask!;
      const q = `${d.bid}/${d.ask}`;
      if (inside) {
        items.push({ at: d.at, kind: 'quote', title: `Quoted ${q} x${d.size}`, detail: `Your fair value ${f1(d.fv)} was inside your quote.`, evThen: null, evFinal: null, verdict: 'good' });
        continue;
      }
      const tooLow = d.fv > d.ask!;
      const gap = tooLow ? d.fv - d.ask! : d.bid! - d.fv;
      const skewing = (tooLow && d.position > 0) || (!tooLow && d.position < 0);
      items.push({
        at: d.at,
        kind: 'quote',
        title: `Quoted ${q} with fair value ${f1(d.fv)}`,
        detail: skewing
          ? `Your quote sat ${f1(gap)} ${tooLow ? 'below' : 'above'} your fair value while you were ${d.position > 0 ? 'long' : 'short'} ${Math.abs(d.position)}. Skewing to cut inventory is reasonable, but each fill gives up about ${f1(gap)} a lot.`
          : `Anyone ${tooLow ? 'buying from your ask' : 'selling to your bid'} gained about ${f1(gap)} a lot from you, and you were not cutting inventory.`,
        evThen: null,
        evFinal: null,
        verdict: skewing ? 'ok' : 'bad',
        better: skewing ? undefined : `Quote around ${Math.round(d.fv) - 2}/${Math.round(d.fv) + 2} instead.`,
      });
    }

    // Stale quotes and missed opportunities after each information event.
    for (const e of r.infoEvents) {
      const fv = e.fvAfter[pid];
      if (fv === undefined) continue;
      const q = e.quotes[pid];
      if (q && role !== 'taker' && (fv < q.bid - 0.5 || fv > q.ask + 0.5)) {
        const next = myDecisions.find((d) => d.at > e.at);
        const until = next ? next.at : end;
        const lag = until - e.at;
        const hit = mine.filter((t) => t.restingId === pid && t.at > e.at && t.at <= until);
        const cost = hit.reduce((a, t) => a + (t.buyerId === pid ? 1 : -1) * ((t.buyerId === pid ? t.buyerFv : t.sellerFv) - t.price) * t.qty, 0);
        if (lag > STALE_MS) {
          items.push({
            at: e.at,
            kind: 'stale',
            title: `Stale quote ${q.bid}/${q.ask} for ${next ? `${Math.round(lag / 1000)} s` : 'the rest of the stage'}`,
            detail: `After ${eventName(e, start)} your fair value was ${f1(fv)}, outside your quote.${hit.length ? ` You were filled ${hit.length} time${hit.length === 1 ? '' : 's'} meanwhile for ${signed(cost)} (counted on the fill rows).` : ' Nobody picked you off this time.'}`,
            evThen: null,
            evFinal: null,
            verdict: 'bad',
            better: 'Update within a few seconds of new information, or pull the quote while you think.',
          });
        } else if (next) {
          items.push({ at: e.at, kind: 'quote', title: `Updated your quote ${Math.round(lag / 1000)} s after ${eventName(e, start)}`, detail: `Your fair value moved to ${f1(fv)} and you requoted quickly.`, evThen: null, evFinal: null, verdict: 'good' });
        }
      }
      let bestAsk: { id: string; px: number } | null = null;
      let bestBid: { id: string; px: number } | null = null;
      for (const [id, oq] of Object.entries(e.quotes)) {
        if (id === pid) continue;
        if (role === 'taker' && r.roles[id] !== 'maker') continue;
        if (oq.askSize > 0 && (!bestAsk || oq.ask < bestAsk.px)) bestAsk = { id, px: oq.ask };
        if (oq.bidSize > 0 && (!bestBid || oq.bid > bestBid.px)) bestBid = { id, px: oq.bid };
      }
      const buyEdge = bestAsk ? fv - bestAsk.px : -Infinity;
      const sellEdge = bestBid ? bestBid.px - fv : -Infinity;
      const edge = Math.max(buyEdge, sellEdge);
      if (edge < MISSED_EDGE) continue;
      const buy = buyEdge >= sellEdge;
      const other = buy ? bestAsk! : bestBid!;
      const acted = mine.some((t) => t.aggressorId === pid && t.at > e.at && t.at <= e.at + MISSED_WINDOW_MS && (t.buyerId === pid) === buy);
      if (acted) continue;
      const pos = e.positions[pid] ?? 0;
      const quoting = role === 'taker' || (q && q.bidSize > 0 && q.askSize > 0);
      items.push({
        at: e.at,
        kind: 'missed',
        title: `Missed: ${name(other.id)} was ${buy ? 'asking' : 'bidding'} ${other.px} with your fair value at ${f1(fv)}`,
        detail: `After ${eventName(e, start)}, ${buy ? 'buying 1 lot from' : 'selling 1 lot to'} ${name(other.id)} was worth ${signed(edge)} to you, and you did not take it within ${MISSED_WINDOW_MS / 1000} s.${(buy && pos >= 8) || (!buy && pos <= -8) ? ` You were already ${pos > 0 ? 'long' : 'short'} ${Math.abs(pos)}, so passing was defensible.` : ''}`,
        evThen: edge,
        evFinal: null,
        verdict: 'missed',
        better: quoting ? `${buy ? 'Buy' : 'Sell'} it: a quote ${f1(edge)} through your fair value is free money on average.` : 'Keep a live two-sided quote so you are allowed to take good prices when they appear.',
      });
    }

    const pos = r.positions[pid] ?? 0;
    const fvClose = fvAtClose[pid];
    if (Math.abs(pos) >= 8) {
      items.push({
        at: end,
        kind: 'inventory',
        title: `Ended ${pos > 0 ? 'long' : 'short'} ${Math.abs(pos)}`,
        detail: `A big position means the last hidden cards decide your round. Your closing fair value was ${f1(fvClose)}; settlement ${S} moved your result by ${signed(pos * (S - fvClose))}.`,
        evThen: null,
        evFinal: null,
        verdict: 'info',
        better: 'Skew your quote toward flat (lower both sides when long, raise them when short) as the round ends.',
      });
    }

    items.sort((a, b) => a.at - b.at);
    const u = r.uptime[pid];
    const pnl = (r.cash[pid] ?? 0) + pos * S;
    out.push({
      roundNumber: r.number,
      playerId: pid,
      startedAt: start,
      items,
      summary: {
        pnl,
        decisionEdge,
        infoLuck,
        rebates,
        aggressiveEdge,
        passiveEdge,
        fills,
        lots: lotCount,
        finalPosition: pos,
        settlement: S,
        fvAtClose: fvClose,
        uptime: role === 'taker' || !r.activeMs ? null : Math.min(1, (u?.ms ?? 0) / r.activeMs),
        goodCount: items.filter((i) => i.verdict === 'good').length,
        badCount: items.filter((i) => i.verdict === 'bad').length,
      },
    });
  }
  return out;
}

