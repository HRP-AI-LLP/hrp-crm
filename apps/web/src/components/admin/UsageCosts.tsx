/**
 * Settings → Usage & costs: every outside service the platform uses (AI models, email, WhatsApp,
 * Razorpay and bank feeds, GST APIs, Google, Microsoft, Zoom, GitHub, Cloudflare, Neon…) — calls,
 * errors, tokens and other units this month, the cost so far and projected to the month's end, the
 * last months' estimates next to the bills received (from Books), and the price list behind it.
 */
import { useQuery } from '@tanstack/react-query';
import { Fragment, useState } from 'react';
import { download, get, put, del } from '../../lib/api';
import { date } from '../../lib/format';
import { Spinner, useToast } from '../ui';

type Json = Record<string, any>;

const inr = (v: number) => `₹${Math.round(v).toLocaleString('en-IN')}`;
const num = (v: number) => (v >= 1e9 ? `${(v / 1e9).toFixed(1)}B` : v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : v >= 1e4 ? `${(v / 1e3).toFixed(1)}k` : Math.round(v).toLocaleString('en-IN'));
const bytes = (v: number) => (v >= 1024 ** 3 ? `${(v / 1024 ** 3).toFixed(2)} GB` : `${(v / 1024 ** 2).toFixed(1)} MB`);
const monthName = (m: string) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString('en-IN', { month: 'short', year: '2-digit', timeZone: 'UTC' });
const UNIT_LABEL: Record<string, string> = {
  input_tokens: 'input tokens',
  output_tokens: 'output tokens',
  whatsapp_template: 'template msgs',
  whatsapp_message: 'replies',
  email: 'emails',
  request: 'requests',
  query: 'queries',
  job: 'jobs',
  cron: 'cron runs',
  bank_feed: 'bank feed calls',
  payment_link: 'payment link calls',
  gmail: 'Gmail calls',
  push: 'push',
  call: 'calls',
};
function usageText(units: Record<string, number>) {
  return Object.entries(units)
    .filter(([, v]) => v)
    .map(([k, v]) => (k.endsWith('_bytes') ? `${bytes(v)} ${k === 'db_bytes' ? 'database' : 'stored'}` : `${num(v)} ${UNIT_LABEL[k] ?? k.replace(/_/g, ' ')}`))
    .join(' · ');
}

/** Estimate vs billed per month: two series, side by side, one axis. */
function MonthBars({ rows }: { rows: Json[] }) {
  const data = [...rows].reverse();
  const max = Math.max(1, ...data.flatMap((r) => [r.estimate, r.billed]));
  const W = 640;
  const H = 180;
  const pad = 28;
  const bw = Math.min(26, (W - pad) / data.length / 2 - 6);
  return (
    <figure className="usage-chart" style={{ margin: 0 }}>
      <div className="row small" style={{ gap: 14 }} aria-hidden>
        <span className="row" style={{ gap: 6 }}>
          <i className="usage-key est" /> Estimated from usage
        </span>
        <span className="row" style={{ gap: 6 }}>
          <i className="usage-key bill" /> Bills received
        </span>
      </div>
      <svg viewBox={`0 0 ${W} ${H + 24}`} width="100%" role="img" aria-label="Estimated cost and bills per month">
        {[0.5, 1].map((f) => (
          <g key={f}>
            <line x1={pad} x2={W} y1={H - H * f + 4} y2={H - H * f + 4} className="usage-grid" />
            <text x={0} y={H - H * f + 8} className="usage-axis">
              {num(max * f)}
            </text>
          </g>
        ))}
        <line x1={pad} x2={W} y1={H + 4} y2={H + 4} className="usage-base" />
        {data.map((r, i) => {
          const x = pad + ((W - pad) / data.length) * i + 8;
          const he = (r.estimate / max) * (H - 8);
          const hb = (r.billed / max) * (H - 8);
          return (
            <g key={r.month}>
              <rect x={x} y={H + 4 - he} width={bw} height={Math.max(0, he)} rx={3} className="usage-bar est">
                <title>{`${monthName(r.month)}: estimated ${inr(r.estimate)}`}</title>
              </rect>
              <rect x={x + bw + 2} y={H + 4 - hb} width={bw} height={Math.max(0, hb)} rx={3} className="usage-bar bill">
                <title>{`${monthName(r.month)}: billed ${inr(r.billed)}`}</title>
              </rect>
              <text x={x + bw} y={H + 20} textAnchor="middle" className="usage-axis">
                {monthName(r.month)}
              </text>
            </g>
          );
        })}
      </svg>
    </figure>
  );
}

function Tile({ l, v, sub }: { l: string; v: string; sub?: string }) {
  return (
    <div className="panel" style={{ padding: 12 }}>
      <div className="small muted">{l}</div>
      <div style={{ fontSize: 24, fontWeight: 700 }}>{v}</div>
      {sub && <div className="small muted">{sub}</div>}
    </div>
  );
}

