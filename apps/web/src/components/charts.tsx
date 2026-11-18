/**
 * Charts, drawn at their real pixel size (no stretched text), on a validated categorical palette
 * (CSS --series-1…8, light and dark). Every chart can be shown another way — bars, stacked bars,
 * horizontal bars, lines, area, donut, pie or a table — from the small switcher at its top right; the
 * choice is remembered per chart. Hover shows the exact figures; legends toggle series; a hidden table
 * carries the numbers for screen readers.
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react';

/** Categorical slots, in their fixed order (never cycled past eight: the rest fold into "Other"). */
export const PALETTE = Array.from({ length: 8 }, (_, i) => `var(--series-${i + 1})`);

export interface Series {
  label: string;
  values: number[];
}
export interface ChartData {
  categories: string[];
  series: Series[];
}
export type Fmt = (n: number) => string;
export type ChartKind = 'bar' | 'stacked' | 'hbar' | 'line' | 'area' | 'donut' | 'pie' | 'funnel' | 'table';

const defaultFmt: Fmt = (n) => {
  const a = Math.abs(n);
  const s = n < 0 ? '−' : '';
  const t = (x: number) => (x >= 100 ? x.toFixed(0) : x.toFixed(1).replace(/\.0$/, ''));
  if (a >= 1e7) return `${s}${t(a / 1e7)} Cr`;
  if (a >= 1e5) return `${s}${t(a / 1e5)} L`;
  if (a >= 1e3) return `${s}${t(a / 1e3)}K`;
  return `${s}${Math.round(a * 100) / 100}`;
};

function niceStep(range: number, ticks = 4) {
  const raw = range / ticks || 1;
  const p = 10 ** Math.floor(Math.log10(raw));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= raw) return m * p;
  return 10 * p;
}
function scale(lo: number, hi: number) {
  if (hi === lo) hi = lo + 1;
  const step = niceStep(hi - lo);
  const top = Math.ceil(hi / step) * step;
  const bottom = Math.floor(lo / step) * step;
  const ticks: number[] = [];
  for (let v = bottom; v <= top + step / 2; v += step) ticks.push(Math.round(v * 1e6) / 1e6);
  return { top, bottom, ticks };
}

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    if (!ref.current) return;
    setW(Math.floor(ref.current.getBoundingClientRect().width));
    const ro = new ResizeObserver(([e]) => setW(Math.floor(e!.contentRect.width)));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

const trunc = (s: string, n: number) => (s.length > n ? `${s.slice(0, Math.max(1, n - 1))}…` : s);

