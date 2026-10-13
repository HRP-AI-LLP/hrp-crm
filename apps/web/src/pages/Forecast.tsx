import { objectPerm } from '@synapse/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Empty, Modal, Spinner, useToast } from '../components/ui';
import { get, put } from '../lib/api';
import { useAuth } from '../lib/auth';
import { date, money, moneyShort } from '../lib/format';
import { useUsers } from '../lib/hooks';

type Cat = 'closed' | 'commit' | 'best_case' | 'pipeline';
interface Rep {
  userId: string | null;
  name: string;
  quota: number;
  closed: number;
  commit: number;
  best_case: number;
  pipeline: number;
  lost: number;
  weighted: number;
  deals: number;
}
interface ForecastResponse {
  period: 'month' | 'quarter';
  from: string;
  to: string;
  months: string[];
  reps: Rep[];
  total: Omit<Rep, 'userId' | 'name'>;
}

const CATS: [Cat, string, string][] = [
  ['closed', 'Closed won', '#059669'],
  ['commit', 'Commit', '#075492'],
  ['best_case', 'Best case', '#0f8dde'],
  ['pipeline', 'Pipeline', '#94a3b8'],
];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function shift(start: string, period: 'month' | 'quarter', d: number) {
  const [y, m] = start.split('-').map(Number) as [number, number];
  const step = period === 'quarter' ? 3 : 1;
  const base = period === 'quarter' ? Math.floor((m - 1) / 3) * 3 : m - 1;
  return new Date(Date.UTC(y, base + d * step, 1)).toISOString().slice(0, 10);
}
function periodName(from: string, period: 'month' | 'quarter') {
  const [y, m] = from.split('-').map(Number) as [number, number];
  if (period === 'month') return `${MONTHS[m - 1]} ${y}`;
  // Indian financial year: Q1 = Apr–Jun
  const fq = Math.floor(((m - 4 + 12) % 12) / 3) + 1;
  const fy = m >= 4 ? y : y - 1;
  return `${MONTHS[m - 1]}–${MONTHS[(m + 1) % 12]} ${y} · FY${String(fy + 1).slice(2)} Q${fq}`;
}