function PriceList({ prices, onSaved }: { prices: Json; onSaved: () => void }) {
  const [p, setP] = useState<Json>(() => JSON.parse(JSON.stringify(prices)));
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const set = (path: (string | number)[], v: unknown) => {
    const n = JSON.parse(JSON.stringify(p));
    let o = n;
    for (const k of path.slice(0, -1)) o = o[k];
    o[path[path.length - 1]!] = v;
    setP(n);
  };
  const save = async (reset = false) => {
    setBusy(true);
    try {
      if (reset) await del('/api/admin/costs/prices');
      else await put('/api/admin/costs/prices', p);
      toast(reset ? 'Back to the default prices' : 'Price list saved');
      onSaved();
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <details className="panel" style={{ padding: 12 }}>
      <summary>
        <b>Price list</b> <span className="small muted">— plan fees and unit prices behind the estimates. Set your plans (e.g. Neon Launch $19, GitHub Team) and the rates on your invoices.</span>
      </summary>
      <label className="field" style={{ maxWidth: 220, marginTop: 10 }}>
        ₹ per US$
        <input inputMode="decimal" value={p.usdInr} onChange={(e) => set(['usdInr'], Number(e.target.value) || 0)} />
      </label>
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>Service</th>
              <th>Currency</th>
              <th className="num">Plan / month</th>
              <th>Unit prices (price per N units, free units a month)</th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(p.services as Record<string, Json>).map(([k, s]) => (
              <tr key={k}>
                <td>
                  {s.label}
                  <div className="small muted">{s.group}</div>
                </td>
                <td>
                  <select value={s.currency} onChange={(e) => set(['services', k, 'currency'], e.target.value)} style={{ width: 'auto' }}>
                    <option>USD</option>
                    <option>INR</option>
                  </select>
                </td>
                <td style={{ width: 110 }}>
                  <input inputMode="decimal" value={s.monthly} onChange={(e) => set(['services', k, 'monthly'], Number(e.target.value) || 0)} aria-label="Monthly plan" />
                </td>
                <td>
                  {Object.entries(s.units as Record<string, Json>).map(([u, x]) => (
                    <div key={u} className="row small" style={{ gap: 4, marginBottom: 4, flexWrap: 'wrap' }}>
                      <span style={{ minWidth: 120 }}>{x.label}</span>
                      <input inputMode="decimal" value={x.price} onChange={(e) => set(['services', k, 'units', u, 'price'], Number(e.target.value) || 0)} style={{ width: 80 }} aria-label={`${x.label} price`} />
                      <span className="muted">per</span>
                      <input inputMode="decimal" value={x.per} onChange={(e) => set(['services', k, 'units', u, 'per'], Number(e.target.value) || 1)} style={{ width: 100 }} aria-label={`${x.label} per`} />
                      <span className="muted">free</span>
                      <input inputMode="decimal" value={x.free ?? 0} onChange={(e) => set(['services', k, 'units', u, 'free'], Number(e.target.value) || 0)} style={{ width: 100 }} aria-label={`${x.label} free`} />
                    </div>
                  ))}
                  {!Object.keys(s.units).length && <span className="small muted">Calls are counted; billed by plan only</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="row">
        <button className="btn primary" disabled={busy} onClick={() => save()}>
          Save prices
        </button>
        <button className="btn ghost" disabled={busy} onClick={() => save(true)}>
          Reset to defaults
        </button>
      </div>
    </details>
  );
}

export function UsageCostsTab() {
  const [scope, setScope] = useState<'workspace' | 'platform'>('workspace');
  const [months, setMonths] = useState(6);
  const toast = useToast();
  const { data, refetch, error } = useQuery({ queryKey: ['usage-costs', scope, months], queryFn: () => get<Json>(`/api/admin/costs?scope=${scope}&months=${months}`), retry: false });
  if (error) return <p className="notice">{(error as Error).message}</p>;
  if (!data) return <Spinner />;
  const t = data.totals;
  const groups = new Map<string, Json[]>();
  for (const s of data.services as Json[]) groups.set(s.group, [...(groups.get(s.group) ?? []), s]);
  const prev = (data.months as string[])[1];
  return (
    <div className="stack">
      <div className="spread" style={{ flexWrap: 'wrap', gap: 8 }}>
        <p className="muted small" style={{ margin: 0, maxWidth: 720 }}>
          Every call to an outside service, every request and database query, AI tokens and stored files — counted as they happen. Costs are estimates from the price list; bills are the suppliers' invoices recorded in Books (receipts read from your mail).
        </p>
        <div className="row" style={{ gap: 6 }}>
          {data.platformAdmin && (
            <select value={scope} onChange={(e) => setScope(e.target.value as 'workspace' | 'platform')} aria-label="Scope" style={{ width: 'auto' }}>
              <option value="workspace">This workspace</option>
              <option value="platform">Whole platform</option>
            </select>
          )}
          <select value={months} onChange={(e) => setMonths(Number(e.target.value))} aria-label="Months" style={{ width: 'auto' }}>
            {[3, 6, 12, 24].map((m) => (
              <option key={m} value={m}>
                Last {m} months
              </option>
            ))}
          </select>
          <button
            className="btn sm"
            onClick={() => download(`/api/admin/costs/export.csv?scope=${scope}&months=${months}`, `usage-${scope}.csv`).catch((e) => toast((e as Error).message, true))}
          >
            Export CSV
          </button>
        </div>
      </div>

      <div className="grid-tiles" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
        <Tile l={`This month so far (day ${data.dayOfMonth} of ${data.daysInMonth})`} v={inr(t.thisMonth)} sub="estimated" />
        <Tile l="Projected for the month" v={inr(t.projected)} sub="plan fees + usage at this pace" />
        <Tile l={`Billed last month${prev ? ` (${monthName(prev)})` : ''}`} v={inr(t.lastMonthBilled)} sub={`estimate was ${inr(t.lastMonthEstimate)}`} />
        <Tile l="Outside calls this month" v={num(t.callsThisMonth)} sub={t.errorsThisMonth ? `${num(t.errorsThisMonth)} failed` : 'none failed'} />
      </div>

      <section className="panel" style={{ padding: 12 }}>
        <h3 style={{ marginTop: 0 }}>Cost by month</h3>
        <MonthBars rows={data.byMonth} />
      </section>

      <section className="panel" style={{ padding: 12 }}>
        <h3 style={{ marginTop: 0 }}>Services this month</h3>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Service</th>
                <th className="num">Calls</th>
                <th className="num">Failed</th>
                <th>Usage</th>
                <th className="num">Cost so far</th>
                <th className="num">Projected</th>
                {prev && <th className="num">{monthName(prev)}</th>}
              </tr>
            </thead>
            <tbody>
              {[...groups].map(([g, list]) => (
                <Fragment key={g}>
                  <tr>
                    <td colSpan={prev ? 7 : 6} className="small muted" style={{ fontWeight: 600, paddingTop: 12 }}>
                      {g}
                    </td>
                  </tr>
                  {list.map((s) => {
                    const m = s.thisMonth ?? { calls: 0, errors: 0, units: {}, cost: 0 };
                    return (
                      <tr key={s.key}>
                        <td>{s.label}</td>
                        <td className="num">{num(m.calls)}</td>
                        <td className="num">{m.errors ? <span className="chip bad">{num(m.errors)}</span> : '—'}</td>
                        <td className="small">{usageText(m.units) || '—'}</td>
                        <td className="num">{s.ownKey ? <span className="small muted">billed to the workspace</span> : inr(m.cost)}</td>
                        <td className="num">{s.ownKey ? '—' : inr(s.projected)}</td>
                        {prev && <td className="num muted">{s.months[prev] ? inr(s.months[prev].cost) : '—'}</td>}
                      </tr>
                    );
                  })}
                </Fragment>
              ))}
              {!(data.services as Json[]).length && (
                <tr>
                  <td colSpan={7} className="muted small">
                    Nothing counted yet: usage is counted from now on.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel" style={{ padding: 12 }}>
        <h3 style={{ marginTop: 0 }}>Bills from these services</h3>
        {!(data.bills as Json[]).length ? (
          <p className="small muted" style={{ margin: 0 }}>
            No bills yet from GitHub, Cloudflare, Neon, OpenAI, Google, Meta, Razorpay… Receipts that arrive by mail become bills in Books (Settings → Mail intake), and show here by month.
          </p>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Supplier</th>
                  <th>Service</th>
                  <th>Bill</th>
                  <th className="num">Amount</th>
                  <th className="num">In ₹</th>
                </tr>
              </thead>
              <tbody>
                {(data.bills as Json[]).map((b) => (
                  <tr key={b.id}>
                    <td>{date(b.bill_date)}</td>
                    <td>{b.vendor}</td>
                    <td className="small">{b.service}</td>
                    <td className="small">{b.vendor_ref ?? b.bill_number ?? ''}</td>
                    <td className="num">
                      {b.currency} {Number(b.total).toLocaleString('en-IN')}
                    </td>
                    <td className="num">{inr(b.inr)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {scope === 'platform' && (data.workspaces as Json[]).length > 0 && (
        <section className="panel" style={{ padding: 12 }}>
          <h3 style={{ marginTop: 0 }}>Workspaces this month</h3>
          <table className="data">
            <thead>
              <tr>
                <th>Workspace</th>
                <th className="num">Outside calls</th>
                <th className="num">AI tokens</th>
                <th className="num">Requests</th>
              </tr>
            </thead>
            <tbody>
              {(data.workspaces as Json[]).map((w) => (
                <tr key={w.tenant_key}>
                  <td>{w.name ?? (w.tenant_key.startsWith('00000000') ? 'Platform (background work)' : w.tenant_key)}</td>
                  <td className="num">{num(w.calls ?? 0)}</td>
                  <td className="num">{num(w.tokens ?? 0)}</td>
                  <td className="num">{num(w.requests ?? 0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {data.platformAdmin && <PriceList key={JSON.stringify(data.prices)} prices={data.prices} onSaved={() => refetch()} />}
    </div>
  );
}
