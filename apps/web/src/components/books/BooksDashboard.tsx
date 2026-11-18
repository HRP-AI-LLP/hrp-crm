/**
 * The Books overview: headline figures, the monthly income / expenses / profit chart, cash by
 * account, where the money went this year, who owes us and the bills to pay next.
 */
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { money2 } from '../../lib/format';

type Json = Record<string, any>;

const C = { income: '#0f8dde', expense: '#f59e0b', net: '#0f172a', grid: 'var(--line)', axis: 'var(--ink-3)' };

/** ₹ in Indian short form: 1.7L, 25K, 1.2Cr */
export function inrShort(v: number) {
  const n = Math.abs(v);
  const s = v < 0 ? '−' : '';
  const t = (x: number) => (x >= 10 ? x.toFixed(0) : x.toFixed(1).replace(/\.0$/, ''));
  if (n >= 1e7) return `${s}₹${t(n / 1e7)}Cr`;
  if (n >= 1e5) return `${s}₹${t(n / 1e5)}L`;
  if (n >= 1e3) return `${s}₹${t(n / 1e3)}K`;
  return `${s}₹${Math.round(n)}`;
}

function niceStep(range: number, ticks = 4) {
  const raw = range / ticks || 1;
  const p = 10 ** Math.floor(Math.log10(raw));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= raw) return m * p;
  return 10 * p;
}

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setW(Math.floor(e!.contentRect.width)));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthLabel = (ym: string) => `${MONTHS[Number(ym.slice(5, 7)) - 1]} ${ym.slice(2, 4)}`;

/** Grouped bars (income, expenses) with the month's profit as a line; drawn at the real pixel size. */
function TrendChart({ trend }: { trend: { month: string; income: number; expense: number }[] }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const H = 280;
  const pad = { l: 56, r: 12, t: 14, b: 30 };
  const rows = trend.map((t) => ({ ...t, income: Number(t.income) || 0, expense: Number(t.expense) || 0, net: (Number(t.income) || 0) - (Number(t.expense) || 0) }));
  const hi = Math.max(1, ...rows.flatMap((r) => [r.income, r.expense, r.net]));
  const lo = Math.min(0, ...rows.map((r) => r.net));
  const step = niceStep(hi - lo);
  const top = Math.ceil(hi / step) * step;
  const bottom = Math.floor(lo / step) * step;
  const ticks: number[] = [];
  for (let v = bottom; v <= top + step / 2; v += step) ticks.push(v);
  const iw = Math.max(0, width - pad.l - pad.r);
  const ih = H - pad.t - pad.b;
  const y = (v: number) => pad.t + ih - ((v - bottom) / (top - bottom || 1)) * ih;
  const band = rows.length ? iw / rows.length : 0;
  const bw = Math.min(22, band * 0.3);
  const cx = (i: number) => pad.l + band * i + band / 2;
  const h = hover != null ? rows[hover] : null;
  return (
    <div ref={ref} style={{ position: 'relative', width: '100%' }}>
      <div className="row small" style={{ gap: 16, margin: '0 0 6px', color: 'var(--ink-2)' }}>
        <span className="row" style={{ gap: 6 }}>
          <i style={{ width: 10, height: 10, borderRadius: 2, background: C.income, display: 'inline-block' }} /> Income
        </span>
        <span className="row" style={{ gap: 6 }}>
          <i style={{ width: 10, height: 10, borderRadius: 2, background: C.expense, display: 'inline-block' }} /> Expenses
        </span>
        <span className="row" style={{ gap: 6 }}>
          <i style={{ width: 14, height: 2, background: C.net, display: 'inline-block' }} /> Profit
        </span>
      </div>
      {width > 0 && (
        <svg width={width} height={H} role="img" aria-label="Income, expenses and profit by month" onMouseLeave={() => setHover(null)}>
          {ticks.map((v) => (
            <g key={v}>
              <line x1={pad.l} x2={width - pad.r} y1={y(v)} y2={y(v)} stroke={v === 0 ? 'var(--ink-3)' : C.grid} strokeWidth={v === 0 ? 1 : 1} strokeDasharray={v === 0 ? undefined : '3 3'} />
              <text x={pad.l - 8} y={y(v)} dy="0.32em" textAnchor="end" fontSize={11} fill={C.axis}>
                {inrShort(v)}
              </text>
            </g>
          ))}
          {rows.map((r, i) => (
            <g key={r.month} onMouseEnter={() => setHover(i)}>
              <rect x={pad.l + band * i} y={pad.t} width={band} height={ih} fill={hover === i ? 'var(--brand-50)' : 'transparent'} />
              <rect x={cx(i) - bw - 1} y={y(r.income)} width={bw} height={Math.max(0, y(0) - y(r.income))} rx={3} fill={C.income} />
              <rect x={cx(i) + 1} y={y(r.expense)} width={bw} height={Math.max(0, y(0) - y(r.expense))} rx={3} fill={C.expense} />
              <text x={cx(i)} y={H - 10} textAnchor="middle" fontSize={11} fill={C.axis}>
                {monthLabel(r.month)}
              </text>
            </g>
          ))}
          <polyline fill="none" stroke={C.net} strokeWidth={2} points={rows.map((r, i) => `${cx(i)},${y(r.net)}`).join(' ')} pointerEvents="none" />
          {rows.map((r, i) => (
            <circle key={r.month} cx={cx(i)} cy={y(r.net)} r={hover === i ? 4.5 : 3} fill={r.net < 0 ? 'var(--bad)' : 'var(--good)'} stroke="#fff" strokeWidth={1.5} pointerEvents="none" />
          ))}
        </svg>
      )}
      {h && hover != null && (
        <div
          className="small"
          style={{
            position: 'absolute', top: 40, left: Math.min(Math.max(cx(hover) - 90, 0), Math.max(0, width - 180)), width: 180, pointerEvents: 'none',
            background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 8, boxShadow: 'var(--shadow-pop)', padding: '8px 10px',
          }}
        >
          <b>{monthLabel(h.month)}</b>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <span style={{ color: C.income }}>Income</span> {money2(h.income)}
          </div>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <span style={{ color: '#b45309' }}>Expenses</span> {money2(h.expense)}
          </div>
          <div className="row" style={{ justifyContent: 'space-between', borderTop: '1px solid var(--line)', marginTop: 4, paddingTop: 4 }}>
            <span>Profit</span> <b style={{ color: h.net < 0 ? 'var(--bad)' : 'var(--good)' }}>{money2(h.net)}</b>
          </div>
        </div>
      )}
    </div>
  );
}

