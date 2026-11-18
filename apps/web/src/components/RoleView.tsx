import { Chart } from './charts';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { get } from '../lib/api';
import { date, money, moneyShort, number } from '../lib/format';
import { Spinner } from './ui';

type Format = 'money' | 'number' | 'percent' | 'hours' | 'date' | 'text';
interface Tile {
  key: string;
  label: string;
  value: number;
  format: Format;
  tone?: 'good' | 'bad' | 'warn';
  link?: string;
  hint?: string;
}
interface Home {
  personas: string[];
  data: {
    persona: string;
    tiles: Tile[];
    series?: { label: string; a: string; b: string; points: { period: string; a: number; b: number }[] };
    lists: { key: string; title: string; link?: string; columns: { key: string; label: string; format?: Format }[]; rows: Record<string, unknown>[] }[];
  } | null;
}

const LABEL: Record<string, string> = { owner: 'Business', sales: 'Sales', operations: 'Operations', inventory: 'Inventory', service: 'Service' };
const KEY = 'synapse.home.persona';

function fmt(v: unknown, f: Format = 'text') {
  if (v === null || v === undefined || v === '') return '—';
  switch (f) {
    case 'money':
      return money(v);
    case 'number':
      return number(v);
    case 'percent':
      return `${number(v)}%`;
    case 'hours':
      return `${number(v)} h`;
    case 'date':
      return date(v);
    default:
      return String(v).replace(/_/g, ' ');
  }
}

/** Two series by month (e.g. booked vs collected), in any chart form. */
function Bars({ s }: { s: NonNullable<NonNullable<Home['data']>['series']> }) {
  const data = {
    categories: s.points.map((p) => new Date(`${p.period}-01T00:00:00`).toLocaleDateString('en-IN', { month: 'short', year: '2-digit' })),
    series: [
      { label: s.a, values: s.points.map((p) => Number(p.a) || 0) },
      { label: s.b, values: s.points.map((p) => Number(p.b) || 0) },
    ],
  };
  return <Chart data={data} fmt={(n) => moneyShort(n)} initial="bar" id={`role-${s.label}`} height={240} />;
}

/** Role dashboards: the figures an owner, sales head, ops, stores or service lead checks each morning. */
export function RoleView() {
  const [persona, setPersona] = useState<string | null>(() => {
    try {
      return localStorage.getItem(KEY);
    } catch {
      return null;
    }
  });
  const { data, isLoading } = useQuery({
    queryKey: ['home', persona],
    queryFn: () => get<Home>(`/api/v1/insights/home${persona ? `?persona=${persona}` : ''}`),
    staleTime: 60_000,
  });
  const pick = (p: string) => {
    setPersona(p);
    try {
      localStorage.setItem(KEY, p);
    } catch {
      /* ignore */
    }
  };
  if (isLoading && !data) return <Spinner />;
  if (!data?.data || !data.data.tiles.length) return null;
  const d = data.data;
  return (
    <section className="role-view" aria-label="Role dashboard">
      {data.personas.length > 1 && (
        <div className="seg" role="group" aria-label="View as">
          {data.personas.map((p) => (
            <button key={p} aria-pressed={d.persona === p} onClick={() => pick(p)}>
              {LABEL[p] ?? p}
            </button>
          ))}
        </div>
      )}
      <div className="kpis role-tiles">
        {d.tiles.map((t) => {
          const body = (
            <>
              <div className="l">{t.label}</div>
              <div className={`v${t.tone ? ` tone-${t.tone}` : ''}`}>{t.format === 'money' ? moneyShort(t.value) : fmt(t.value, t.format)}</div>
              {t.hint && <div className="muted small">{t.hint}</div>}
            </>
          );
          return t.link ? (
            <Link key={t.key} to={t.link} className="panel kpi role-tile">
              {body}
            </Link>
          ) : (
            <div key={t.key} className="panel kpi role-tile">
              {body}
            </div>
          );
        })}
      </div>
      {(d.series || d.lists.length > 0) && (
        <div className="two-col">
          {d.series && (
            <section className="panel">
              <div className="panel-head">
                <h2>{d.series.label}</h2>
              </div>
              <div className="panel-body">
                <Bars s={d.series} />
              </div>
            </section>
          )}
          {d.lists.map((l) => (
            <section key={l.key} className="panel">
              <div className="panel-head">
                <h2>{l.title}</h2>
                {l.link && (
                  <Link to={l.link} className="small">
                    Open
                  </Link>
                )}
              </div>
              {l.rows.length ? (
                <div className="table-wrap">
                  <table className="data">
                    <thead>
                      <tr>
                        {l.columns.map((c) => (
                          <th key={c.key} className={c.format && ['money', 'number'].includes(c.format) ? 'num' : undefined}>
                            {c.label}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {l.rows.map((r, i) => (
                        <tr key={String(r.id ?? i)}>
                          {l.columns.map((c) => (
                            <td key={c.key} className={c.format && ['money', 'number'].includes(c.format) ? 'num' : undefined}>
                              {fmt(r[c.key], c.format)}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="muted small" style={{ padding: '12px 16px' }}>
                  Nothing here — all clear.
                </p>
              )}
            </section>
          ))}
        </div>
      )}
    </section>
  );
}
