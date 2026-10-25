import { CATALOG, POOL_VERSIONS, UPGRADE_IDS, type UpgradeId } from '../shared/catalog.js';
import { MAX_DICE, resolveDice } from '../shared/dice.js';
import { FAIRNESS_TOLERANCE, MAX_PLAYERS, MAX_ROUNDS, MIN_PLAYERS } from '../shared/rules.js';
import { fallbackDeal, planDeal, spreadAfter } from '../server/engine/deal.js';

export interface DistStats {
  equipment: UpgradeId[];
  mean: number;
  variance: number;
  sd: number;
  min: number;
  max: number;
  p50: number;
  p90: number;
  p99: number;
  /** P(payout >= 150) */
  pAtLeast150: number;
  maxDiceUsed: number;
  outcomes: number;
}

/**
 * Exact distribution: enumerate every initial roll and every eligible reroll
 * outcome, weighting each path by its probability.
 */
export function exactDistribution(equipment: UpgradeId[]): { dist: Map<number, number>; maxDiceUsed: number; outcomes: number } {
  const n = equipment.includes('extra_die') ? 6 : 5;
  const dist = new Map<number, number>();
  let maxDiceUsed = 0;
  let outcomes = 0;
  const original = new Array(n).fill(1);
  const total = 6 ** n;
  for (let code = 0; code < total; code++) {
    let c = code;
    for (let i = 0; i < n; i++) {
      original[i] = (c % 6) + 1;
      c = Math.floor(c / 6);
    }
    // Probe how many replacement draws this roll needs.
    let used = 0;
    resolveDice(equipment, () => (used < n ? original[used++] : (used++, 1)));
    const k = used - n;
    const combos = 6 ** k;
    const w = 1 / total / combos;
    for (let rc = 0; rc < combos; rc++) {
      const reps = [(rc % 6) + 1, (Math.floor(rc / 6) % 6) + 1];
      let i = 0;
      const res = resolveDice(equipment, () => (i < n ? original[i++] : reps[i++ - n]));
      maxDiceUsed = Math.max(maxDiceUsed, res.finalDice.length);
      dist.set(res.payout, (dist.get(res.payout) ?? 0) + w);
      outcomes++;
    }
  }
  return { dist, maxDiceUsed, outcomes };
}

export function stats(equipment: UpgradeId[]): DistStats {
  const { dist, maxDiceUsed, outcomes } = exactDistribution(equipment);
  const entries = [...dist.entries()].sort((a, b) => a[0] - b[0]);
  let mean = 0;
  for (const [v, p] of entries) mean += v * p;
  let variance = 0;
  for (const [v, p] of entries) variance += (v - mean) ** 2 * p;
  const quantile = (q: number) => {
    let acc = 0;
    for (const [v, p] of entries) {
      acc += p;
      if (acc >= q - 1e-12) return v;
    }
    return entries[entries.length - 1][0];
  };
  const pAtLeast150 = entries.filter(([v]) => v >= 150).reduce((a, [, p]) => a + p, 0);
  return {
    equipment,
    mean,
    variance,
    sd: Math.sqrt(variance),
    min: entries[0][0],
    max: entries[entries.length - 1][0],
    p50: quantile(0.5),
    p90: quantile(0.9),
    p99: quantile(0.99),
    pAtLeast150,
    maxDiceUsed,
    outcomes,
  };
}

export const THRESHOLDS = {
  standaloneMin: 14,
  standaloneMax: 19,
  standaloneSpread: 3,
  pairMax: 45,
};

export interface BalanceReport {
  catalogVersion: string;
  base: DistStats;
  singles: (DistStats & { increment: number })[];
  pairs: (DistStats & { increment: number; synergy: number; atLeastSingles: boolean })[];
  standaloneSpread: number;
  checks: { name: string; pass: boolean; detail: string }[];
  schedule: { rosterSizes: [number, number]; rounds: number; trials: number; worstSpread: number; fallbackUses: number; fallbackChecked: boolean; pass: boolean };
  pools: { version: string; pools: UpgradeId[][]; allPairsPass: boolean }[];
}

