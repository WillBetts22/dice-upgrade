import type { Snapshot } from '../shared/types.js';
import { useNow } from './common.js';

/** Trade prices against the public fair value (and the settlement once known). */
export function PriceChart({ s, offset, height = 220 }: { s: Snapshot; offset: number; height?: number }) {
  const now = useNow(1000) + offset;
  const r = s.round;
  if (!r || r.startedAt === null || r.endsAt === null) return null;
  const W = 640;
  const H = height;
  const pad = { l: 36, r: 10, t: 10, b: 20 };
  const t0 = r.startedAt;
  const t1 = r.endsAt;
  const tNow = r.settlement !== null ? t1 : Math.min(t1, now);
  const ys: number[] = r.chart.map((p) => p[1]);
  for (const p of r.publicFvSeries ?? []) ys.push(p[1]);
  if (r.settlement !== null) ys.push(r.settlement);
  if (!ys.length) ys.push(70);
  let lo = Math.min(...ys);
  let hi = Math.max(...ys);
  if (hi - lo < 16) {
    const m = (hi + lo) / 2;
    lo = m - 8;
    hi = m + 8;
  }
  lo = Math.floor(lo - 2);
  hi = Math.ceil(hi + 2);
  const x = (t: number) => pad.l + ((Math.min(Math.max(t, t0), t1) - t0) / (t1 - t0)) * (W - pad.l - pad.r);
  const y = (v: number) => pad.t + (1 - (v - lo) / (hi - lo)) * (H - pad.t - pad.b);
  const ticks = 4;
  const fvPath = (() => {
    const pts = r.publicFvSeries ?? [];
    if (!pts.length) return '';
    let d = `M${x(pts[0][0])},${y(pts[0][1])}`;
    for (let i = 1; i < pts.length; i++) d += ` H${x(pts[i][0])} V${y(pts[i][1])}`;
    return d + ` H${x(tNow)}`;
  })();
  const tradePath = r.chart.map((p, i) => `${i ? 'L' : 'M'}${x(p[0])},${y(p[1])}`).join(' ');
  return (
    <div>
      <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Trade prices over time against the public fair value">
        {Array.from({ length: ticks + 1 }, (_, i) => {
          const v = lo + ((hi - lo) * i) / ticks;
          return (
            <g key={i}>
              <line x1={pad.l} x2={W - pad.r} y1={y(v)} y2={y(v)} stroke="var(--border)" strokeWidth={1} />
              <text x={pad.l - 6} y={y(v) + 4} textAnchor="end">
                {Math.round(v)}
              </text>
            </g>
          );
        })}
        {(r.stageTimes ?? []).slice(1).map((t) => (
          <line key={t} x1={x(t)} x2={x(t)} y1={pad.t} y2={H - pad.b} stroke="var(--border)" strokeDasharray="3 4" />
        ))}
        {r.shocks.map((k) => (
          <line key={k.at} x1={x(k.at)} x2={x(k.at)} y1={pad.t} y2={H - pad.b} stroke="var(--warn)" strokeWidth={2} />
        ))}
        {fvPath && <path d={fvPath} fill="none" stroke="var(--muted)" strokeWidth={2} strokeDasharray="6 4" />}
        {r.settlement !== null && <line x1={pad.l} x2={W - pad.r} y1={y(r.settlement)} y2={y(r.settlement)} stroke="var(--high)" strokeWidth={2.5} />}
        {tradePath && <path d={tradePath} fill="none" stroke="var(--text)" strokeWidth={1.5} opacity={0.6} />}
        {r.chart.map((p, i) => (
          <circle key={i} cx={x(p[0])} cy={y(p[1])} r={2.6} fill="var(--text)" />
        ))}
        <line x1={x(tNow)} x2={x(tNow)} y1={pad.t} y2={H - pad.b} stroke="var(--accent)" strokeWidth={1} opacity={0.5} />
      </svg>
      <div className="legend">
        <span>
          <i style={{ background: 'var(--text)' }} />
          trades
        </span>
        {r.publicFvSeries && (
          <span>
            <i style={{ background: 'var(--muted)' }} />
            public fair value
          </span>
        )}
        {r.settlement !== null && (
          <span>
            <i style={{ background: 'var(--high)' }} />
            settlement {r.settlement}
          </span>
        )}
        {r.shocks.length > 0 && (
          <span>
            <i style={{ background: 'var(--warn)' }} />
            news
          </span>
        )}
      </div>
    </div>
  );
}