/** More than eight series fold into "Other" so colours never repeat. */
function fold(d: ChartData): ChartData {
  if (d.series.length <= 8) return d;
  const keep = d.series.slice(0, 7);
  const rest = d.series.slice(7);
  return { categories: d.categories, series: [...keep, { label: 'Other', values: d.categories.map((_, i) => rest.reduce((t, s) => t + (s.values[i] || 0), 0)) }] };
}
/** For part-of-whole views of one series: more than eight slices become "Other". */
function foldSlices(cats: string[], vals: number[]) {
  const rows = cats.map((c, i) => ({ c, v: Math.max(0, vals[i] ?? 0) })).filter((r) => r.v > 0);
  if (rows.length <= 8) return rows;
  const sorted = [...rows].sort((a, b) => b.v - a.v);
  return [...sorted.slice(0, 7), { c: 'Other', v: sorted.slice(7).reduce((t, r) => t + r.v, 0) }];
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

function Legend({ series, hidden, toggle }: { series: Series[]; hidden: Set<number>; toggle: (i: number) => void }) {
  if (series.length < 2) return null;
  return (
    <div className="viz-legend">
      {series.map((s, i) => (
        <button key={s.label} type="button" className={hidden.has(i) ? 'off' : ''} onClick={() => toggle(i)} title={hidden.has(i) ? 'Show' : 'Hide'}>
          <i style={{ background: PALETTE[i] }} />
          {s.label}
        </button>
      ))}
    </div>
  );
}

function Tip({ x, width, title, rows, total, fmt }: { x: number; width: number; title: string; rows: { label: string; value: number; color?: string }[]; total?: number | null; fmt: Fmt }) {
  const w = 200;
  return (
    <div className="viz-tip" style={{ left: Math.min(Math.max(x - w / 2, 0), Math.max(0, width - w)), width: w }}>
      <b>{title}</b>
      {rows.map((r) => (
        <div key={r.label} className="viz-tip-row">
          <span>
            {r.color && <i style={{ background: r.color }} />}
            {r.label}
          </span>
          <span>{fmt(r.value)}</span>
        </div>
      ))}
      {total != null && rows.length > 1 && (
        <div className="viz-tip-row total">
          <span>Total</span>
          <span>{fmt(total)}</span>
        </div>
      )}
    </div>
  );
}

/* ───────────── bars, stacked bars, lines and area ───────────── */

function XY({ data, fmt, height, kind, onSelect }: { data: ChartData; fmt: Fmt; height: number; kind: 'bar' | 'stacked' | 'line' | 'area'; onSelect?: (i: number) => void }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const [hidden, setHidden] = useState<Set<number>>(new Set());
  const gid = useId().replace(/:/g, '');
  const d = fold(data);
  const shown = d.series.map((s, i) => ({ ...s, i })).filter((s) => !hidden.has(s.i));
  const n = d.categories.length;
  const stacked = kind === 'stacked';
  const finite = (v: number | undefined) => (Number.isFinite(v) ? (v as number) : 0);
  const hiVals = stacked
    ? d.categories.map((_, c) => shown.reduce((t, s) => t + Math.max(0, finite(s.values[c])), 0))
    : shown.flatMap((s) => s.values.filter(Number.isFinite));
  const loVals = stacked ? d.categories.map((_, c) => shown.reduce((t, s) => t + Math.min(0, finite(s.values[c])), 0)) : shown.flatMap((s) => s.values.filter(Number.isFinite));
  const sc = scale(Math.min(0, ...loVals), Math.max(0, ...hiVals));
  // never two gridlines with the same label (small ranges in rounded units)
  const { top, bottom } = sc;
  const ticks = new Set(sc.ticks.map(fmt)).size < sc.ticks.length ? [bottom, top].filter((t, i, a) => a.indexOf(t) === i) : sc.ticks;
  const pad = { l: 8 + Math.max(...ticks.map((t) => fmt(t).length)) * 6.6, r: 12, t: 10, b: 28 };
  const iw = Math.max(0, width - pad.l - pad.r);
  const ih = height - pad.t - pad.b;
  const y = (v: number) => pad.t + ih - ((v - bottom) / (top - bottom || 1)) * ih;
  const line = kind === 'line' || kind === 'area';
  const band = n ? iw / n : 0;
  const cx = (i: number) => (line ? pad.l + (n <= 1 ? iw / 2 : (i * iw) / (n - 1)) : pad.l + band * i + band / 2);
  const every = Math.max(1, Math.ceil((n * 64) / Math.max(iw, 1)));
  const groupW = Math.min(band * 0.72, stacked ? 44 : 22 * shown.length + 2 * (shown.length - 1));
  const barW = stacked ? groupW : Math.max(2, (groupW - 2 * (shown.length - 1)) / Math.max(1, shown.length));
  const r = Math.min(4, barW / 2);
  /** a bar with its data-end rounded and its base square, on the zero line */
  const bar = (x: number, v0: number, v1: number, w: number, roundTop: boolean) => {
    const yA = y(v0);
    const yB = y(v1);
    const up = yB < yA;
    const h = Math.abs(yA - yB);
    if (h < 0.5) return '';
    const rr = roundTop ? Math.min(r, h) : 0;
    if (up) return `M${x},${yA} V${yB + rr} Q${x},${yB} ${x + rr},${yB} H${x + w - rr} Q${x + w},${yB} ${x + w},${yB + rr} V${yA} Z`;
    return `M${x},${yA} V${yB - rr} Q${x},${yB} ${x + rr},${yB} H${x + w - rr} Q${x + w},${yB} ${x + w},${yB - rr} V${yA} Z`;
  };
  const h = hover != null ? hover : null;
  return (
    <div ref={ref} className="viz-plot" onMouseLeave={() => setHover(null)}>
      {width > 0 && (
        <svg width={width} height={height} role="img" aria-label={`${kind} chart`}>
          <defs>
            {line &&
              shown.map((s) => (
                <linearGradient key={s.i} id={`${gid}-${s.i}`} x1="0" x2="0" y1="0" y2="1">
                  <stop offset="0" stopColor={PALETTE[s.i]} stopOpacity={kind === 'area' ? 0.28 : 0.12} />
                  <stop offset="1" stopColor={PALETTE[s.i]} stopOpacity="0" />
                </linearGradient>
              ))}
          </defs>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={pad.l} x2={width - pad.r} y1={y(t)} y2={y(t)} className={t === 0 ? 'viz-zero' : 'viz-grid'} />
              <text x={pad.l - 8} y={y(t)} dy="0.32em" textAnchor="end" className="viz-tick">
                {fmt(t)}
              </text>
            </g>
          ))}
          {h != null && line && <line x1={cx(h)} x2={cx(h)} y1={pad.t} y2={pad.t + ih} className="viz-cross" />}
          {d.categories.map((c, i) => (
            <g key={c + i}>
              {h === i && !line && <rect x={pad.l + band * i + 2} y={pad.t} width={Math.max(0, band - 4)} height={ih} rx={6} className="viz-hover" />}
              {i % every === 0 && (
                <text x={cx(i)} y={height - 8} textAnchor="middle" className="viz-tick">
                  {trunc(c, Math.max(4, Math.floor((band * every) / 6.5)))}
                </text>
              )}
            </g>
          ))}
          {!line &&
            d.categories.map((_, i) => {
              let pos = 0;
              let neg = 0;
              const x0 = cx(i) - groupW / 2;
              const topIdx = stacked ? [...shown].reverse().find((s) => finite(s.values[i]) > 0)?.i : null;
              return (
                <g key={i}>
                  {shown.map((s, k) => {
                    const v = finite(s.values[i]);
                    if (!v) return null;
                    if (stacked) {
                      const from = v >= 0 ? pos : neg;
                      const to = from + v;
                      if (v >= 0) pos = to;
                      else neg = to;
                      // a 2px surface gap between stacked segments
                      return <path key={s.i} d={bar(x0, from, to, groupW, s.i === topIdx || v < 0)} fill={PALETTE[s.i]} className="viz-seg" />;
                    }
                    return <path key={s.i} d={bar(x0 + k * (barW + 2), 0, v, barW, true)} fill={PALETTE[s.i]} opacity={h == null || h === i ? 1 : 0.45} />;
                  })}
                </g>
              );
            })}
          {line &&
            shown.map((s) => {
              const pts = s.values.map((v, i) => (Number.isFinite(v) ? [cx(i), y(v)] : null));
              const segs: number[][][] = [];
              let cur: number[][] = [];
              for (const p of pts) {
                if (p) cur.push(p);
                else if (cur.length) {
                  segs.push(cur);
                  cur = [];
                }
              }
              if (cur.length) segs.push(cur);
              return (
                <g key={s.i}>
                  {segs.map((sg, k) => (
                    <g key={k}>
                      {(kind === 'area' || shown.length === 1) && sg.length > 1 && <path d={`M${sg[0]![0]},${y(Math.max(0, bottom))} ${sg.map((p) => `L${p[0]},${p[1]}`).join(' ')} L${sg[sg.length - 1]![0]},${y(Math.max(0, bottom))} Z`} fill={`url(#${gid}-${s.i})`} />}
                      <path d={`M${sg.map((p) => `${p[0]},${p[1]}`).join(' L')}`} fill="none" stroke={PALETTE[s.i]} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
                    </g>
                  ))}
                  {s.values.map((v, i) =>
                    Number.isFinite(v) && (h === i || n <= 14) ? <circle key={i} cx={cx(i)} cy={y(v)} r={h === i ? 5 : 3} fill={PALETTE[s.i]} className="viz-dot" /> : null,
                  )}
                </g>
              );
            })}
          {/* hit areas, wider than the marks */}
          {d.categories.map((_, i) => (
            <rect
              key={i}
              x={line ? cx(i) - (n > 1 ? iw / (n - 1) / 2 : iw / 2) : pad.l + band * i}
              y={pad.t}
              width={line ? (n > 1 ? iw / (n - 1) : iw) : band}
              height={ih}
              fill="transparent"
              onMouseEnter={() => setHover(i)}
              onClick={() => onSelect?.(i)}
              style={{ cursor: onSelect ? 'pointer' : 'default' }}
            />
          ))}
        </svg>
      )}
      {h != null && width > 0 && (
        <Tip
          x={cx(h)}
          width={width}
          title={d.categories[h]!}
          rows={shown.filter((s) => Number.isFinite(s.values[h])).map((s) => ({ label: s.label, value: s.values[h]!, color: PALETTE[s.i] }))}
          total={stacked || shown.length > 1 ? shown.reduce((t, s) => t + finite(s.values[h]), 0) : null}
          fmt={fmt}
        />
      )}
      <Legend series={d.series} hidden={hidden} toggle={(i) => setHidden((x) => (x.has(i) ? new Set([...x].filter((y) => y !== i)) : new Set([...x, i])))} />
    </div>
  );
}