export function buildReport(scheduleTrials = 20): BalanceReport {
  const base = stats([]);
  const singles = UPGRADE_IDS.map((t) => {
    const s = stats([t]);
    return { ...s, increment: s.mean - base.mean };
  });
  const inc = Object.fromEntries(singles.map((s) => [s.equipment[0], s.increment])) as Record<UpgradeId, number>;
  const singleMean = Object.fromEntries(singles.map((s) => [s.equipment[0], s.mean])) as Record<UpgradeId, number>;
  const pairs: BalanceReport['pairs'] = [];
  for (let i = 0; i < UPGRADE_IDS.length; i++) {
    for (let j = i + 1; j < UPGRADE_IDS.length; j++) {
      const a = UPGRADE_IDS[i];
      const b = UPGRADE_IDS[j];
      const s = stats([a, b]);
      const increment = s.mean - base.mean;
      pairs.push({
        ...s,
        increment,
        synergy: increment - inc[a] - inc[b],
        atLeastSingles: s.mean >= singleMean[a] - 1e-9 && s.mean >= singleMean[b] - 1e-9,
      });
    }
  }
  const incs = singles.map((s) => s.increment);
  const standaloneSpread = Math.max(...incs) - Math.min(...incs);
  const checks: BalanceReport['checks'] = [];
  for (const s of singles) {
    checks.push({
      name: `standalone ${s.equipment[0]} in [${THRESHOLDS.standaloneMin}, ${THRESHOLDS.standaloneMax}]`,
      pass: s.increment >= THRESHOLDS.standaloneMin && s.increment <= THRESHOLDS.standaloneMax,
      detail: s.increment.toFixed(4),
    });
    const catalogValue = CATALOG[s.equipment[0]].standaloneIncrement;
    checks.push({
      name: `catalog value for ${s.equipment[0]} matches enumeration`,
      pass: Math.abs(catalogValue - s.increment) < 0.001,
      detail: `${catalogValue} vs ${s.increment.toFixed(4)}`,
    });
  }
  checks.push({ name: `standalone spread <= ${THRESHOLDS.standaloneSpread}`, pass: standaloneSpread <= THRESHOLDS.standaloneSpread, detail: standaloneSpread.toFixed(4) });
  for (const p of pairs) {
    checks.push({ name: `pair ${p.equipment.join('+')} increment <= ${THRESHOLDS.pairMax}`, pass: p.increment <= THRESHOLDS.pairMax, detail: p.increment.toFixed(4) });
    checks.push({ name: `pair ${p.equipment.join('+')} >= each single`, pass: p.atLeastSingles, detail: p.mean.toFixed(4) });
  }
  for (const s of [base, ...singles, ...pairs]) {
    checks.push({ name: `${s.equipment.join('+') || 'none'} uses at most ${MAX_DICE} dice and terminates`, pass: s.maxDiceUsed <= MAX_DICE && Number.isFinite(s.max), detail: `${s.maxDiceUsed} dice, max ${s.max}` });
  }

  const passingPairs = new Set(pairs.filter((p) => p.increment <= THRESHOLDS.pairMax && p.atLeastSingles).map((p) => p.equipment.join('+')));
  const pools = POOL_VERSIONS.map((v) => ({
    version: v.id,
    pools: v.pools,
    allPairsPass: v.pools.every((pool) => {
      for (let i = 0; i < pool.length; i++)
        for (let j = i + 1; j < pool.length; j++) {
          const [a, b] = [pool[i], pool[j]].sort((x, y) => UPGRADE_IDS.indexOf(x) - UPGRADE_IDS.indexOf(y));
          if (!passingPairs.has(`${a}+${b}`)) return false;
        }
      return true;
    }),
  }));
  for (const p of pools) checks.push({ name: `pool version ${p.version}: every pair in every pool passes`, pass: p.allPairsPass, detail: `${p.pools.length} pools` });

  const schedule = scheduleCheck(scheduleTrials);
  checks.push({
    name: `deal schedules for ${MIN_PLAYERS}-${MAX_PLAYERS} players x 1-${MAX_ROUNDS} rounds stay within ${FAIRNESS_TOLERANCE} coins`,
    pass: schedule.pass,
    detail: `worst cumulative spread ${schedule.worstSpread.toFixed(4)}; fallback schedule verified: ${schedule.fallbackChecked}`,
  });

  return { catalogVersion: 'v1', base, singles, pairs, standaloneSpread, checks, schedule, pools };
}