function Delta({ now, before, invert = false }: { now: number; before: number; invert?: boolean }) {
  if (!before && !now) return null;
  const d = now - before;
  const good = invert ? d <= 0 : d >= 0;
  return (
    <span style={{ color: good ? 'var(--good)' : 'var(--bad)', fontWeight: 600 }}>
      {d >= 0 ? '▲' : '▼'} {inrShort(Math.abs(d))}
    </span>
  );
}

function Card({ label, value, tone, children, onClick }: { label: string; value: string; tone?: 'good' | 'bad'; children?: React.ReactNode; onClick?: () => void }) {
  return (
    <div className="panel" style={{ padding: '14px 16px', display: 'grid', gap: 4, cursor: onClick ? 'pointer' : undefined }} onClick={onClick}>
      <div style={{ color: 'var(--ink-3)', fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.4 }}>{label}</div>
      <div style={{ fontSize: 24, fontWeight: 700, color: tone === 'bad' ? 'var(--bad)' : tone === 'good' ? 'var(--good)' : 'var(--ink)', fontVariantNumeric: 'tabular-nums' }}>{value}</div>
      {children && <div className="small muted">{children}</div>}
    </div>
  );
}

function Panel({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="panel" style={{ padding: 16, minWidth: 0 }}>
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 10 }}>
        <h3 style={{ margin: 0, fontSize: 15 }}>{title}</h3>
        {action}
      </div>
      {children}
    </div>
  );
}

const kindLabel: Record<string, string> = { bank: 'Bank', cash: 'Cash', credit_card: 'Card', wallet: 'Wallet' };