/* ───────────── horizontal bars ───────────── */

function HBars({ data, fmt, onSelect }: { data: ChartData; fmt: Fmt; onSelect?: (i: number) => void }) {
  const d = fold(data);
  const multi = d.series.length > 1;
  const totals = d.categories.map((_, i) => d.series.reduce((t, s) => t + Math.max(0, s.values[i] ?? 0), 0));
  const max = Math.max(1, ...totals);
  const grand = totals.reduce((a, b) => a + b, 0) || 1;
  return (
    <div className="viz-hbar">
      {d.categories.map((c, i) => (
        <button key={c + i} type="button" className="viz-hbar-row" onClick={() => onSelect?.(i)} disabled={!onSelect} title={`${c}: ${fmt(totals[i]!)}`}>
          <span className="viz-hbar-label">{c}</span>
          <span className="viz-hbar-track">
            {d.series.map((s, si) => {
              const v = Math.max(0, s.values[i] ?? 0);
              return v ? <span key={si} style={{ width: `${(v / max) * 100}%`, background: PALETTE[multi ? si : 0] }} /> : null;
            })}
          </span>
          <b>{fmt(totals[i]!)}</b>
          <span className="viz-hbar-pct">{Math.round((totals[i]! / grand) * 100)}%</span>
        </button>
      ))}
      {multi && <Legend series={d.series} hidden={new Set()} toggle={() => undefined} />}
    </div>
  );
}

