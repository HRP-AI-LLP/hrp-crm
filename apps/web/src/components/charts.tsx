/**
 * Dependency-free SVG charts in the hrpai.in palette: bar (optionally stacked), horizontal bar,
 * line, donut, funnel and a single-number tile. Every chart has a text alternative (an
 * aria-label summary plus a visually hidden table) so screen readers get the numbers.
 */
import { useId, useState } from 'react';

export const PALETTE = ['#0f8dde', '#06a6c7', '#075492', '#22d3ee', '#35a9f4', '#083f73', '#67e8f9', '#94a3b8', '#0b6d86', '#a5f3fc'];

export interface Series {
  label: string;
  values: number[];
}

export interface ChartData {
  categories: string[];
  series: Series[];
}

export type Fmt = (n: number) => string;
const defaultFmt: Fmt = (n) => (Math.abs(n) >= 1e7 ? `${(n / 1e7).toFixed(1)} Cr` : Math.abs(n) >= 1e5 ? `${(n / 1e5).toFixed(1)} L` : Math.abs(n) >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : `${Math.round(n * 100) / 100}`);

function niceMax(v: number) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

function SrTable({ data, fmt }: { data: ChartData; fmt: Fmt }) {
  return (
    <table className="sr-only data" data-export-note="Figures behind the chart">
      <thead>
        <tr>
          <th>Category</th>
          {data.series.map((s) => (
            <th key={s.label}>{s.label}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {data.categories.map((c, i) => (
          <tr key={c + i}>
            <td>{c}</td>
            {data.series.map((s) => (
              <td key={s.label}>{fmt(s.values[i] ?? 0)}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Legend({ series }: { series: Series[] }) {
  if (series.length < 2) return null;
  return (
    <div className="chart-legend">
      {series.map((s, i) => (
        <span key={s.label}>
          <i style={{ background: PALETTE[i % PALETTE.length] }} />
          {s.label}
        </span>
      ))}
    </div>
  );
}

const trunc = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function BarChart({ data, fmt = defaultFmt, height = 240, stacked = true, onSelect }: { data: ChartData; fmt?: Fmt; height?: number; stacked?: boolean; onSelect?: (category: number) => void }) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 640;
  const H = height;
  const pad = { l: 48, r: 8, t: 10, b: 46 };
  const n = data.categories.length;
  const totals = data.categories.map((_, i) => (stacked ? data.series.reduce((a, s) => a + Math.max(0, s.values[i] ?? 0), 0) : Math.max(0, ...data.series.map((s) => s.values[i] ?? 0))));
  const max = niceMax(Math.max(0, ...totals));
  const bw = (W - pad.l - pad.r) / Math.max(n, 1);
  const y = (v: number) => pad.t + (H - pad.t - pad.b) * (1 - v / max);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => t * max);
  return (
    <figure className="chart" aria-label={`Bar chart: ${data.categories.map((c, i) => `${c} ${fmt(totals[i]!)}`).join(', ')}`}>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" preserveAspectRatio="none">
        {ticks.map((t) => (
          <g key={t}>
            <line x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} className="grid" />
            <text x={pad.l - 6} y={y(t) + 4} textAnchor="end" className="tick">
              {fmt(t)}
            </text>
          </g>
        ))}
        {data.categories.map((c, i) => {
          let acc = 0;
          const x0 = pad.l + i * bw + bw * 0.15;
          const w = bw * 0.7;
          return (
            <g key={c + i} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)} onClick={() => onSelect?.(i)} style={{ cursor: onSelect ? 'pointer' : undefined }}>
              <rect x={pad.l + i * bw} y={pad.t} width={bw} height={H - pad.t - pad.b} fill="transparent" />
              {data.series.map((s, si) => {
                const v = Math.max(0, s.values[i] ?? 0);
                if (stacked) {
                  const r = <rect key={s.label} x={x0} y={y(acc + v)} width={w} height={Math.max(0, y(acc) - y(acc + v))} rx={3} fill={PALETTE[si % PALETTE.length]} opacity={hover === null || hover === i ? 1 : 0.55} />;
                  acc += v;
                  return r;
                }
                const sw = w / data.series.length;
                return <rect key={s.label} x={x0 + si * sw} y={y(v)} width={Math.max(1, sw - 2)} height={Math.max(0, y(0) - y(v))} rx={3} fill={PALETTE[si % PALETTE.length]} opacity={hover === null || hover === i ? 1 : 0.55} />;
              })}
              <text x={pad.l + i * bw + bw / 2} y={H - pad.b + 16} textAnchor="middle" className="tick">
                {trunc(c, Math.max(4, Math.floor(bw / 7)))}
              </text>
              {hover === i && (
                <text x={pad.l + i * bw + bw / 2} y={Math.max(pad.t + 12, y(totals[i]!) - 6)} textAnchor="middle" className="val">
                  {fmt(totals[i]!)}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      <Legend series={data.series} />
      <SrTable data={data} fmt={fmt} />
    </figure>
  );
}

export function HBarChart({ data, fmt = defaultFmt, onSelect }: { data: ChartData; fmt?: Fmt; onSelect?: (category: number) => void }) {
  const s = data.series[0] ?? { label: '', values: [] };
  const max = Math.max(0, ...s.values) || 1;
  return (
    <figure className="chart hbar" aria-label={`Bar chart: ${data.categories.map((c, i) => `${c} ${fmt(s.values[i] ?? 0)}`).join(', ')}`}>
      {data.categories.map((c, i) => (
        <button key={c + i} className="hbar-row" onClick={() => onSelect?.(i)} disabled={!onSelect} type="button">
          <span className="hbar-label" title={c}>
            {c}
          </span>
          <span className="hbar-track">
            <span style={{ width: `${(Math.max(0, s.values[i] ?? 0) / max) * 100}%`, background: PALETTE[i % 3 === 0 ? 0 : i % 3 === 1 ? 1 : 2] }} />
          </span>
          <b>{fmt(s.values[i] ?? 0)}</b>
        </button>
      ))}
      <SrTable data={data} fmt={fmt} />
    </figure>
  );
}

export function LineChart({ data, fmt = defaultFmt, height = 240 }: { data: ChartData; fmt?: Fmt; height?: number }) {
  const gid = useId().replace(/:/g, '');
  const W = 640;
  const H = height;
  const pad = { l: 48, r: 12, t: 12, b: 40 };
  const n = data.categories.length;
  const max = niceMax(Math.max(0, ...data.series.flatMap((s) => s.values)));
  const x = (i: number) => pad.l + (n <= 1 ? (W - pad.l - pad.r) / 2 : (i * (W - pad.l - pad.r)) / (n - 1));
  const y = (v: number) => pad.t + (H - pad.t - pad.b) * (1 - v / max);
  const ticks = [0, 0.5, 1].map((t) => t * max);
  const every = Math.ceil(n / 8);
  return (
    <figure className="chart" aria-label={`Line chart: ${data.categories.map((c, i) => `${c} ${fmt(data.series[0]?.values[i] ?? 0)}`).join(', ')}`}>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" preserveAspectRatio="none">
        <defs>
          <linearGradient id={gid} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor={PALETTE[0]} stopOpacity="0.25" />
            <stop offset="1" stopColor={PALETTE[0]} stopOpacity="0" />
          </linearGradient>
        </defs>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} className="grid" />
            <text x={pad.l - 6} y={y(t) + 4} textAnchor="end" className="tick">
              {fmt(t)}
            </text>
          </g>
        ))}
        {data.series.map((s, si) => {
          const pts = s.values.map((v, i) => `${x(i)},${y(v)}`).join(' ');
          return (
            <g key={s.label}>
              {si === 0 && n > 1 && <polygon points={`${x(0)},${y(0)} ${pts} ${x(n - 1)},${y(0)}`} fill={`url(#${gid})`} />}
              <polyline points={pts} fill="none" stroke={PALETTE[si % PALETTE.length]} strokeWidth={2.5} strokeLinejoin="round" />
              {s.values.map((v, i) => (
                <circle key={i} cx={x(i)} cy={y(v)} r={3.5} fill="#fff" stroke={PALETTE[si % PALETTE.length]} strokeWidth={2}>
                  <title>{`${data.categories[i]}: ${fmt(v)}`}</title>
                </circle>
              ))}
            </g>
          );
        })}
        {data.categories.map((c, i) =>
          i % every === 0 ? (
            <text key={c + i} x={x(i)} y={H - pad.b + 18} textAnchor="middle" className="tick">
              {trunc(c, 10)}
            </text>
          ) : null,
        )}
      </svg>
      <Legend series={data.series} />
      <SrTable data={data} fmt={fmt} />
    </figure>
  );
}

export function DonutChart({ data, fmt = defaultFmt, onSelect }: { data: ChartData; fmt?: Fmt; onSelect?: (category: number) => void }) {
  const s = data.series[0] ?? { label: '', values: [] };
  const total = s.values.reduce((a, v) => a + Math.max(0, v), 0) || 1;
  let a0 = -Math.PI / 2;
  const R = 70;
  const r = 44;
  const arc = (a: number, b: number) => {
    const large = b - a > Math.PI ? 1 : 0;
    const p = (ang: number, rad: number) => `${100 + rad * Math.cos(ang)},${100 + rad * Math.sin(ang)}`;
    return `M${p(a, R)} A${R},${R} 0 ${large} 1 ${p(b, R)} L${p(b, r)} A${r},${r} 0 ${large} 0 ${p(a, r)} Z`;
  };
  return (
    <figure className="chart donut" aria-label={`Donut chart: ${data.categories.map((c, i) => `${c} ${fmt(s.values[i] ?? 0)}`).join(', ')}`}>
      <svg viewBox="0 0 200 200" role="img">
        {s.values.map((v, i) => {
          const frac = Math.max(0, v) / total;
          const a1 = a0 + frac * Math.PI * 2 - (frac === 1 ? 0.0001 : 0);
          const d = arc(a0, a1);
          a0 = a1;
          return (
            <path key={i} d={d} fill={PALETTE[i % PALETTE.length]} onClick={() => onSelect?.(i)} style={{ cursor: onSelect ? 'pointer' : undefined }}>
              <title>{`${data.categories[i]}: ${fmt(v)} (${Math.round(frac * 100)}%)`}</title>
            </path>
          );
        })}
        <text x="100" y="98" textAnchor="middle" className="donut-total">
          {fmt(total)}
        </text>
        <text x="100" y="116" textAnchor="middle" className="tick">
          total
        </text>
      </svg>
      <ul className="donut-legend">
        {data.categories.map((c, i) => (
          <li key={c + i}>
            <i style={{ background: PALETTE[i % PALETTE.length] }} />
            <span>{c}</span>
            <b>{fmt(s.values[i] ?? 0)}</b>
          </li>
        ))}
      </ul>
      <SrTable data={data} fmt={fmt} />
    </figure>
  );
}

export function FunnelChart({ data, fmt = defaultFmt }: { data: ChartData; fmt?: Fmt }) {
  const s = data.series[0] ?? { label: '', values: [] };
  const max = Math.max(0, ...s.values) || 1;
  return (
    <figure className="chart funnel" aria-label={`Funnel: ${data.categories.map((c, i) => `${c} ${fmt(s.values[i] ?? 0)}`).join(', ')}`}>
      {data.categories.map((c, i) => {
        const v = s.values[i] ?? 0;
        const prev = i > 0 ? (s.values[i - 1] ?? 0) : null;
        return (
          <div key={c + i} className="funnel-row">
            <div className="funnel-bar" style={{ width: `${Math.max(8, (Math.max(0, v) / max) * 100)}%`, background: PALETTE[i % PALETTE.length] }}>
              <span>{c}</span>
              <b>{fmt(v)}</b>
            </div>
            {prev !== null && prev > 0 && <span className="funnel-conv">{Math.round((v / prev) * 100)}%</span>}
          </div>
        );
      })}
      <SrTable data={data} fmt={fmt} />
    </figure>
  );
}

export function NumberTile({ value, label, fmt = defaultFmt }: { value: number; label: string; fmt?: Fmt }) {
  return (
    <figure className="chart number-tile" aria-label={`${label}: ${fmt(value)}`}>
      <b>{fmt(value)}</b>
      <span>{label}</span>
    </figure>
  );
}
