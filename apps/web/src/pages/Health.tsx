/**
 * Business health: the KPIs an owner runs the business on, against targets, with the previous
 * period and a six-month trend. Every number covers only what the viewer can see.
 */
import { KPI_AREAS, KPI_BY_KEY, type KpiArea, type KpiFormat } from '@synapse/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Modal, Spinner, useToast } from '../components/ui';
import { get, put } from '../lib/api';
import { useAuth } from '../lib/auth';
import { money, moneyShort, number } from '../lib/format';

type Json = Record<string, any>;

const PERIOD_LABELS: [string, string][] = [
  ['this_month', 'This month'],
  ['last_month', 'Last month'],
  ['this_quarter', 'This quarter'],
  ['last_90', 'Last 90 days'],
  ['this_fy', 'This financial year'],
];

export function fmtKpi(v: number | null | undefined, f: KpiFormat): string {
  if (v === null || v === undefined) return '—';
  switch (f) {
    case 'money':
      return moneyShort(v);
    case 'money_per_day':
      return `${moneyShort(v)}/day`;
    case 'percent':
      return `${v}%`;
    case 'minutes':
      return v >= 120 ? `${Math.round(v / 6) / 10} h` : `${v} min`;
    case 'hours':
      return v >= 48 ? `${Math.round(v / 2.4) / 10} days` : `${v} h`;
    case 'days':
      return `${v} days`;
    default:
      return number(v);
  }
}