export function scheduleCheck(trials: number): BalanceReport['schedule'] {
  let worst = 0;
  let fallbackUses = 0;
  let pass = true;
  let fallbackChecked = true;
  for (const v of POOL_VERSIONS) {
    for (let n = MIN_PLAYERS; n <= MAX_PLAYERS; n++) {
      for (let trial = 0; trial < trials; trial++) {
        const acc: Record<string, number> = {};
        const fb: Record<string, number> = {};
        for (let i = 0; i < n; i++) acc[`p${i}`] = fb[`p${i}`] = 0;
        for (let round = 1; round <= MAX_ROUNDS; round++) {
          const plan = planDeal({ poolVersion: v.id, roundNumber: round, accumulated: acc, seed: (n * 7919 + trial * 104729 + round) >>> 0 });
          if (plan.usedFallback) fallbackUses++;
          const counts = Object.values(plan.supply);
          if (Math.max(...counts) - Math.min(...counts) > 1) pass = false;
          for (const [p, t] of Object.entries(plan.assignment)) acc[p] += CATALOG[t].standaloneIncrement;
          const vals = Object.values(acc);
          worst = Math.max(worst, Math.max(...vals) - Math.min(...vals));
          if (trial === 0) {
            // The precomputed fallback schedule must itself be valid at every size and round.
            const f = fallbackDeal(v.pools, round, fb);
            if (spreadAfter(fb, f.assignment) > FAIRNESS_TOLERANCE + 1e-9) fallbackChecked = false;
            for (const [p, t] of Object.entries(f.assignment)) fb[p] += CATALOG[t].standaloneIncrement;
          }
        }
      }
    }
  }
  if (worst > FAIRNESS_TOLERANCE + 1e-9 || !fallbackChecked) pass = false;
  return { rosterSizes: [MIN_PLAYERS, MAX_PLAYERS], rounds: MAX_ROUNDS, trials, worstSpread: worst, fallbackUses, fallbackChecked, pass };
}

const f2 = (x: number) => x.toFixed(2);
const f4 = (x: number) => (Math.abs(x) < 5e-5 ? 0 : x).toFixed(4);
const nm = (eq: UpgradeId[]) => (eq.length ? eq.map((t) => CATALOG[t].name).join(' + ') : 'No upgrade');

export function renderMarkdown(r: BalanceReport): string {
  const lines: string[] = [];
  lines.push('# Balance report (catalog v1)', '');
  lines.push('Generated by `npm run balance`. Every number is an exact enumeration over all dice outcomes and all eligible reroll outcomes, not a simulation.', '');
  lines.push(`Unmodified mean payout: **${f4(r.base.mean)}** coins (sd ${f2(r.base.sd)}).`, '');
  lines.push('## Singles', '', '| Upgrade | Mean | Increment | SD | P50 | P90 | P99 | Max | P(>=150) |', '|---|---|---|---|---|---|---|---|---|');
  for (const s of r.singles) lines.push(`| ${nm(s.equipment)} | ${f4(s.mean)} | ${f4(s.increment)} | ${f2(s.sd)} | ${s.p50} | ${s.p90} | ${s.p99} | ${s.max} | ${f4(s.pAtLeast150)} |`);
  lines.push('', `Standalone spread: **${f4(r.standaloneSpread)}** coins (limit ${THRESHOLDS.standaloneSpread}).`, '');
  lines.push('## Pairs', '', '| Pair | Mean | Increment | Synergy | SD | P90 | P99 | Max | >= singles |', '|---|---|---|---|---|---|---|---|---|');
  for (const p of r.pairs) lines.push(`| ${nm(p.equipment)} | ${f4(p.mean)} | ${f4(p.increment)} | ${f4(p.synergy)} | ${f2(p.sd)} | ${p.p90} | ${p.p99} | ${p.max} | ${p.atLeastSingles ? 'yes' : 'NO'} |`);
  lines.push('', 'Synergy = pair increment minus the sum of the two standalone increments. Negative synergy means the pair overlaps (for example Safety Net matters less once another upgrade lifts the base).', '');
  lines.push('## Pools', '');
  for (const p of r.pools) lines.push(`- \`${p.version}\`: ${p.pools.length} pools, every pair inside passes: ${p.allPairsPass ? 'yes' : 'NO'}`);
  lines.push('', '## Deal schedule check', '');
  const s = r.schedule;
  lines.push(
    `Roster sizes ${s.rosterSizes[0]}-${s.rosterSizes[1]}, rounds 1-${s.rounds}, ${s.trials} seeded trials each. Worst cumulative endowment spread: **${f4(s.worstSpread)}** coins (limit 3). Fallback schedule used ${s.fallbackUses} times; fallback schedule independently verified: ${s.fallbackChecked ? 'yes' : 'NO'}.`,
    '',
  );
  lines.push('## Checks', '', '| Check | Result | Detail |', '|---|---|---|');
  for (const c of r.checks) lines.push(`| ${c.name} | ${c.pass ? 'pass' : 'FAIL'} | ${c.detail} |`);
  lines.push('', '## What this does not show', '');
  lines.push(
    'This is an expected-payout calibration of the dice effects. It is not a proof of strategic balance, equal variance, or freedom from collusion or squeeze strategies in the live market. Upgrade values and the 50 coin price cap are prototype settings that need playtesting.',
  );
  return lines.join('\n') + '\n';
}