/* ───────────── donut and pie ───────────── */

function Donut({ data, fmt, pie, onSelect }: { data: ChartData; fmt: Fmt; pie?: boolean; onSelect?: (i: number) => void }) {
  const [hover, setHover] = useState<number | null>(null);
  const s = data.series[0] ?? { label: '', values: [] };
  const slices = foldSlices(data.categories, s.values);
  const total = slices.reduce((t, x) => t + x.v, 0) || 1;
  const R = 92;
  const r = pie ? 0 : 58;
  let a0 = -Math.PI / 2;
  const P = (a: number, rad: number) => `${110 + rad * Math.cos(a)},${110 + rad * Math.sin(a)}`;
  const arc = (a: number, b: number, grow: number) => {
    const large = b - a > Math.PI ? 1 : 0;
    const RR = R + grow;
    if (!r) return `M110,110 L${P(a, RR)} A${RR},${RR} 0 ${large} 1 ${P(b, RR)} Z`;
    return `M${P(a, RR)} A${RR},${RR} 0 ${large} 1 ${P(b, RR)} L${P(b, r)} A${r},${r} 0 ${large} 0 ${P(a, r)} Z`;
  };
  const cur = hover != null ? slices[hover] : null;
  return (
    <div className="viz-donut">
      <svg viewBox="0 0 220 220" role="img" aria-label="Part of the whole">
        {slices.map((x, i) => {
          const frac = x.v / total;
          const a1 = a0 + frac * Math.PI * 2 - (frac >= 0.9999 ? 0.0001 : 0);
          const p = arc(a0, a1, hover === i ? 4 : 0);
          a0 = a1;
          return <path key={x.c} d={p} fill={PALETTE[i]} className="viz-slice" onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)} onClick={() => onSelect?.(data.categories.indexOf(x.c))} style={{ cursor: onSelect ? 'pointer' : undefined }} />;
        })}
        {!pie && (
          <>
            <text x="110" y="106" textAnchor="middle" className="viz-donut-total">
              {fmt(cur ? cur.v : total)}
            </text>
            <text x="110" y="126" textAnchor="middle" className="viz-tick">
              {cur ? `${trunc(cur.c, 18)} · ${Math.round((cur.v / total) * 100)}%` : 'total'}
            </text>
          </>
        )}
      </svg>
      <ul className="viz-donut-legend">
        {slices.map((x, i) => (
          <li key={x.c} className={hover === i ? 'on' : ''} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
            <i style={{ background: PALETTE[i] }} />
            <span title={x.c}>{x.c}</span>
            <b>{fmt(x.v)}</b>
            <em>{Math.round((x.v / total) * 100)}%</em>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ───────────── funnel ───────────── */

function Funnel({ data, fmt }: { data: ChartData; fmt: Fmt }) {
  const s = data.series[0] ?? { label: '', values: [] };
  const max = Math.max(1, ...s.values);
  return (
    <div className="viz-funnel">
      {data.categories.map((c, i) => {
        const v = s.values[i] ?? 0;
        const prev = i > 0 ? (s.values[i - 1] ?? 0) : null;
        return (
          <div key={c + i} className="viz-funnel-row">
            <span className="viz-hbar-label">{c}</span>
            <div className="viz-funnel-track">
              <div style={{ width: `${Math.max(4, (Math.max(0, v) / max) * 100)}%`, opacity: 1 - i * (0.5 / Math.max(1, data.categories.length)) }} />
            </div>
            <b>{fmt(v)}</b>
            <span className="viz-hbar-pct">{prev ? `${Math.round((v / prev) * 100)}%` : ''}</span>
          </div>
        );
      })}
    </div>
  );
}

function TableView({ data, fmt }: { data: ChartData; fmt: Fmt }) {
  const multi = data.series.length > 1;
  return (
    <div className="table-wrap" style={{ maxHeight: 360 }}>
      <table className="data">
        <thead>
          <tr>
            <th />
            {data.series.map((s) => (
              <th key={s.label} className="num">
                {s.label || 'Value'}
              </th>
            ))}
            {multi && <th className="num">Total</th>}
          </tr>
        </thead>
        <tbody>
          {data.categories.map((c, i) => (
            <tr key={c + i}>
              <td>{c}</td>
              {data.series.map((s) => (
                <td key={s.label} className="num">
                  {Number.isFinite(s.values[i]) ? fmt(s.values[i]!) : '—'}
                </td>
              ))}
              {multi && <td className="num">{fmt(data.series.reduce((t, s) => t + (Number.isFinite(s.values[i]) ? s.values[i]! : 0), 0))}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ───────────── the chart with its switcher ───────────── */

const KIND_LABEL: Record<ChartKind, string> = { bar: 'Bars', stacked: 'Stacked', hbar: 'Horizontal', line: 'Line', area: 'Area', donut: 'Donut', pie: 'Pie', funnel: 'Funnel', table: 'Table' };
const ICON: Record<ChartKind, string> = {
  bar: 'M5 20V10M10 20V4M15 20v-7M20 20v-4',
  stacked: 'M6 20v-6h4v6M6 14V9h4v5M14 20v-9h4v9M14 11V5h4v6',
  hbar: 'M4 5h12M4 10h16M4 15h8M4 20h14',
  line: 'M3 17l5-6 4 3 8-9',
  area: 'M3 19V14l5-5 4 3 8-8v15z',
  donut: 'M12 3a9 9 0 1 0 9 9h-5a4 4 0 1 1-4-4z',
  pie: 'M12 3v9h9a9 9 0 1 1-9-9z',
  funnel: 'M3 5h18l-7 8v6l-4 2v-8z',
  table: 'M3 5h18v14H3zM3 10h18M3 15h18M9 5v14',
};

/** The icon switcher on its own, for charts that add a view of their own (e.g. bars with a line). */
export function KindSwitch<K extends string>({ options, value, onChange }: { options: { key: K; label: string; icon: string }[]; value: K; onChange: (k: K) => void }) {
  return (
    <div className="viz-switch" role="radiogroup" aria-label="Show as" style={{ margin: 0 }}>
      {options.map((o) => (
        <button key={o.key} type="button" role="radio" aria-checked={value === o.key} title={o.label} onClick={() => onChange(o.key)}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d={o.icon} />
          </svg>
        </button>
      ))}
    </div>
  );
}
export const KIND_OPTIONS = (kinds: ChartKind[]) => kinds.map((k) => ({ key: k, label: KIND_LABEL[k], icon: ICON[k] }));
export const COMBO_ICON = 'M5 20v-6M10 20v-9M15 20v-5M20 20V9M3 12l6-5 5 3 7-6';

/** Which views suit this data. */
export function kindsFor(data: ChartData, initial: ChartKind): ChartKind[] {
  const multi = data.series.length > 1;
  const hasNeg = data.series.some((s) => s.values.some((v) => v < 0));
  const k: ChartKind[] = multi ? ['bar', 'stacked', 'hbar', 'line', 'area'] : ['bar', 'hbar', 'line', 'area'];
  if (!multi && !hasNeg && data.categories.length >= 2 && data.categories.length <= 24) k.push('donut', 'pie');
  if (initial === 'funnel') k.push('funnel');
  k.push('table');
  return k;
}

export function Chart({ data, fmt = defaultFmt, height = 260, initial = 'bar', id, onSelect, switcher = true }: { data: ChartData; fmt?: Fmt; height?: number; initial?: ChartKind; id?: string; onSelect?: (i: number) => void; switcher?: boolean }) {
  const kinds = useMemo(() => kindsFor(data, initial), [data, initial]);
  const key = id ? `synapse.chart.${id}` : null;
  const [kind, setKind] = useState<ChartKind>(() => {
    try {
      const k = key ? (localStorage.getItem(key) as ChartKind | null) : null;
      if (k && kinds.includes(k)) return k;
    } catch {
      /* ignore */
    }
    return kinds.includes(initial) ? initial : kinds[0]!;
  });
  const k = kinds.includes(kind) ? kind : kinds[0]!;
  const choose = (x: ChartKind) => {
    setKind(x);
    try {
      if (key) localStorage.setItem(key, x);
    } catch {
      /* ignore */
    }
  };
  return (
    <figure className="viz" aria-label={`Chart: ${data.series.map((s) => s.label).join(', ')}`}>
      {switcher && kinds.length > 1 && (
        <div className="viz-switch" role="radiogroup" aria-label="Show as">
          {kinds.map((x) => (
            <button key={x} type="button" role="radio" aria-checked={k === x} title={KIND_LABEL[x]} onClick={() => choose(x)}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d={ICON[x]} />
              </svg>
            </button>
          ))}
        </div>
      )}
      {!data.categories.length || !data.series.some((x) => x.values.some((v) => Number.isFinite(v) && v !== 0)) ? (
        <p className="muted small" style={{ margin: '12px 0' }}>
          No figures in this period yet.
        </p>
      ) : k === 'bar' || k === 'stacked' || k === 'line' || k === 'area' ? (
        <XY data={data} fmt={fmt} height={height} kind={k} onSelect={onSelect} />
      ) : k === 'hbar' ? (
        <HBars data={data} fmt={fmt} onSelect={onSelect} />
      ) : k === 'donut' || k === 'pie' ? (
        <Donut data={data} fmt={fmt} pie={k === 'pie'} onSelect={onSelect} />
      ) : k === 'funnel' ? (
        <Funnel data={data} fmt={fmt} />
      ) : (
        <TableView data={data} fmt={fmt} />
      )}
      {k !== 'table' && <SrTable data={data} fmt={fmt} />}
    </figure>
  );
}

/* the original names, now each a Chart opening in its own form */
type P = { data: ChartData; fmt?: Fmt; height?: number; onSelect?: (category: number) => void; id?: string };
export const BarChart = ({ stacked = true, ...p }: P & { stacked?: boolean }) => <Chart {...p} initial={stacked && p.data.series.length > 1 ? 'stacked' : 'bar'} />;
export const HBarChart = (p: P) => <Chart {...p} initial="hbar" />;
export const LineChart = (p: P) => <Chart {...p} initial="line" />;
export const AreaChart = (p: P) => <Chart {...p} initial="area" />;
export const DonutChart = (p: P) => <Chart {...p} initial="donut" />;
export const PieChart = (p: P) => <Chart {...p} initial="pie" />;
export const FunnelChart = (p: P) => <Chart {...p} initial="funnel" />;

export function NumberTile({ value, label, fmt = defaultFmt }: { value: number; label: string; fmt?: Fmt }) {
  return (
    <figure className="chart number-tile" aria-label={`${label}: ${fmt(value)}`}>
      <b>{fmt(value)}</b>
      <span>{label}</span>
    </figure>
  );
}