function Spark({ points, better }: { points: (number | null)[]; better: 'higher' | 'lower' }) {
  const vals = points.map((p) => (p === null ? null : Number(p)));
  const real = vals.filter((v): v is number => v !== null);
  if (real.length < 2) return <span className="spark-empty" />;
  const min = Math.min(...real);
  const max = Math.max(...real);
  const w = 96;
  const h = 26;
  const x = (i: number) => (i / (vals.length - 1)) * (w - 4) + 2;
  const y = (v: number) => (max === min ? h / 2 : h - 3 - ((v - min) / (max - min)) * (h - 6));
  const d = vals.map((v, i) => (v === null ? null : `${x(i)},${y(v)}`)).filter(Boolean).join(' ');
  const last = real[real.length - 1]!;
  const first = real[0]!;
  const up = last > first;
  const good = last === first ? null : better === 'higher' ? up : !up;
  return (
    <svg className={`spark ${good === null ? '' : good ? 'up' : 'down'}`} width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden="true">
      <polyline points={d} fill="none" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function Delta({ value, previous, better, format }: { value: number | null; previous: number | null; better: 'higher' | 'lower'; format: KpiFormat }) {
  if (value === null || previous === null) return null;
  const diff = value - previous;
  if (Math.abs(diff) < 1e-9) return <span className="delta">no change</span>;
  const good = better === 'higher' ? diff > 0 : diff < 0;
  const shown = format === 'percent' ? `${diff > 0 ? '+' : ''}${Math.round(diff * 10) / 10} pts` : previous ? `${diff > 0 ? '+' : ''}${Math.round((diff / Math.abs(previous)) * 100)}%` : diff > 0 ? 'new' : '';
  return (
    <span className={`delta ${good ? 'good' : 'bad'}`} title={`Previous period: ${fmtKpi(previous, format)}`}>
      {diff > 0 ? '▲' : '▼'} {shown}
    </span>
  );
}

export function HealthPage() {
  const { can } = useAuth();
  const [period, setPeriod] = useState('this_month');
  const [editing, setEditing] = useState(false);
  const q = useQuery({ queryKey: ['kpis', period], queryFn: () => get<Json>(`/api/v1/kpis?period=${period}`) });
  const keys = (q.data?.items as Json[] | undefined)?.map((i) => i.key).join(',') ?? '';
  const trend = useQuery({ queryKey: ['kpi-trend', keys], queryFn: () => get<Json>(`/api/v1/kpis/trend?keys=${keys}`), enabled: !!keys, staleTime: 300_000 });
  const items = (q.data?.items ?? []) as Json[];
  const byArea = new Map<KpiArea, Json[]>();
  for (const i of items) {
    const d = KPI_BY_KEY[i.key];
    if (!d) continue;
    byArea.set(d.area, [...(byArea.get(d.area) ?? []), i]);
  }
  const judged = items.filter((i) => i.status);
  const good = judged.filter((i) => i.status === 'good').length;
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Business health</h1>
          <p>The numbers that decide growth, against your targets. {q.data && <span className="muted">{q.data.period.label}</span>}</p>
        </div>
        <div className="row">
          <select value={period} onChange={(e) => setPeriod(e.target.value)} aria-label="Period" style={{ width: 'auto' }}>
            {PERIOD_LABELS.map(([k, l]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </select>
          {can('modules') && (
            <button className="btn" onClick={() => setEditing(true)}>
              Targets
            </button>
          )}
        </div>
      </div>
      {!q.data ? (
        <Spinner />
      ) : (
        <>
          {judged.length > 0 && (
            <div className="health-summary panel">
              <div>
                <b>{good}</b> of {judged.length} KPIs on target
              </div>
              <div className="health-bar" aria-hidden="true">
                {judged.map((i) => (
                  <span key={i.key} className={i.status} title={KPI_BY_KEY[i.key]?.label} />
                ))}
              </div>
              <div className="small muted">
                {judged
                  .filter((i) => i.status === 'bad')
                  .slice(0, 3)
                  .map((i) => KPI_BY_KEY[i.key]?.label)
                  .join(' · ') || 'Everything with a target is on track.'}
              </div>
            </div>
          )}
          {q.data.value?.length > 0 && (
            <section className="value-strip">
              <h2>What Synapse did for you</h2>
              <div className="value-grid">
                {(q.data.value as Json[]).map((v) => (
                  <div key={v.key} className="value-item">
                    <b>{v.format === 'money' ? money(v.value) : number(v.value)}</b>
                    <span>{v.label}</span>
                  </div>
                ))}
              </div>
            </section>
          )}
          {[...byArea.entries()].map(([area, list]) => (
            <section key={area} className="kpi-area">
              <h2>{KPI_AREAS[area]}</h2>
              <div className="kpi-grid">
                {list.map((i) => {
                  const d = KPI_BY_KEY[i.key]!;
                  return (
                    <div key={i.key} className={`panel kpi-card ${i.status ?? ''}`}>
                      <div className="spread">
                        <span className="l">{d.label}</span>
                        {i.status && <span className={`dot-status ${i.status}`} title={i.status === 'good' ? 'On target' : i.status === 'warn' ? 'Close to target' : 'Off target'} />}
                      </div>
                      <div className="v">{fmtKpi(i.value, d.format)}</div>
                      <div className="spread small">
                        <span className="muted">{i.target !== null ? `Target ${d.better === 'lower' ? '≤' : '≥'} ${fmtKpi(i.target, d.format)}` : 'No target'}</span>
                        <Delta value={i.value} previous={i.previous} better={d.better} format={d.format} />
                      </div>
                      <div className="spread">
                        <span className="how small muted">{d.how}</span>
                        <Spark points={trend.data?.series?.[i.key] ?? []} better={d.better} />
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          ))}
        </>
      )}
      {editing && q.data && <TargetsModal items={items} onClose={() => setEditing(false)} />}
    </>
  );
}

function TargetsModal({ items, onClose }: { items: Json[]; onClose: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [t, setT] = useState<Record<string, string>>(Object.fromEntries(items.map((i) => [i.key, i.target === null ? '' : String(i.target)])));
  const save = async () => {
    try {
      await put('/api/admin/kpis/targets', { targets: Object.fromEntries(Object.entries(t).map(([k, v]) => [k, v.trim() === '' ? null : Number(v)])) });
      toast('Targets saved');
      qc.invalidateQueries({ queryKey: ['kpis'] });
      onClose();
    } catch (e) {
      toast((e as Error).message, true);
    }
  };
  return (
    <Modal
      wide
      title="KPI targets"
      onClose={onClose}
      footer={
        <button className="btn primary" onClick={save}>
          Save targets
        </button>
      }
    >
      <div className="modal-body">
        <table className="data">
          <tbody>
            {items.map((i) => {
              const d = KPI_BY_KEY[i.key]!;
              return (
                <tr key={i.key}>
                  <td>
                    <b>{d.label}</b>
                    <div className="muted small">{d.how}</div>
                  </td>
                  <td className="row" style={{ whiteSpace: 'nowrap' }}>
                    {d.better === 'lower' ? 'at most' : 'at least'}
                    <input type="number" min={0} step="any" style={{ width: 110 }} value={t[i.key] ?? ''} onChange={(e) => setT({ ...t, [i.key]: e.target.value })} aria-label={`${d.label} target`} />
                    <span className="muted small">{{ percent: '%', minutes: 'min', hours: 'h', days: 'days', money: '₹', money_per_day: '₹/day', number: '' }[d.format]}</span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Modal>
  );
}