export function ForecastPage() {
  const { me, can } = useAuth();
  const [period, setPeriod] = useState<'month' | 'quarter'>('quarter');
  const [start, setStart] = useState(() => new Date().toISOString().slice(0, 8) + '01');
  const [drill, setDrill] = useState<{ cat: Cat; rep: Rep | null } | null>(null);
  const [quotas, setQuotas] = useState(false);
  const { data, isLoading, error } = useQuery({ queryKey: ['forecast', period, start], queryFn: () => get<ForecastResponse>(`/api/v1/forecast?period=${period}&start=${start}`) });
  const canSetQuotas = !!me && (can('users') || objectPerm(me.permissions, 'deal').update === 'all');
  const max = Math.max(1, ...(data?.reps ?? []).map((r) => Math.max(r.quota, r.closed + r.commit + r.best_case + r.pipeline)));

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Forecast</h1>
          <p>Deals closing in the period, by how confident the team is.</p>
        </div>
        <div className="row">
          <div className="seg" role="group" aria-label="Period">
            {(['month', 'quarter'] as const).map((p) => (
              <button key={p} aria-pressed={period === p} onClick={() => setPeriod(p)}>
                {p === 'month' ? 'Month' : 'Quarter'}
              </button>
            ))}
          </div>
          <button className="btn" aria-label="Previous period" onClick={() => setStart(shift(start, period, -1))}>
            ←
          </button>
          <b style={{ minWidth: 150, textAlign: 'center' }}>{data ? periodName(data.from, period) : ''}</b>
          <button className="btn" aria-label="Next period" onClick={() => setStart(shift(start, period, 1))}>
            →
          </button>
          {canSetQuotas && (
            <button className="btn" onClick={() => setQuotas(true)}>
              Set quotas
            </button>
          )}
        </div>
      </div>
      {isLoading ? (
        <Spinner />
      ) : error ? (
        <Empty title="Forecast unavailable">{(error as Error).message}</Empty>
      ) : data ? (
        <>
          <div className="kpis">
            {[
              ['Quota', data.total.quota, null],
              ['Closed won', data.total.closed, 'closed'],
              ['Commit', data.total.commit, 'commit'],
              ['Best case', data.total.best_case, 'best_case'],
              ['Weighted forecast', data.total.weighted, null],
            ].map(([l, v, cat]) => (
              <button key={l as string} className="kpi" disabled={!cat} onClick={() => cat && setDrill({ cat: cat as Cat, rep: null })}>
                <span>{l as string}</span>
                <b>{moneyShort(v as number)}</b>
                {l === 'Closed won' && data.total.quota > 0 && <small>{Math.round(((v as number) / data.total.quota) * 100)}% of quota</small>}
                {l === 'Weighted forecast' && data.total.quota > 0 && <small>{Math.round(((v as number) / data.total.quota) * 100)}% of quota</small>}
              </button>
            ))}
          </div>
          <section className="panel">
            <div className="panel-head">
              <h2>By owner</h2>
              <span className="legend-inline">
                {CATS.map(([k, l, c]) => (
                  <span key={k}>
                    <i style={{ background: c }} />
                    {l}
                  </span>
                ))}
                <span>
                  <i className="quota-tick" />
                  Quota
                </span>
              </span>
            </div>
            {!data.reps.length ? (
              <Empty title="No deals close in this period">Set close dates on deals to see them here.</Empty>
            ) : (
              <div className="table-wrap">
                <table className="data forecast">
                  <thead>
                    <tr>
                      <th>Owner</th>
                      <th style={{ width: '32%' }}>Progress</th>
                      <th className="num">Quota</th>
                      {CATS.map(([k, l]) => (
                        <th key={k} className="num">
                          {l}
                        </th>
                      ))}
                      <th className="num">Weighted</th>
                      <th className="num">Gap to quota</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.reps.map((r) => (
                      <tr key={r.userId ?? 'none'}>
                        <td>
                          <b>{r.name}</b>
                          <div className="muted small">{r.deals} open/won deals</div>
                        </td>
                        <td>
                          <div className="fc-bar" role="img" aria-label={`${r.name}: closed ${money(r.closed)}, commit ${money(r.commit)}, quota ${money(r.quota)}`}>
                            {CATS.map(([k, , c]) => (
                              <span key={k} style={{ width: `${(r[k] / max) * 100}%`, background: c }} />
                            ))}
                            {r.quota > 0 && <i style={{ left: `${(r.quota / max) * 100}%` }} />}
                          </div>
                        </td>
                        <td className="num">{r.quota ? moneyShort(r.quota) : <span className="muted">—</span>}</td>
                        {CATS.map(([k]) => (
                          <td key={k} className="num">
                            {r[k] ? (
                              <button className="link" onClick={() => setDrill({ cat: k, rep: r })}>
                                {moneyShort(r[k])}
                              </button>
                            ) : (
                              <span className="muted">—</span>
                            )}
                          </td>
                        ))}
                        <td className="num">{moneyShort(r.weighted)}</td>
                        <td className="num">{r.quota ? <span className={r.closed >= r.quota ? 'good' : ''}>{r.closed >= r.quota ? 'Achieved' : moneyShort(r.quota - r.closed)}</span> : <span className="muted">—</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
          <p className="muted small">
            Deals count as <b>commit</b> at 70%+ probability and <b>best case</b> at 40%+, unless a deal’s “Forecast category” says otherwise. Lost deals are excluded.
          </p>
        </>
      ) : null}
      {drill && data && <DrillModal period={period} start={data.from} cat={drill.cat} rep={drill.rep} onClose={() => setDrill(null)} />}
      {quotas && data && <QuotaModal months={data.months} onClose={() => setQuotas(false)} />}
    </>
  );
}

function DrillModal({ period, start, cat, rep, onClose }: { period: string; start: string; cat: Cat; rep: Rep | null; onClose: () => void }) {
  const { data } = useQuery({
    queryKey: ['forecast-deals', period, start, cat, rep?.userId],
    queryFn: () => get<{ items: { id: string; name: string; amount: number | null; close_date: string; probability: number; stage: string }[] }>(`/api/v1/forecast/deals?period=${period}&start=${start}&category=${cat}${rep?.userId ? `&owner=${rep.userId}` : ''}`),
  });
  return (
    <Modal title={`${CATS.find(([k]) => k === cat)![1]}${rep ? ` · ${rep.name}` : ''}`} wide onClose={onClose}>
      <div className="modal-body" style={{ display: 'block' }}>
        {!data ? (
          <Spinner />
        ) : (
          <table className="data">
            <thead>
              <tr>
                <th>Deal</th>
                <th>Stage</th>
                <th>Close date</th>
                <th className="num">Probability</th>
                <th className="num">Amount</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((d) => (
                <tr key={d.id}>
                  <td>
                    <Link to={`/o/deal/${d.id}`} onClick={onClose}>
                      {d.name}
                    </Link>
                  </td>
                  <td>{d.stage}</td>
                  <td>{date(d.close_date)}</td>
                  <td className="num">{d.probability}%</td>
                  <td className="num">{money(d.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </Modal>
  );
}

function QuotaModal({ months, onClose }: { months: string[]; onClose: () => void }) {
  const { data: users } = useUsers();
  const qc = useQueryClient();
  const toast = useToast();
  const to = new Date(Date.UTC(Number(months.at(-1)!.slice(0, 4)), Number(months.at(-1)!.slice(5, 7)), 1)).toISOString().slice(0, 10);
  const { data } = useQuery({ queryKey: ['quotas', months[0]], queryFn: () => get<{ items: { user_id: string; period_start: string; amount: number }[] }>(`/api/v1/quotas?from=${months[0]}&to=${to}`) });
  const [vals, setVals] = useState<Record<string, string>>({});
  const key = (u: string, m: string) => `${u}|${m}`;
  const value = (u: string, m: string) => vals[key(u, m)] ?? String(data?.items.find((q) => q.user_id === u && q.period_start === m)?.amount ?? '');
  const save = async () => {
    const quotas = Object.entries(vals).map(([k, v]) => {
      const [userId, periodStart] = k.split('|') as [string, string];
      return { userId, periodStart, amount: v.trim() === '' ? null : Number(v.replace(/[,₹\s]/g, '')) };
    });
    try {
      await put('/api/v1/quotas', { quotas });
      toast('Quotas saved');
      qc.invalidateQueries({ queryKey: ['forecast'] });
      qc.invalidateQueries({ queryKey: ['quotas'] });
      onClose();
    } catch (e) {
      toast((e as Error).message, true);
    }
  };
  return (
    <Modal title="Quotas" wide onClose={onClose} footer={<button className="btn primary" onClick={save} disabled={!Object.keys(vals).length}>Save quotas</button>}>
      <div className="modal-body" style={{ display: 'block' }}>
        <p className="muted small" style={{ marginTop: 0 }}>
          Monthly targets in ₹. Quarter forecasts add up the three months.
        </p>
        <table className="data">
          <thead>
            <tr>
              <th>Person</th>
              {months.map((m) => (
                <th key={m}>{`${MONTHS[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {users?.items.map((u) => (
              <tr key={u.id}>
                <td>{u.full_name}</td>
                {months.map((m) => (
                  <td key={m}>
                    <input inputMode="numeric" aria-label={`Quota for ${u.full_name}, ${m}`} value={value(u.id, m)} onChange={(e) => setVals((v) => ({ ...v, [key(u.id, m)]: e.target.value }))} placeholder="0" />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Modal>
  );
}