export function BooksDashboard({ data, go, fy }: { data: Json; go: (t: any) => void; fy: string }) {
  // twelve months ending this month, with the quiet ones as zero
  const got = new Map(((data.trend ?? []) as Json[]).map((t) => [t.month, t]));
  const end = String(data.today ?? new Date().toISOString()).slice(0, 7);
  const trend = Array.from({ length: 12 }, (_, i) => {
    const d = new Date(Date.UTC(Number(end.slice(0, 4)), Number(end.slice(5, 7)) - 12 + i, 1)).toISOString().slice(0, 7);
    const t = got.get(d);
    return { month: d, income: Number(t?.income ?? 0), expense: Number(t?.expense ?? 0) };
  });
  const banks = (data.banks ?? []) as Json[];
  const spend = (data.topSpend ?? []) as { name: string; amount: number }[];
  const spendMax = Math.max(1, ...spend.map((x) => x.amount));
  const owed = (data.owedBy ?? []) as Json[];
  const bills = (data.dueBills ?? []) as Json[];
  const today = String(data.today ?? '').slice(0, 10);
  const lm = data.lastMonth ?? { income: 0, expense: 0, net: 0 };
  return (
    <div className="stack" style={{ gap: 14 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12 }}>
        <Card label="Cash and bank" value={money2(data.cash)} onClick={() => go('banking')}>
          {banks.length} account{banks.length === 1 ? '' : 's'}
        </Card>
        <Card label="Receivables" value={money2(data.receivables?.v)} tone={data.receivables?.overdue > 0 ? 'bad' : undefined}>
          {data.receivables?.overdue > 0 ? <span style={{ color: 'var(--bad)' }}>{money2(data.receivables.overdue)} overdue</span> : 'Nothing overdue'}
        </Card>
        <Card label="Payables" value={money2(data.payables?.v)} onClick={() => go('payables')}>
          {money2(data.payables?.due_week)} due in 7 days
        </Card>
        <Card label={`Net profit · FY ${fy}`} value={money2(data.year?.net)} tone={data.year?.net < 0 ? 'bad' : 'good'}>
          Income {inrShort(data.year?.income ?? 0)} · Expenses {inrShort(data.year?.expense ?? 0)}
        </Card>
        <Card label="This month" value={money2(data.month?.net)} tone={data.month?.net < 0 ? 'bad' : undefined}>
          Income {inrShort(data.month?.income ?? 0)} · Spent {inrShort(data.month?.expense ?? 0)}
          <div>
            vs last month: in <Delta now={data.month?.income ?? 0} before={lm.income} /> · out <Delta now={data.month?.expense ?? 0} before={lm.expense} invert />
          </div>
        </Card>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 2.2fr) minmax(260px, 1fr)', gap: 14 }} className="books-dash-row">
        <Panel title="Income, expenses and profit — last 12 months">{trend.length ? <TrendChart trend={trend} /> : <p className="muted">Nothing posted yet.</p>}</Panel>
        <Panel
          title="Cash by account"
          action={
            <button className="btn ghost sm" onClick={() => go('banking')}>
              Banking →
            </button>
          }
        >
          {!banks.length ? (
            <p className="muted small">Add a bank account to see balances.</p>
          ) : (
            <div style={{ display: 'grid', gap: 8 }}>
              {banks.map((b) => (
                <div key={b.id} className="row" style={{ justifyContent: 'space-between', gap: 8, padding: '6px 0', borderBottom: '1px solid var(--line-2)' }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{b.name}</div>
                    <div className="small muted">
                      {kindLabel[b.kind] ?? b.kind}
                      {b.last4 ? ` ••${b.last4}` : ''}
                    </div>
                  </div>
                  <div style={{ fontWeight: 600, fontVariantNumeric: 'tabular-nums', color: b.balance < 0 ? 'var(--bad)' : 'var(--ink)', whiteSpace: 'nowrap' }}>
                    {b.kind === 'credit_card' && b.balance < 0 ? `${money2(-b.balance)} owed` : money2(b.balance)}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Panel>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 14 }}>
        <Panel title={`Where the money went · FY ${fy}`}>
          {!spend.length ? (
            <p className="muted small">No expenses posted this year.</p>
          ) : (
            <div style={{ display: 'grid', gap: 10 }}>
              {spend.map((x) => (
                <div key={x.name}>
                  <div className="row small" style={{ justifyContent: 'space-between', gap: 8 }}>
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{x.name}</span>
                    <b style={{ fontVariantNumeric: 'tabular-nums' }}>{money2(x.amount)}</b>
                  </div>
                  <div style={{ height: 6, background: 'var(--line-2)', borderRadius: 3, marginTop: 4 }}>
                    <div style={{ width: `${(x.amount / spendMax) * 100}%`, height: '100%', background: C.expense, borderRadius: 3 }} />
                  </div>
                </div>
              ))}
            </div>
          )}
        </Panel>
        <Panel title="Who owes you">
          {!owed.length ? (
            <p className="muted small">No unpaid invoices.</p>
          ) : (
            <table className="data small" style={{ margin: 0 }}>
              <tbody>
                {owed.map((o) => (
                  <tr key={o.id ?? o.name}>
                    <td style={{ whiteSpace: 'normal' }}>
                      {o.id ? <Link to={`/o/account/${o.id}`}>{o.name}</Link> : o.name}
                      <div className="muted">
                        {o.n} invoice{o.n === 1 ? '' : 's'}
                        {o.overdue > 0 && <span style={{ color: 'var(--bad)' }}> · {money2(o.overdue)} overdue</span>}
                      </div>
                    </td>
                    <td className="num">
                      <b>{money2(o.v)}</b>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
        <Panel
          title="Bills to pay next"
          action={
            <button className="btn ghost sm" onClick={() => go('payables')}>
              Payables →
            </button>
          }
        >
          {!bills.length ? (
            <p className="muted small">No bills waiting to be paid.</p>
          ) : (
            <table className="data small" style={{ margin: 0 }}>
              <tbody>
                {bills.map((b) => {
                  const late = b.due && b.due < today;
                  return (
                    <tr key={b.id}>
                      <td style={{ whiteSpace: 'normal' }}>
                        <Link to={`/o/bill/${b.id}`}>{b.vendor}</Link>
                        <div className="muted">
                          {b.number ?? ''} {b.due && <span style={{ color: late ? 'var(--bad)' : undefined }}>· {late ? 'was due' : 'due'} {b.due}</span>}
                        </div>
                      </td>
                      <td className="num">
                        <b>{money2(b.v)}</b>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </Panel>
      </div>
    </div>
  );
}
