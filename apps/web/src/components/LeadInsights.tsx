import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { get } from '../lib/api';
import { Spinner } from './ui';

type Json = Record<string, any>;
const BUCKETS = ['0-2', '3-7', '8-14', '15-30', '30+', 'never'];
const BUCKET_LABEL: Record<string, string> = { '0-2': '0–2 days', '3-7': '3–7 days', '8-14': '8–14 days', '15-30': '15–30 days', '30+': '30+ days', never: 'Never touched' };
const pretty = (s: string) => s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

function Bars({ rows }: { rows: { bucket: string; n: number }[] }) {
  const by = new Map(rows.map((r) => [r.bucket, r.n]));
  const max = Math.max(1, ...rows.map((r) => r.n));
  return (
    <div className="bucket-bars">
      {BUCKETS.filter((b) => by.has(b)).map((b) => (
        <div className="b" key={b}>
          <span className="muted">{BUCKET_LABEL[b]}</span>
          <div className="track">
            <div className="fill" style={{ width: `${((by.get(b) ?? 0) / max) * 100}%`, background: b === '30+' || b === 'never' ? 'var(--bad)' : b === '15-30' ? '#f59e0b' : undefined }} />
          </div>
          <span style={{ textAlign: 'right' }}>{by.get(b)}</span>
        </div>
      ))}
    </div>
  );
}

/** Lead aging, follow-up discipline and source / partner conversion (home dashboard). */
export function LeadInsights() {
  const aging = useQuery({ queryKey: ['insights', 'lead-aging'], queryFn: () => get<Json>('/api/v1/insights/lead-aging'), staleTime: 60_000 });
  const sources = useQuery({ queryKey: ['insights', 'lead-sources'], queryFn: () => get<Json>('/api/v1/insights/lead-sources?days=90'), staleTime: 60_000 });
  if (aging.isLoading || sources.isLoading) return <Spinner />;
  if (!aging.data || !sources.data) return null;
  const idle7 = (aging.data.byOwner as Json[]).reduce((s, o) => s + o.idle_7d, 0);
  const overdue = (aging.data.byOwner as Json[]).reduce((s, o) => s + o.overdue_follow_ups, 0);
  return (
    <div className="two-col" style={{ marginTop: 20 }}>
      <section className="panel">
        <div className="panel-head">
          <h2>Lead follow-up health</h2>
          <span className="small muted">
            {idle7} idle 7+ days · {overdue} follow-ups overdue
          </span>
        </div>
        <div className="panel-body stack">
          <div>
            <h3 style={{ marginBottom: 8 }}>Time since last contact</h3>
            <Bars rows={aging.data.byIdle} />
          </div>
          {(aging.data.byOwner as Json[]).length > 1 && (
            <table className="data">
              <thead>
                <tr>
                  <th>Owner</th>
                  <th className="num">Open</th>
                  <th className="num">Idle 7d+</th>
                  <th className="num">Overdue</th>
                  <th className="num">Avg age</th>
                </tr>
              </thead>
              <tbody>
                {(aging.data.byOwner as Json[]).map((o) => (
                  <tr key={o.owner_id ?? 'none'}>
                    <td>{o.owner_name ?? 'Unassigned'}</td>
                    <td className="num">{o.open}</td>
                    <td className="num" style={{ color: o.idle_7d ? 'var(--bad)' : undefined }}>
                      {o.idle_7d}
                    </td>
                    <td className="num">{o.overdue_follow_ups}</td>
                    <td className="num">{o.avg_age_days} d</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>
      <section className="panel">
        <div className="panel-head">
          <h2>Where leads come from</h2>
          <span className="small muted">Last 90 days</span>
        </div>
        <div className="panel-body stack">
          <table className="data">
            <thead>
              <tr>
                <th>Source</th>
                <th className="num">Leads</th>
                <th className="num">Hot</th>
                <th className="num">Converted</th>
              </tr>
            </thead>
            <tbody>
              {(sources.data.bySource as Json[]).map((s) => (
                <tr key={s.source}>
                  <td>
                    <Link to={`/o/lead?filter=${encodeURIComponent(JSON.stringify([{ field: 'source', op: 'eq', value: s.source }]))}`}>{pretty(s.source)}</Link>
                  </td>
                  <td className="num">{s.leads}</td>
                  <td className="num">{s.hot}</td>
                  <td className="num">
                    {s.converted} <span className="muted small">({s.leads ? Math.round((s.converted / s.leads) * 100) : 0}%)</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {(sources.data.byPartner as Json[]).length > 0 && (
            <>
              <h3>Top referring partners</h3>
              <table className="data">
                <tbody>
                  {(sources.data.byPartner as Json[]).map((p) => (
                    <tr key={p.id}>
                      <td>
                        <Link to={`/o/account/${p.id}`}>{p.name}</Link>
                        <div className="muted small">{pretty(p.account_type ?? 'partner')}</div>
                      </td>
                      <td className="num">{p.leads} leads</td>
                      <td className="num">{p.converted} won</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </div>
      </section>
    </div>
  );
}
