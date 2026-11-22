/**
 * IT company suite: SaaS subscriptions (MRR dashboard, plans, subscriptions), service contracts
 * (retainers, AMC, T&M, fixed bid, support), product management (RICE roadmap, customer requests,
 * public roadmap) and resource capacity planning.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ViewSignButton } from '../components/DocumentViewer';
import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { SideTabs } from '../components/SideTabs';
import { ClientAssets, ClientVault, TechDocs } from '../components/industry/ClientIt';
import { uploadFile, useFiles } from '../components/Files';
import { BarChart } from '../components/charts';
import { LookupPicker } from '../components/fields';
import { Empty, Modal, Spinner, useToast } from '../components/ui';
import { del, get, post, put } from '../lib/api';
import { date, money2 } from '../lib/format';
import { useUsers } from '../lib/hooks';

type Json = Record<string, any>;
const today = () => new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
const num = (v: string | number | null | undefined) => (v === '' || v === null || v === undefined ? null : Number(v));
const inr = (n: number) => money2(n);
const INTERVAL: Record<string, string> = {
  month: 'Monthly',
  quarter: 'Quarterly',
  half_year: 'Half-yearly',
  year: 'Yearly',
};
const SUB_CLS: Record<string, string> = {
  trial: 'info',
  active: 'good',
  past_due: 'bad',
  paused: 'warn',
  cancelled: '',
  expired: '',
};

function useAct(keys: unknown[][]) {
  const qc = useQueryClient();
  const toast = useToast();
  return async <T,>(fn: () => Promise<T>, ok?: string): Promise<T | null> => {
    try {
      const r = await fn();
      if (ok) toast(ok);
      for (const k of keys) qc.invalidateQueries({ queryKey: k });
      return r;
    } catch (e) {
      toast((e as Error).message, true);
      return null;
    }
  };
}

type Section = 'subscriptions' | 'contracts' | 'products' | 'capacity' | 'assets' | 'vault' | 'docs';
const SECTIONS: { key: Section; label: string; icon: string; group: string }[] = [
  { key: 'contracts', label: 'Contracts', icon: 'contract', group: 'Commercial' },
  { key: 'subscriptions', label: 'Subscriptions', icon: 'repeat', group: 'Commercial' },
  { key: 'products', label: 'Products & roadmap', icon: 'layers', group: 'Delivery' },
  { key: 'capacity', label: 'Capacity', icon: 'users', group: 'Delivery' },
  { key: 'assets', label: 'Client assets', icon: 'box', group: 'Client IT' },
  { key: 'vault', label: 'Credentials vault', icon: 'wallet', group: 'Client IT' },
  { key: 'docs', label: 'Tech docs & runbooks', icon: 'book', group: 'Client IT' },
];

export function ItSuitePage() {
  const { section = 'subscriptions' } = useParams();
  const nav = useNavigate();
  const sec = (SECTIONS.some((s) => s.key === section) ? section : 'subscriptions') as Section;
  return (
    <div>
      <div className="page-head">
        <div>
          <h1>IT services</h1>
          <p className="muted small" style={{ margin: 0 }}>
            Contracts, SaaS subscriptions, product management, capacity, and the IT you run for clients
          </p>
        </div>
      </div>
      <SideTabs id="it" title="IT services" items={SECTIONS} value={sec} onChange={(k) => nav(`/it/${k}`)} sync={false} panel={false}>
        {sec === 'subscriptions' && <Subscriptions />}
        {sec === 'contracts' && <Contracts />}
        {sec === 'products' && <Products />}
        {sec === 'capacity' && <Capacity />}
        {sec === 'assets' && (
          <div className="panel" style={{ padding: 14 }}>
            <ClientAssets />
          </div>
        )}
        {sec === 'vault' && (
          <div className="panel" style={{ padding: 14 }}>
            <ClientVault />
          </div>
        )}
        {sec === 'docs' && (
          <div className="panel" style={{ padding: 14 }}>
            <TechDocs />
          </div>
        )}
      </SideTabs>
    </div>
  );
}

/* ───────────────────────── subscriptions ───────────────────────── */

function Subscriptions() {
  const metrics = useQuery({
    queryKey: ['it', 'saas-metrics'],
    queryFn: () => get<Json>('/api/v1/it/saas-metrics'),
  });
  const plans = useQuery({
    queryKey: ['it', 'plans'],
    queryFn: () => get<Json[]>('/api/v1/it/plans'),
  });
  const [status, setStatus] = useState('');
  const subs = useQuery({
    queryKey: ['it', 'subs', status],
    queryFn: () => get<Json[]>(`/api/v1/it/subscriptions${status ? `?status=${status}` : ''}`),
  });
  const act = useAct([['it']]);
  const [plan, setPlan] = useState<Json | null>(null);
  const [newSub, setNewSub] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const m = metrics.data;
  return (
    <div className="stack">
      {m && (
        <>
          <div className="kpis" style={{ margin: 0 }}>
            <div className="panel kpi">
              <div className="l">MRR</div>
              <div className="v">{inr(m.mrr)}</div>
              <div className="small muted">ARR {inr(m.arr)}</div>
            </div>
            <div className="panel kpi">
              <div className="l">Active subscriptions</div>
              <div className="v">{m.subscriptions}</div>
              <div className="small muted">
                {m.customers} customers · ARPA {inr(m.arpa)}
              </div>
            </div>
            <div className="panel kpi">
              <div className="l">Trials</div>
              <div className="v">{m.trials}</div>
              <div className="small muted">{m.paused} paused</div>
            </div>
            <div className="panel kpi">
              <div className="l">Revenue churn (30 days)</div>
              <div className={`v${m.revenueChurnPct > 5 ? ' tone-bad' : ''}`}>{m.revenueChurnPct}%</div>
              <div className="small muted">{m.lostSubscriptions30d} lost</div>
            </div>
            <div className="panel kpi">
              <div className="l">Past due</div>
              <div className={`v${m.pastDue ? ' tone-bad' : ''}`}>{m.pastDue}</div>
              <div className="small muted">unpaid 15+ days</div>
            </div>
          </div>
          <div className="panel" style={{ padding: 12 }} data-export-title="MRR movements">
            <b>MRR movements, last 12 months</b>
            <BarChart
              height={220}
              stacked
              data={{
                categories: m.months.map((x: Json) => new Date(`${x.month}-01T00:00:00Z`).toLocaleDateString('en-IN', { month: 'short', year: '2-digit', timeZone: 'UTC' })),
                series: [
                  { label: 'New', values: m.months.map((x: Json) => x.new) },
                  {
                    label: 'Expansion',
                    values: m.months.map((x: Json) => x.expansion),
                  },
                  {
                    label: 'Contraction',
                    values: m.months.map((x: Json) => x.contraction),
                  },
                  {
                    label: 'Churn',
                    values: m.months.map((x: Json) => x.churn),
                  },
                ],
              }}
            />
          </div>
          {m.upcoming.length > 0 && (
            <div className="panel" style={{ padding: 12 }}>
              <b>Renewals and trials ending in the next 30 days</b>
              <table className="data" data-export-title="Upcoming renewals" style={{ marginTop: 8 }}>
                <thead>
                  <tr>
                    <th>Subscription</th>
                    <th>Customer</th>
                    <th>Plan</th>
                    <th>Ends</th>
                    <th className="num">MRR</th>
                  </tr>
                </thead>
                <tbody>
                  {m.upcoming.map((u: Json) => (
                    <tr key={u.id} className="click" onClick={() => setOpen(u.id)}>
                      <td>{u.sub_number}</td>
                      <td>{u.account_name}</td>
                      <td>{u.plan_name}</td>
                      <td>
                        {date(u.current_period_end)} {u.status === 'trial' && <span className="chip info">trial</span>} {u.cancel_at_period_end && <span className="chip bad">cancels</span>}
                      </td>
                      <td className="num">{inr(u.mrr)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      <div className="panel" style={{ padding: 12 }}>
        <div className="spread" style={{ flexWrap: 'wrap', gap: 8 }}>
          <b>Plans</b>
          <button className="btn sm primary" onClick={() => setPlan({})}>
            + Plan
          </button>
        </div>
        {plans.data?.length ? (
          <table className="data" data-export-title="Subscription plans" style={{ marginTop: 8 }}>
            <thead>
              <tr>
                <th>Plan</th>
                <th>Product</th>
                <th>Billing</th>
                <th className="num">Price</th>
                <th>Seats</th>
                <th>Usage</th>
                <th>Trial</th>
                <th className="num">Subscribers</th>
              </tr>
            </thead>
            <tbody>
              {plans.data.map((p) => (
                <tr key={p.id} className="click" onClick={() => setPlan(p)}>
                  <td>
                    {p.name} {!p.active && <span className="chip">retired</span>}
                  </td>
                  <td>{p.product ?? '—'}</td>
                  <td>{INTERVAL[p.interval]}</td>
                  <td className="num">{inr(p.price)}</td>
                  <td>
                    {p.included_seats} incl.
                    {p.seat_price ? ` + ${inr(p.seat_price)}/seat` : ''}
                  </td>
                  <td>{p.usage_unit ? `${p.included_usage} ${p.usage_unit} incl. + ${money2(p.usage_price)} each` : '—'}</td>
                  <td>{p.trial_days ? `${p.trial_days} days` : '—'}</td>
                  <td className="num">{p.subscribers}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="muted small">Add the plans you sell: monthly or yearly price, seats included, price per extra seat, metered usage and a free trial.</p>
        )}
      </div>

      <div className="panel" style={{ padding: 12 }}>
        <div className="spread" style={{ flexWrap: 'wrap', gap: 8 }}>
          <b>Subscriptions</b>
          <div className="row">
            <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status">
              <option value="">All</option>
              {Object.keys(SUB_CLS).map((s) => (
                <option key={s} value={s}>
                  {s.replace('_', ' ')}
                </option>
              ))}
            </select>
            <button className="btn sm" onClick={() => act(() => post<Json>('/api/v1/it/subscriptions-run'), 'Renewals and invoices are up to date')}>
              Run renewals & invoicing
            </button>
            <button className="btn sm primary" disabled={!plans.data?.some((p) => p.active)} onClick={() => setNewSub(true)}>
              + Subscription
            </button>
          </div>
        </div>
        {subs.data?.length ? (
          <table className="data" data-export-title="Subscriptions" style={{ marginTop: 8 }}>
            <thead>
              <tr>
                <th>No.</th>
                <th>Customer</th>
                <th>Plan</th>
                <th>Status</th>
                <th className="num">Seats</th>
                <th>Current period</th>
                <th className="num">MRR</th>
              </tr>
            </thead>
            <tbody>
              {subs.data.map((s) => (
                <tr key={s.id} className="click" onClick={() => setOpen(s.id)}>
                  <td>{s.sub_number}</td>
                  <td>{s.account_name}</td>
                  <td>{s.plan_name}</td>
                  <td>
                    <span className={`chip ${SUB_CLS[s.status] ?? ''}`}>{s.status.replace('_', ' ')}</span> {s.cancel_at_period_end && <span className="chip bad">cancels at period end</span>}
                  </td>
                  <td className="num">{s.seats}</td>
                  <td>
                    {date(s.current_period_start)} – {date(s.current_period_end)}
                  </td>
                  <td className="num">{inr(s.mrr)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="muted small">No subscriptions{status ? ' with this status' : ''}.</p>
        )}
      </div>
      {plan && (
        <PlanModal
          p={plan}
          onClose={() => setPlan(null)}
          onSave={async (b) => (await act(() => (plan.id ? put(`/api/v1/it/plans/${plan.id}`, b) : post('/api/v1/it/plans', b)), 'Plan saved')) && setPlan(null)}
        />
      )}
      {newSub && (
        <NewSubModal
          plans={(plans.data ?? []).filter((p) => p.active)}
          onClose={() => setNewSub(false)}
          onSave={async (b) => (await act(() => post('/api/v1/it/subscriptions', b), 'Subscription created')) && setNewSub(false)}
        />
      )}
      {open && <SubModal id={open} plans={plans.data ?? []} onClose={() => setOpen(null)} />}
    </div>
  );
}

function PlanModal({ p, onClose, onSave }: { p: Json; onClose: () => void; onSave: (b: Json) => void }) {
  const [f, setF] = useState({
    name: p.name ?? '',
    code: p.code ?? '',
    product: p.product ?? '',
    interval: p.interval ?? 'month',
    price: p.price ?? '',
    includedSeats: p.included_seats ?? 1,
    seatPrice: p.seat_price ?? 0,
    usageUnit: p.usage_unit ?? '',
    includedUsage: p.included_usage ?? 0,
    usagePrice: p.usage_price ?? 0,
    trialDays: p.trial_days ?? 0,
    taxRate: p.tax_rate ?? 18,
    hsnSac: p.hsn_sac ?? '998315',
    active: p.active ?? true,
    description: p.description ?? '',
  });
  const set = (k: string) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  return (
    <Modal
      title={p.id ? p.name : 'New plan'}
      onClose={onClose}
      wide
      footer={
        <button
          className="btn primary"
          disabled={!f.name.trim() || f.price === ''}
          onClick={() =>
            onSave({
              name: f.name.trim(),
              code: f.code.trim() || null,
              product: f.product.trim() || null,
              description: f.description.trim() || null,
              interval: f.interval,
              price: Number(f.price),
              includedSeats: Number(f.includedSeats || 0),
              seatPrice: Number(f.seatPrice || 0),
              usageUnit: f.usageUnit.trim() || null,
              includedUsage: Number(f.includedUsage || 0),
              usagePrice: Number(f.usagePrice || 0),
              trialDays: Number(f.trialDays || 0),
              taxRate: Number(f.taxRate),
              hsnSac: f.hsnSac.trim() || null,
              active: f.active,
            })
          }
        >
          Save
        </button>
      }
    >
      <div className="modal-body grid2">
        <label className="field">
          Plan name
          <input value={f.name} onChange={set('name')} autoFocus />
        </label>
        <label className="field">
          Product
          <input value={f.product} onChange={set('product')} placeholder="e.g. SanchalanOS CRM" />
        </label>
        <label className="field">
          Billed
          <select value={f.interval} onChange={set('interval')}>
            {Object.entries(INTERVAL).map(([k, l]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          Price per period (₹, before GST)
          <input inputMode="decimal" value={f.price} onChange={set('price')} />
        </label>
        <label className="field">
          Seats included
          <input inputMode="numeric" value={f.includedSeats} onChange={set('includedSeats')} />
        </label>
        <label className="field">
          Price per extra seat (₹ per period)
          <input inputMode="decimal" value={f.seatPrice} onChange={set('seatPrice')} />
        </label>
        <label className="field">
          Metered usage unit (optional)
          <input value={f.usageUnit} onChange={set('usageUnit')} placeholder="e.g. API calls, WhatsApp messages" />
        </label>
        <label className="field">
          Usage included per period
          <input inputMode="decimal" value={f.includedUsage} onChange={set('includedUsage')} />
        </label>
        <label className="field">
          Price per unit beyond that (₹)
          <input inputMode="decimal" value={f.usagePrice} onChange={set('usagePrice')} />
        </label>
        <label className="field">
          Free trial (days)
          <input inputMode="numeric" value={f.trialDays} onChange={set('trialDays')} />
        </label>
        <label className="field">
          GST %
          <input inputMode="decimal" value={f.taxRate} onChange={set('taxRate')} />
        </label>
        <label className="field">
          SAC
          <input value={f.hsnSac} onChange={set('hsnSac')} />
        </label>
        <label className="field">
          Code
          <input value={f.code} onChange={set('code')} />
        </label>
        <label className="field row" style={{ alignItems: 'center' }}>
          <input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /> Sold to new customers
        </label>
        <label className="field wide">
          Description
          <textarea rows={2} value={f.description} onChange={set('description')} />
        </label>
      </div>
    </Modal>
  );
}

function NewSubModal({ plans, onClose, onSave }: { plans: Json[]; onClose: () => void; onSave: (b: Json) => void }) {
  const [f, setF] = useState({
    accountId: '',
    planId: plans[0]?.id ?? '',
    startDate: today(),
    seats: String(plans[0]?.included_seats ?? 1),
    discountPct: '0',
    trial: true,
    autoIssue: false,
    priceOverride: '',
  });
  const plan = plans.find((p) => p.id === f.planId);
  return (
    <Modal
      title="New subscription"
      onClose={onClose}
      footer={
        <button
          className="btn primary"
          disabled={!f.accountId || !f.planId}
          onClick={() =>
            onSave({
              accountId: f.accountId,
              planId: f.planId,
              startDate: f.startDate,
              seats: Number(f.seats || 1),
              discountPct: Number(f.discountPct || 0),
              trial: f.trial,
              autoIssue: f.autoIssue,
              priceOverride: num(f.priceOverride),
            })
          }
        >
          Create
        </button>
      }
    >
      <div className="modal-body grid2">
        <label className="field wide">
          Customer
          <LookupPicker id="sub-account" objectKey="account" value={f.accountId} onChange={(v) => setF({ ...f, accountId: String(v ?? '') })} />
        </label>
        <label className="field">
          Plan
          <select
            value={f.planId}
            onChange={(e) =>
              setF({
                ...f,
                planId: e.target.value,
                seats: String(plans.find((p) => p.id === e.target.value)?.included_seats ?? 1),
              })
            }
          >
            {plans.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} · {inr(p.price)} {(INTERVAL[p.interval] ?? '').toLowerCase()}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          Starts
          <input type="date" value={f.startDate} onChange={(e) => setF({ ...f, startDate: e.target.value })} />
        </label>
        <label className="field">
          Seats
          <input inputMode="numeric" value={f.seats} onChange={(e) => setF({ ...f, seats: e.target.value })} />
        </label>
        <label className="field">
          Discount %
          <input inputMode="decimal" value={f.discountPct} onChange={(e) => setF({ ...f, discountPct: e.target.value })} />
        </label>
        <label className="field">
          Special price (₹ per period, optional)
          <input inputMode="decimal" value={f.priceOverride} onChange={(e) => setF({ ...f, priceOverride: e.target.value })} />
        </label>
        {plan && plan.trial_days > 0 && (
          <label className="field row" style={{ alignItems: 'center' }}>
            <input type="checkbox" checked={f.trial} onChange={(e) => setF({ ...f, trial: e.target.checked })} /> Start with the {plan.trial_days}-day free trial
          </label>
        )}
        <label className="field row" style={{ alignItems: 'center' }}>
          <input type="checkbox" checked={f.autoIssue} onChange={(e) => setF({ ...f, autoIssue: e.target.checked })} /> Issue invoices automatically (otherwise drafts to check)
        </label>
      </div>
    </Modal>
  );
}

function SubModal({ id, plans, onClose }: { id: string; plans: Json[]; onClose: () => void }) {
  const { data } = useQuery({
    queryKey: ['it', 'sub', id],
    queryFn: () => get<Json>(`/api/v1/it/subscriptions/${id}`),
  });
  const act = useAct([['it']]);
  const [seats, setSeats] = useState<string | null>(null);
  const [planId, setPlanId] = useState<string | null>(null);
  const [usage, setUsage] = useState({ date: today(), quantity: '' });
  if (!data) return null;
  const s = data.subscription;
  const running = ['trial', 'active', 'past_due', 'paused'].includes(s.status);
  const action = (a: string, ok: string, body: Json = {}) => act(() => post(`/api/v1/it/subscriptions/${id}/${a}`, body), ok);
  return (
    <Modal title={`${s.sub_number} · ${s.account_name}`} onClose={onClose} wide>
      <div className="modal-body stack">
        <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
          <span className={`chip ${SUB_CLS[s.status] ?? ''}`}>{s.status.replace('_', ' ')}</span>
          <span className="small">
            {s.plan_name} · {INTERVAL[s.interval]} · period {date(s.current_period_start)} – {date(s.current_period_end)} · {inr(data.charges.amount)} a period · MRR {inr(s.mrr)}
          </span>
          {s.cancel_at_period_end && <span className="chip bad">cancels on {date(s.current_period_end)}</span>}
        </div>
        {running && (
          <div className="grid2">
            <label className="field">
              Plan (upgrade / downgrade)
              <div className="row">
                <select value={planId ?? s.plan_id} onChange={(e) => setPlanId(e.target.value)}>
                  {plans
                    .filter((p) => p.active || p.id === s.plan_id)
                    .map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                </select>
                <button className="btn sm" disabled={!planId || planId === s.plan_id} onClick={() => act(() => put(`/api/v1/it/subscriptions/${id}`, { planId }), 'Plan changed')}>
                  Change
                </button>
              </div>
            </label>
            <label className="field">
              Seats
              <div className="row">
                <input inputMode="numeric" value={seats ?? String(s.seats)} onChange={(e) => setSeats(e.target.value)} />
                <button
                  className="btn sm"
                  disabled={seats === null || Number(seats) === s.seats}
                  onClick={() =>
                    act(
                      () =>
                        put(`/api/v1/it/subscriptions/${id}`, {
                          seats: Number(seats),
                        }),
                      'Seats changed',
                    )
                  }
                >
                  Update
                </button>
              </div>
            </label>
            <label className="field">
              Record usage
              <div className="row">
                <input type="date" value={usage.date} onChange={(e) => setUsage({ ...usage, date: e.target.value })} />
                <input inputMode="decimal" placeholder="Quantity" value={usage.quantity} onChange={(e) => setUsage({ ...usage, quantity: e.target.value })} />
                <button
                  className="btn sm"
                  disabled={!usage.quantity}
                  onClick={async () =>
                    (await act(
                      () =>
                        post(`/api/v1/it/subscriptions/${id}/usage`, {
                          date: usage.date,
                          quantity: Number(usage.quantity),
                        }),
                      'Usage recorded',
                    )) && setUsage({ ...usage, quantity: '' })
                  }
                >
                  Add
                </button>
              </div>
            </label>
          </div>
        )}
        <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
          {s.status === 'trial' && (
            <button className="btn sm primary" onClick={() => action('activate', 'Trial converted')}>
              Convert trial now
            </button>
          )}
          {['active', 'past_due'].includes(s.status) && (
            <button className="btn sm" onClick={() => act(() => post(`/api/v1/it/subscriptions/${id}/invoice`), 'Invoice raised')}>
              Invoice this period
            </button>
          )}
          {['active', 'past_due'].includes(s.status) && (
            <button className="btn sm" onClick={() => action('pause', 'Paused')}>
              Pause
            </button>
          )}
          {s.status === 'paused' && (
            <button className="btn sm" onClick={() => action('resume', 'Resumed')}>
              Resume
            </button>
          )}
          {running && !s.cancel_at_period_end && (
            <button
              className="btn sm"
              onClick={() => {
                const reason = window.prompt('Why is the customer leaving? (optional)');
                if (reason !== null) void action('cancel_at_period_end', 'Cancels at the end of the period', { reason: reason || null });
              }}
            >
              Cancel at period end
            </button>
          )}
          {running && (
            <button
              className="btn sm danger"
              onClick={() => {
                const reason = window.prompt('Cancel now. Reason? (optional)');
                if (reason !== null)
                  void action('cancel', 'Cancelled', {
                    reason: reason || null,
                  });
              }}
            >
              Cancel now
            </button>
          )}
          {(['cancelled', 'expired'].includes(s.status) || s.cancel_at_period_end) && (
            <button className="btn sm primary" onClick={() => action('reactivate', 'Reactivated')}>
              {s.cancel_at_period_end && running ? 'Keep subscription' : 'Reactivate'}
            </button>
          )}
        </div>
        {data.invoices.length > 0 && (
          <table className="data" data-export-title="Subscription invoices">
            <thead>
              <tr>
                <th>Invoice</th>
                <th>Date</th>
                <th>Status</th>
                <th className="num">Total</th>
                <th className="num">Due</th>
              </tr>
            </thead>
            <tbody>
              {data.invoices.map((i: Json) => (
                <tr key={i.id}>
                  <td>
                    <Link to={`/o/invoice/${i.id}`}>{i.invoice_number ?? 'Draft'}</Link>
                  </td>
                  <td>{date(i.invoice_date)}</td>
                  <td>{i.status}</td>
                  <td className="num">{inr(i.total)}</td>
                  <td className="num">{inr(i.balance_due)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <details>
          <summary className="small">History</summary>
          <table className="data" data-export-title="Subscription history">
            <tbody>
              {data.events.map((e: Json, i: number) => (
                <tr key={i}>
                  <td>{date(e.event_date)}</td>
                  <td>{e.kind.replace('_', ' ')}</td>
                  <td className="num">{e.mrr_before !== e.mrr_after ? `${inr(e.mrr_before)} → ${inr(e.mrr_after)}` : ''}</td>
                  <td className="small muted">{e.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      </div>
    </Modal>
  );
}

/* ───────────────────────── contracts ───────────────────────── */

const KINDS: Record<string, string> = {
  retainer: 'Retainer',
  amc: 'AMC',
  time_materials: 'Time & materials',
  fixed_bid: 'Fixed bid / SOW',
  support: 'Support',
  enterprise_licence: 'Enterprise licence',
  nda: 'NDA',
  msa: 'MSA (master agreement)',
  other: 'Other agreement',
};
const DOC_TYPES: Record<string, string> = { nda: 'NDA', msa: 'MSA', sow: 'Statement of work', agreement: 'Agreement', amendment: 'Amendment / addendum', purchase_order: 'Purchase order', other: 'Other' };
const FREQ: Record<string, string> = {
  monthly: 'Monthly',
  quarterly: 'Quarterly',
  half_yearly: 'Half-yearly',
  yearly: 'Yearly',
  milestone: 'By milestone',
  one_time: 'One time',
  none: 'Not billed',
};
const MONTHLY: Record<string, number> = {
  monthly: 1,
  quarterly: 3,
  half_yearly: 6,
  yearly: 12,
};
const C_CLS: Record<string, string> = {
  draft: '',
  active: 'good',
  expired: 'warn',
  terminated: 'bad',
};

function Contracts() {
  const list = useQuery({
    queryKey: ['it', 'contracts'],
    queryFn: () => get<Json[]>('/api/v1/it/contracts'),
  });
  const act = useAct([['it']]);
  const [edit, setEdit] = useState<Json | null>(null);
  const [params, setParams] = useSearchParams();
  const [open, setOpenState] = useState<string | null>(params.get('contract'));
  const setOpen = (v: string | null) => {
    setOpenState(v);
    if (!v && params.get('contract')) setParams((p) => { const n = new URLSearchParams(p); n.delete('contract'); return n; }, { replace: true });
  };
  const [upload, setUpload] = useState(false);
  const rows = list.data ?? [];
  const active = rows.filter((c) => c.status === 'active');
  return (
    <div className="stack">
      <div className="kpis" style={{ margin: 0 }}>
        {(
          [
            ['Active contracts', String(active.length), `${rows.filter((c) => c.status === 'draft').length} draft`],
            [
              'Contract value (active)',
              inr(active.reduce((a, c) => a + (c.value ?? 0), 0)),
              `${inr(active.reduce((a, c) => a + (MONTHLY[c.billing_frequency] ? (c.period_fee ?? 0) / MONTHLY[c.billing_frequency]! : 0), 0))} a month in fees`,
            ],
            ['Renewals due', String(rows.filter((c) => c.renewal_due).length), 'within their notice period'],
            ['Over included hours', String(active.filter((c) => c.hours_left != null && c.hours_left < 0).length), 'this period'],
          ] as const
        ).map(([l, v, sub]) => (
          <div key={l} className="panel kpi">
            <div className="l">{l}</div>
            <div className="v">{v}</div>
            <div className="small muted">{sub}</div>
          </div>
        ))}
      </div>
      <div className="row" style={{ gap: 6 }}>
        <button className="btn primary" onClick={() => setEdit({})}>
          + Contract
        </button>
        <button className="btn" onClick={() => setUpload(true)}>
          ⤒ Add existing contracts (NDA, MSA, SoW…)
        </button>
        <button className="btn" onClick={() => act(() => post<Json>('/api/v1/it/contracts-run'), 'Contract billing is up to date')}>
          Bill what is due
        </button>
      </div>
      {rows.length ? (
        <div style={{ overflowX: 'auto' }}>
          <table className="data" data-export-title="Service contracts">
            <thead>
              <tr>
                <th>No.</th>
                <th>Contract</th>
                <th>Customer</th>
                <th>Type</th>
                <th>Status</th>
                <th>Term</th>
                <th>Billing</th>
                <th className="num">Hours this period</th>
                <th className="num">Value</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.id} className="click" onClick={() => setOpen(c.id)}>
                  <td>{c.contract_number}</td>
                  <td>
                    {c.name}
                    {c.project_name && <div className="small muted">{c.project_name}</div>}
                  </td>
                  <td>{c.account_name}</td>
                  <td>
                    {KINDS[c.kind]}
                    {c.doc_type && <div className="small muted">{DOC_TYPES[c.doc_type] ?? c.doc_type}</div>}
                  </td>
                  <td>
                    <span className={`chip ${C_CLS[c.status] ?? ''}`}>{c.status}</span> {c.renewal_due && <span className="chip warn">renew</span>}
                  </td>
                  <td>
                    {date(c.start_date)} – {c.end_date ? date(c.end_date) : 'open'}
                  </td>
                  <td>
                    {FREQ[c.billing_frequency]}
                    {c.period_fee ? ` · ${inr(c.period_fee)}` : ''}
                  </td>
                  <td
                    className="num"
                    style={{
                      color: c.hours_left != null && c.hours_left < 0 ? 'var(--bad)' : undefined,
                    }}
                  >
                    {c.hours_per_period != null ? `${c.hours_used} / ${c.hours_per_period}` : c.hours_used || '—'}
                  </td>
                  <td className="num">{money2(c.value, c.currency ?? 'INR')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty title="No contracts yet">Retainers, AMCs, time & materials and fixed-bid SOWs, support and licence contracts: hours included, overage, SLA, billing each period and renewals.</Empty>
      )}
      {edit && (
        <ContractModal
          c={edit}
          onClose={() => setEdit(null)}
          onSave={async (b) => (await act(() => (edit.id ? put(`/api/v1/it/contracts/${edit.id}`, b) : post('/api/v1/it/contracts', b)), 'Contract saved')) && setEdit(null)}
        />
      )}
      {open && <ContractView id={open} onClose={() => setOpen(null)} onEdit={(c) => (setOpen(null), setEdit(c))} />}
      {upload && <UploadContracts onClose={() => setUpload(false)} />}
    </div>
  );
}

const toB64 = async (f: File) => {
  const buf = new Uint8Array(await f.arrayBuffer());
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(bin);
};

/**
 * Existing signed contracts: the files are read (NDA, MSA, SoW, AMC, agreement, PO) and each becomes a
 * contract to check and save, with the client, a project and milestones for a SoW, and the documents kept.
 */
function UploadContracts({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [files, setFiles] = useState<{ name: string; data: string }[]>([]);
  const [res, setRes] = useState<Json | null>(null);
  const [saved, setSaved] = useState<Record<number, Json>>({});
  const [separate, setSeparate] = useState(false);
  const read = async (list: FileList | null) => {
    if (!list?.length) return;
    setBusy(true);
    try {
      const fs = await Promise.all(Array.from(list).slice(0, 10).map(async (f) => ({ name: f.name, data: await toB64(f) })));
      setFiles(fs);
      setRes(await post<Json>('/api/v1/it/contracts/read', { files: fs }));
      setSaved({});
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  };
  const parents = [...((res?.contracts ?? []) as Json[]).filter((c) => ['msa', 'agreement'].includes(c.doc_type) || c.kind === 'msa'), ...Object.values(saved).filter((x) => ['msa', 'agreement'].includes(x.docType))];
  return (
    <Modal title="Add existing contracts" onClose={onClose} wide>
      <div className="modal-body stack">
        <p className="small muted" style={{ margin: 0 }}>
          Upload the signed copies (PDF or Word): NDAs, MSAs, statements of work, AMCs, service agreements, POs. Each is read for the client, dates, value, currency, billing,
          notice and renewal; check what was read and save. The documents are kept with the contract; a SoW can get its project and milestones.
        </p>
        <label className="btn primary" style={{ cursor: 'pointer', alignSelf: 'flex-start' }}>
          {busy ? 'Reading…' : res ? 'Choose other files' : 'Choose files'}
          <input type="file" multiple accept=".pdf,.docx,.txt,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document" hidden disabled={busy} onChange={(e) => read(e.target.files)} />
        </label>
        {res && (res.docs as Json[]).length > 1 && (
          <label className="row small" style={{ gap: 6 }}>
            <input type="checkbox" checked={separate} onChange={(e) => (setSeparate(e.target.checked), setSaved({}))} />
            These are different contracts: save each document on its own (otherwise they are one contract with all its documents)
          </label>
        )}
        {res && !separate && (
          saved[0] ? (
            <div className="panel small" style={{ padding: 10 }}>
              ✓ Saved as {saved[0].number} ({saved[0].status}) with {files.length} document(s){saved[0].projectId ? ' and its project' : ''}
              {saved[0].nextInvoiceDate ? `; billed here from ${date(saved[0].nextInvoiceDate)}` : ''}
            </div>
          ) : (
            <ContractDraft
              doc={{ name: (res.docs as Json[]).map((d) => `${d.name}${d.read ? ` (${DOC_TYPES[d.read.docType] ?? d.read.docType})` : ''}`).join(' + '), read: res.merged, note: (res.docs as Json[]).map((d) => d.note).filter(Boolean).join(' · ') || null }}
              files={files}
              fileTypes={(res.docs as Json[]).map((d) => d.read?.docType ?? 'other')}
              res={res}
              parents={parents}
              onSaved={(x) => {
                setSaved({ 0: x });
                qc.invalidateQueries({ queryKey: ['it'] });
              }}
            />
          )
        )}
        {res &&
          separate &&
          (res.docs as Json[]).map((d, i) =>
            saved[i] ? (
              <div key={i} className="panel small" style={{ padding: 10 }}>
                ✓ <b>{d.name}</b> saved as {saved[i].number} ({saved[i].status}){saved[i].projectId ? ' with its project' : ''}
                {saved[i].nextInvoiceDate ? `; billed here from ${date(saved[i].nextInvoiceDate)}` : ''}
              </div>
            ) : (
              <ContractDraft
                key={i}
                doc={d}
                files={[files[i]!]}
                fileTypes={[d.read?.docType ?? 'other']}
                res={res}
                parents={parents}
                onSaved={(x) => {
                  setSaved((s) => ({ ...s, [i]: x }));
                  qc.invalidateQueries({ queryKey: ['it'] });
                }}
              />
            ),
          )}
      </div>
    </Modal>
  );
}

function ContractDraft({ doc, files, fileTypes, res, parents, onSaved }: { doc: Json; files: { name: string; data: string }[]; fileTypes: string[]; res: Json; parents: Json[]; onSaved: (x: Json) => void }) {
  const file = files[0]!;
  const toast = useToast();
  const r = (doc.read ?? {}) as Json;
  const [busy, setBusy] = useState(false);
  const [f, setF] = useState<Json>({
    name: r.projectName || r.title || file.name.replace(/\.[a-z]+$/i, ''),
    docType: r.docType ?? 'agreement',
    kind: r.kind ?? 'other',
    accountId: res.account?.id ?? '',
    newAccountName: res.account ? '' : (r.client ?? res.client ?? ''),
    startDate: r.effectiveDate ?? '',
    endDate: r.endDate ?? '',
    signedOn: r.signedOn ?? '',
    currency: r.currency ?? 'INR',
    value: r.value ?? '',
    billingFrequency: r.billingFrequency ?? 'none',
    periodFee: r.periodFee ?? '',
    hourlyRate: r.hourlyRate ?? '',
    hoursPerPeriod: r.hoursPerPeriod ?? '',
    paymentTermsDays: r.paymentTermsDays ?? '',
    noticeDays: r.noticeDays ?? '',
    autoRenew: !!r.autoRenew,
    governingLaw: r.governingLaw ?? '',
    clientRef: r.clientRef ?? '',
    summary: r.summary ?? '',
    parentId: '',
    projectId: '',
    newProject: r.docType === 'sow',
    billFrom: '',
    taxRate: r.currency && r.currency !== 'INR' ? 0 : 18,
  });
  const set = (k: string) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const billed = f.billingFrequency !== 'none' && !['nda', 'msa', 'other'].includes(f.kind);
  const save = async () => {
    setBusy(true);
    try {
      const x = await post<Json>('/api/v1/it/contracts/upload', {
        files,
        fileTypes,
        accountId: f.accountId || null,
        newAccountName: f.accountId ? null : f.newAccountName.trim() || null,
        name: f.name.trim(),
        docType: f.docType,
        kind: f.kind,
        startDate: f.startDate,
        endDate: f.endDate || null,
        signedOn: f.signedOn || null,
        currency: f.currency,
        value: num(f.value),
        billingFrequency: billed ? f.billingFrequency : 'none',
        periodFee: num(f.periodFee),
        hourlyRate: num(f.hourlyRate),
        hoursPerPeriod: num(f.hoursPerPeriod),
        paymentTermsDays: num(f.paymentTermsDays),
        noticeDays: num(f.noticeDays),
        autoRenew: f.autoRenew,
        governingLaw: f.governingLaw.trim() || null,
        clientRef: f.clientRef.trim() || null,
        summary: f.summary.trim() || null,
        parentId: f.parentId || null,
        projectId: f.projectId || null,
        newProject: !f.projectId && f.newProject,
        milestones: f.newProject && !f.projectId ? (r.milestones ?? []) : [],
        billFrom: f.billFrom || null,
        taxRate: Number(f.taxRate) || 0,
        extracted: r,
      });
      toast(`Saved as ${x.number}`);
      onSaved({ ...x, docType: f.docType, contract_number: x.number, name: f.name });
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="panel stack" style={{ padding: 12 }}>
      <div className="spread" style={{ flexWrap: 'wrap' }}>
        <b>📄 {doc.name}</b>
        <span className="small muted">
          {doc.read ? `Read ${doc.read.engine === 'ai' ? 'by the AI model' : 'by rules'}` : ''}
          {doc.note ? ` · ${doc.note}` : ''}
        </span>
      </div>
      <div className="grid2">
        <label className="field">
          Contract name
          <input value={f.name} onChange={set('name')} />
        </label>
        <label className="field">
          Document
          <select value={f.docType} onChange={set('docType')}>
            {Object.entries(DOC_TYPES).map(([k, l]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          Client
          {f.accountId ? (
            <LookupPicker id={`up-acc-${file.name}`} objectKey="account" value={f.accountId} onChange={(v) => setF({ ...f, accountId: String(v ?? '') })} />
          ) : (
            <span className="row" style={{ gap: 6 }}>
              <input value={f.newAccountName} onChange={set('newAccountName')} placeholder="New client's name" />
              <LookupPicker id={`up-acc2-${file.name}`} objectKey="account" value="" onChange={(v) => setF({ ...f, accountId: String(v ?? '') })} />
            </span>
          )}
          {!f.accountId && <span className="small muted">Will be added as a new client (or pick an existing one)</span>}
          {r.parties?.length > 0 && <span className="small muted">Parties: {r.parties.join(' · ')}</span>}
        </label>
        <label className="field">
          Contract type (billing)
          <select value={f.kind} onChange={set('kind')}>
            {Object.entries(KINDS).map(([k, l]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          Starts
          <input type="date" value={f.startDate} onChange={set('startDate')} />
        </label>
        <label className="field">
          Ends
          <input type="date" value={f.endDate} onChange={set('endDate')} />
        </label>
        <label className="field">
          Signed on
          <input type="date" value={f.signedOn} onChange={set('signedOn')} />
        </label>
        <label className="field">
          Their reference (agreement / SOW / PO no.)
          <input value={f.clientRef} onChange={set('clientRef')} />
        </label>
        <label className="field">
          Currency
          <select value={f.currency} onChange={set('currency')}>
            {['INR', 'USD', 'EUR', 'GBP', 'AED', 'SGD', 'AUD', 'CAD', 'JPY', 'CHF'].map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </label>
        <label className="field">
          Total value ({f.currency})
          <input inputMode="decimal" value={f.value} onChange={set('value')} />
        </label>
        {!['nda', 'msa', 'other'].includes(f.kind) && (
          <>
            <label className="field">
              Billing
              <select value={f.billingFrequency} onChange={set('billingFrequency')}>
                {Object.entries(FREQ).map(([k, l]) => (
                  <option key={k} value={k}>
                    {l}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              Fee per period ({f.currency})
              <input inputMode="decimal" value={f.periodFee} onChange={set('periodFee')} />
            </label>
            <label className="field">
              Hourly rate ({f.currency})
              <input inputMode="decimal" value={f.hourlyRate} onChange={set('hourlyRate')} />
            </label>
            <label className="field">
              Hours included per period
              <input inputMode="decimal" value={f.hoursPerPeriod} onChange={set('hoursPerPeriod')} />
            </label>
            <label className="field">
              GST %
              <input inputMode="decimal" value={f.taxRate} onChange={set('taxRate')} />
            </label>
            <label className="field">
              Bill here from (earlier periods were billed elsewhere)
              <input type="date" value={f.billFrom} onChange={set('billFrom')} />
              <span className="small muted">Empty: from the next period</span>
            </label>
          </>
        )}
        <label className="field">
          Payment terms (days)
          <input inputMode="numeric" value={f.paymentTermsDays} onChange={set('paymentTermsDays')} />
        </label>
        <label className="field">
          Notice period (days)
          <input inputMode="numeric" value={f.noticeDays} onChange={set('noticeDays')} />
        </label>
        <label className="field">
          Governing law
          <input value={f.governingLaw} onChange={set('governingLaw')} />
        </label>
        {parents.length > 0 && f.docType !== 'msa' && (
          <label className="field">
            Under the MSA / agreement
            <select value={f.parentId} onChange={set('parentId')}>
              <option value="">—</option>
              {parents.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.contract_number} · {c.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="field">
          Project
          <select value={f.projectId} onChange={set('projectId')}>
            <option value="">{f.newProject ? 'A new project for it' : 'None'}</option>
            {(res.projects ?? []).map((p: Json) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          {!f.projectId && (
            <label className="row small" style={{ gap: 4 }}>
              <input type="checkbox" checked={f.newProject} onChange={(e) => setF({ ...f, newProject: e.target.checked })} />
              Create a project{r.milestones?.length ? ` with its ${r.milestones.length} milestone(s)` : ''}
            </label>
          )}
        </label>
        <label className="row small" style={{ gap: 6 }}>
          <input type="checkbox" checked={f.autoRenew} onChange={(e) => setF({ ...f, autoRenew: e.target.checked })} />
          Renews automatically
        </label>
      </div>
      {r.milestones?.length > 0 && (
        <div className="small">
          Milestones: {r.milestones.map((m: Json) => `${m.name}${m.amount ? ` ${money2(m.amount, f.currency)}` : ''}${m.due ? ` by ${date(m.due)}` : ''}`).join(' · ')}
        </div>
      )}
      <label className="field">
        Summary
        <textarea rows={2} value={f.summary} onChange={set('summary')} />
      </label>
      <div>
        <button className="btn primary" disabled={busy || !f.name.trim() || !f.startDate || (!f.accountId && !f.newAccountName.trim())} onClick={save}>
          {busy ? 'Saving…' : 'Save this contract'}
        </button>
      </div>
    </div>
  );
}

function ContractView({ id, onClose, onEdit }: { id: string; onClose: () => void; onEdit: (c: Json) => void }) {
  const { data } = useQuery({
    queryKey: ['it', 'contract', id],
    queryFn: () => get<Json>(`/api/v1/it/contracts/${id}`),
  });
  const act = useAct([['it']]);
  if (!data) return null;
  const c = data.contract;
  const a = (x: string, ok: string) => act(() => post(`/api/v1/it/contracts/${id}/${x}`), ok);
  return (
    <Modal title={`${c.contract_number} · ${c.name}`} onClose={onClose} wide>
      <div className="modal-body stack">
        {(c.doc_type || c.client_ref || c.summary) && (
          <div className="small">
            {c.doc_type && <span className="chip">{DOC_TYPES[c.doc_type] ?? c.doc_type}</span>} {c.client_ref && <>Ref {c.client_ref} · </>}
            {c.signed_on && <>signed {date(c.signed_on)} · </>}
            {c.parent_number && <>under {c.parent_number} · </>}
            {c.payment_terms_days != null && <>payment in {c.payment_terms_days} days · </>}
            {c.notice_days != null && <>notice {c.notice_days} days · </>}
            {c.governing_law && <>law of {c.governing_law}</>}
            {c.summary && <p style={{ margin: '4px 0 0' }}>{c.summary}</p>}
          </div>
        )}
        {(data.files ?? []).length > 0 && (
          <div className="row small" style={{ gap: 8, flexWrap: 'wrap' }}>
            {(data.files as Json[]).map((x) => (
              <a key={x.id} className="btn sm" href={x.url} target="_blank" rel="noreferrer" title={x.description ?? undefined}>
                📄 {x.description ? `${x.description.split(' — ')[0]}: ` : ''}
                {x.name}
              </a>
            ))}
          </div>
        )}
        <ContractDocuments id={id} deal={data.deal} dealFiles={data.dealFiles ?? []} />
        <div className="small">
          <span className={`chip ${C_CLS[c.status] ?? ''}`}>{c.status}</span> {KINDS[c.kind]} for <b>{c.account_name}</b>
          {c.project_name && <> · project {c.project_name}</>} · {date(c.start_date)} – {c.end_date ? date(c.end_date) : 'open-ended'} · {FREQ[c.billing_frequency]}
          {c.period_fee ? ` at ${money2(c.period_fee, c.currency ?? 'INR')} + GST ${c.tax_rate}%` : ''}
        </div>
        <div className="kpis" style={{ margin: 0 }}>
          <div className="panel kpi">
            <div className="l">This period</div>
            <div className="v" style={{ fontSize: 16 }}>
              {date(c.period.start)} – {date(c.period.end)}
            </div>
          </div>
          <div className="panel kpi">
            <div className="l">Hours used</div>
            <div className="v">
              {c.hours_used}
              {c.hours_per_period != null ? ` / ${c.hours_per_period}` : ''}
            </div>
            {c.overage_rate ? <div className="small muted">beyond: {inr(c.overage_rate)}/h</div> : null}
          </div>
          <div className="panel kpi">
            <div className="l">SLA</div>
            <div className="v" style={{ fontSize: 16 }}>
              {c.sla_response_hours != null ? `Respond ${c.sla_response_hours} h` : '—'}
              {c.sla_resolution_hours != null ? ` · resolve ${c.sla_resolution_hours} h` : ''}
            </div>
            <div className="small muted">
              Tickets this period: {data.tickets?.n ?? 0} ({data.tickets?.resolved ?? 0} resolved)
            </div>
          </div>
          <div className="panel kpi">
            <div className="l">Next invoice</div>
            <div className="v" style={{ fontSize: 16 }}>
              {c.next_invoice_date ? date(c.next_invoice_date) : '—'}
            </div>
          </div>
        </div>
        <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
          {c.status !== 'terminated' && (
            <button className="btn sm" onClick={() => onEdit(c)}>
              Edit
            </button>
          )}
          {c.status === 'draft' && (
            <button className="btn sm primary" onClick={() => a('activate', 'Contract active')}>
              Activate
            </button>
          )}
          {c.status === 'active' && (
            <button className="btn sm" onClick={() => act(() => post(`/api/v1/it/contracts/${id}/invoice`), 'Invoice raised')}>
              Invoice next period
            </button>
          )}
          {['active', 'expired'].includes(c.status) && c.end_date && (
            <button className="btn sm" onClick={() => a('renew', 'Renewed for another term')}>
              Renew
            </button>
          )}
          {['active', 'draft'].includes(c.status) && (
            <button className="btn sm danger" onClick={() => window.confirm('Terminate this contract today?') && a('terminate', 'Terminated')}>
              Terminate
            </button>
          )}
        </div>
        {data.invoices.length > 0 && (
          <table className="data" data-export-title="Contract invoices">
            <thead>
              <tr>
                <th>Period</th>
                <th>Invoice</th>
                <th>Status</th>
                <th className="num">Hours used</th>
                <th className="num">Overage</th>
                <th className="num">Total</th>
              </tr>
            </thead>
            <tbody>
              {data.invoices.map((i: Json) => (
                <tr key={i.period_start}>
                  <td>
                    {date(i.period_start)} – {date(i.period_end)}
                  </td>
                  <td>{i.invoice_id ? <Link to={`/o/invoice/${i.invoice_id}`}>{i.invoice_number ?? 'Draft'}</Link> : '—'}</td>
                  <td>{i.status ?? '—'}</td>
                  <td className="num">{i.hours_used ?? '—'}</td>
                  <td className="num">{i.overage_hours ? `${i.overage_hours} h` : '—'}</td>
                  <td className="num">{i.total != null ? inr(i.total) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {c.terms && (
          <details>
            <summary className="small">Terms</summary>
            <p style={{ whiteSpace: 'pre-wrap' }}>{c.terms}</p>
          </details>
        )}
      </div>
    </Modal>
  );
}

function ContractModal({ c, onClose, onSave }: { c: Json; onClose: () => void; onSave: (b: Json) => void }) {
  const projects = useQuery({
    queryKey: ['projects', 'all'],
    queryFn: () => get<Json[]>('/api/v1/projects'),
  });
  const [f, setF] = useState({
    name: c.name ?? '',
    accountId: c.account_id ?? '',
    projectId: c.project_id ?? '',
    kind: c.kind ?? 'retainer',
    startDate: c.start_date ?? today(),
    endDate: c.end_date ?? '',
    value: c.value ?? '',
    billingFrequency: c.billing_frequency ?? 'monthly',
    periodFee: c.period_fee ?? '',
    hoursPerPeriod: c.hours_per_period ?? '',
    overageRate: c.overage_rate ?? '',
    slaResponseHours: c.sla_response_hours ?? '',
    slaResolutionHours: c.sla_resolution_hours ?? '',
    autoRenew: c.auto_renew ?? false,
    renewalNoticeDays: c.renewal_notice_days ?? 30,
    taxRate: c.tax_rate ?? 18,
    hsnSac: c.hsn_sac ?? '998313',
    terms: c.terms ?? '',
  });
  const set = (k: string) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  return (
    <Modal
      title={c.id ? c.contract_number : 'New contract'}
      onClose={onClose}
      wide
      footer={
        <button
          className="btn primary"
          disabled={!f.name.trim() || !f.accountId}
          onClick={() =>
            onSave({
              name: f.name.trim(),
              accountId: f.accountId,
              projectId: f.projectId || null,
              kind: f.kind,
              startDate: f.startDate,
              endDate: f.endDate || null,
              value: Number(f.value || 0),
              billingFrequency: f.billingFrequency,
              periodFee: num(f.periodFee),
              hoursPerPeriod: num(f.hoursPerPeriod),
              overageRate: num(f.overageRate),
              slaResponseHours: num(f.slaResponseHours),
              slaResolutionHours: num(f.slaResolutionHours),
              autoRenew: f.autoRenew,
              renewalNoticeDays: Number(f.renewalNoticeDays || 0),
              taxRate: Number(f.taxRate),
              hsnSac: f.hsnSac || null,
              terms: f.terms.trim() || null,
            })
          }
        >
          Save
        </button>
      }
    >
      <div className="modal-body grid2">
        <label className="field">
          Contract name
          <input value={f.name} onChange={set('name')} autoFocus />
        </label>
        <label className="field">
          Type
          <select value={f.kind} onChange={set('kind')}>
            {Object.entries(KINDS).map(([k, l]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          Customer
          <LookupPicker id="contract-account" objectKey="account" value={f.accountId} onChange={(v) => setF({ ...f, accountId: String(v ?? '') })} />
        </label>
        <label className="field">
          Project (hours are counted from its time logs)
          <select value={f.projectId} onChange={set('projectId')}>
            <option value="">—</option>
            {(projects.data ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.name ?? p.title}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          Starts
          <input type="date" value={f.startDate} onChange={set('startDate')} />
        </label>
        <label className="field">
          Ends
          <input type="date" value={f.endDate} onChange={set('endDate')} />
        </label>
        <label className="field">
          Billing
          <select value={f.billingFrequency} onChange={set('billingFrequency')}>
            {Object.entries(FREQ).map(([k, l]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          Fee per period (₹, before GST)
          <input inputMode="decimal" value={f.periodFee} onChange={set('periodFee')} />
        </label>
        <label className="field">
          Hours included per period
          <input inputMode="decimal" value={f.hoursPerPeriod} onChange={set('hoursPerPeriod')} />
        </label>
        <label className="field">
          Rate for hours beyond (₹/h)
          <input inputMode="decimal" value={f.overageRate} onChange={set('overageRate')} />
        </label>
        <label className="field">
          SLA: first response (hours)
          <input inputMode="decimal" value={f.slaResponseHours} onChange={set('slaResponseHours')} />
        </label>
        <label className="field">
          SLA: resolution (hours)
          <input inputMode="decimal" value={f.slaResolutionHours} onChange={set('slaResolutionHours')} />
        </label>
        <label className="field">
          Total contract value (₹)
          <input inputMode="decimal" value={f.value} onChange={set('value')} />
        </label>
        <label className="field">
          Remind before renewal (days)
          <input inputMode="numeric" value={f.renewalNoticeDays} onChange={set('renewalNoticeDays')} />
        </label>
        <label className="field">
          GST %
          <input inputMode="decimal" value={f.taxRate} onChange={set('taxRate')} />
        </label>
        <label className="field">
          SAC
          <input value={f.hsnSac} onChange={set('hsnSac')} />
        </label>
        <label className="field row wide" style={{ alignItems: 'center' }}>
          <input type="checkbox" checked={f.autoRenew} onChange={(e) => setF({ ...f, autoRenew: e.target.checked })} /> Renew automatically for the same term when it ends
        </label>
        <label className="field wide">
          Terms / scope
          <textarea rows={4} value={f.terms} onChange={set('terms')} />
        </label>
      </div>
    </Modal>
  );
}

/* ───────────────────────── products and roadmap ───────────────────────── */

const ITEM_STATUS: [string, string, string][] = [
  ['idea', 'Ideas', ''],
  ['under_review', 'Under review', 'warn'],
  ['planned', 'Planned', 'info'],
  ['in_progress', 'In progress', 'info'],
  ['released', 'Released', 'good'],
  ['declined', 'Declined', ''],
];

function Products() {
  const list = useQuery({
    queryKey: ['it', 'products'],
    queryFn: () => get<Json[]>('/api/v1/it/products'),
  });
  const act = useAct([['it']]);
  const [edit, setEdit] = useState<Json | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  if (open) return <Roadmap id={open} onBack={() => setOpen(null)} onEdit={setEdit} />;
  return (
    <div className="stack">
      <div>
        <button className="btn primary" onClick={() => setEdit({})}>
          + Product
        </button>
      </div>
      {list.data?.length ? (
        <table className="data" data-export-title="Products">
          <thead>
            <tr>
              <th>Product</th>
              <th>Owner</th>
              <th>Delivery project</th>
              <th className="num">Open roadmap items</th>
              <th className="num">New requests</th>
            </tr>
          </thead>
          <tbody>
            {list.data.map((p) => (
              <tr key={p.id} className="click" onClick={() => setOpen(p.id)}>
                <td>
                  {p.key && <span className="chip">{p.key}</span>} {p.name}
                  {p.vision && <div className="small muted">{p.vision}</div>}
                </td>
                <td>{p.owner_name ?? '—'}</td>
                <td>{p.project_name ?? '—'}</td>
                <td className="num">{p.open_items}</td>
                <td className="num">{p.new_requests}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <Empty title="No products yet">A product holds its roadmap (scored with RICE), customer feature requests and the project that builds it.</Empty>
      )}
      {edit && (
        <ProductModal
          p={edit}
          onClose={() => setEdit(null)}
          onSave={async (b) => (await act(() => (edit.id ? put(`/api/v1/it/products/${edit.id}`, b) : post('/api/v1/it/products', b)), 'Product saved')) && setEdit(null)}
        />
      )}
    </div>
  );
}

function ProductModal({ p, onClose, onSave }: { p: Json; onClose: () => void; onSave: (b: Json) => void }) {
  const projects = useQuery({
    queryKey: ['projects', 'all'],
    queryFn: () => get<Json[]>('/api/v1/projects'),
  });
  const { data: users } = useUsers();
  const [f, setF] = useState({
    name: p.name ?? '',
    key: p.key ?? '',
    vision: p.vision ?? '',
    description: p.description ?? '',
    projectId: p.project_id ?? '',
    ownerId: p.owner_id ?? '',
  });
  const set = (k: string) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  return (
    <Modal
      title={p.id ? p.name : 'New product'}
      onClose={onClose}
      footer={
        <button
          className="btn primary"
          disabled={!f.name.trim() || (!!f.key && !/^[A-Za-z][A-Za-z0-9]{1,9}$/.test(f.key))}
          onClick={() =>
            onSave({
              name: f.name.trim(),
              key: f.key || null,
              vision: f.vision.trim() || null,
              description: f.description.trim() || null,
              projectId: f.projectId || null,
              ownerId: f.ownerId || null,
            })
          }
        >
          Save
        </button>
      }
    >
      <div className="modal-body grid2">
        <label className="field">
          Name
          <input value={f.name} onChange={set('name')} autoFocus />
        </label>
        <label className="field">
          Key (2–10 letters)
          <input value={f.key} onChange={set('key')} placeholder="e.g. CRM" />
        </label>
        <label className="field">
          Product owner
          <select value={f.ownerId} onChange={set('ownerId')}>
            <option value="">—</option>
            {(users?.items ?? []).map((u) => (
              <option key={u.id} value={u.id}>
                {u.full_name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          Delivery project (backlog and releases)
          <select value={f.projectId} onChange={set('projectId')}>
            <option value="">—</option>
            {(projects.data ?? []).map((x) => (
              <option key={x.id} value={x.id}>
                {x.name ?? x.title}
              </option>
            ))}
          </select>
        </label>
        <label className="field wide">
          Vision
          <input value={f.vision} onChange={set('vision')} />
        </label>
        <label className="field wide">
          Description
          <textarea rows={3} value={f.description} onChange={set('description')} />
        </label>
      </div>
    </Modal>
  );
}

function Roadmap({ id, onBack, onEdit }: { id: string; onBack: () => void; onEdit: (p: Json) => void }) {
  const { data } = useQuery({
    queryKey: ['it', 'roadmap', id],
    queryFn: () => get<Json>(`/api/v1/it/products/${id}/roadmap`),
  });
  const act = useAct([['it']]);
  const [view, setView] = useState<'board' | 'priority' | 'requests'>('board');
  const [item, setItem] = useState<Json | null>(null);
  const [req, setReq] = useState<Json | null>(null);
  const items = (data?.items ?? []) as Json[];
  const ranked = useMemo(() => [...items].filter((i) => !['released', 'declined'].includes(i.status)).sort((a, b) => (b.score ?? -1) - (a.score ?? -1) || b.weight - a.weight), [items]);
  if (!data) return <Spinner />;
  const p = data.product;
  const shareUrl = p.public_token ? `${window.location.origin}/roadmap/${p.public_token}` : null;
  return (
    <div className="stack">
      <div className="spread" style={{ flexWrap: 'wrap', gap: 8 }}>
        <div>
          <button className="btn sm ghost" onClick={onBack}>
            ← Products
          </button>{' '}
          <b>{p.name}</b> {p.vision && <span className="muted small">— {p.vision}</span>}
        </div>
        <div className="row" style={{ gap: 6 }}>
          <button className="btn sm" onClick={() => onEdit(p)}>
            Edit product
          </button>
          {shareUrl && (
            <button className="btn sm" onClick={() => navigator.clipboard?.writeText(shareUrl)}>
              Copy public roadmap link
            </button>
          )}
          <button
            className={`btn sm${p.public_token ? ' danger' : ''}`}
            onClick={() =>
              act(
                () =>
                  post(`/api/v1/it/products/${id}/share`, {
                    on: !p.public_token,
                  }),
                p.public_token ? 'Public roadmap off' : 'Public roadmap on',
              )
            }
          >
            {p.public_token ? 'Turn public roadmap off' : 'Publish roadmap'}
          </button>
        </div>
      </div>
      <div className="row" style={{ gap: 6 }}>
        <div className="row" role="group">
          {(['board', 'priority', 'requests'] as const).map((v) => (
            <button key={v} className={`btn sm${view === v ? ' primary' : ' ghost'}`} onClick={() => setView(v)}>
              {v === 'board' ? 'Roadmap' : v === 'priority' ? 'Prioritise (RICE)' : `Requests (${data.requests.filter((r: Json) => r.status === 'new').length} new)`}
            </button>
          ))}
        </div>
        <button className="btn sm primary" onClick={() => setItem({})}>
          + Roadmap item
        </button>
        <button className="btn sm" onClick={() => setReq({})}>
          + Customer request
        </button>
      </div>

      {view === 'board' && (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(5, minmax(180px, 1fr))',
            gap: 8,
            overflowX: 'auto',
          }}
        >
          {ITEM_STATUS.filter(([k]) => k !== 'declined').map(([k, l]) => (
            <div
              key={k}
              className="panel"
              style={{
                padding: 8,
                background: 'var(--bg-2, #f6f8fa)',
                minHeight: 160,
              }}
            >
              <div className="spread small" style={{ marginBottom: 6 }}>
                <b>{l}</b>
                <span className="muted">{items.filter((i) => i.status === k).length}</span>
              </div>
              {items
                .filter((i) => i.status === k)
                .map((i) => (
                  <div key={i.id} className="panel" style={{ padding: 8, marginBottom: 6, cursor: 'pointer' }} onClick={() => setItem(i)}>
                    <div className="small muted">
                      {p.key ? `${p.key}-` : '#'}
                      {i.item_number} · {i.kind.replace('_', ' ')}
                      {i.quarter ? ` · ${i.quarter}` : ''}
                    </div>
                    <div>{i.title}</div>
                    <div className="small muted">
                      {i.score != null && <span className="chip info">RICE {i.score}</span>} {i.votes > 0 && <span className="chip">👍 {i.votes}</span>}{' '}
                      {i.mrr_asking > 0 && <span className="chip">{inr(i.mrr_asking)} MRR asking</span>}
                      {i.release_name && <span className="chip good">{i.release_name}</span>}
                    </div>
                  </div>
                ))}
            </div>
          ))}
        </div>
      )}

      {view === 'priority' && (
        <table className="data" data-export-title={`${p.name} — prioritised roadmap`}>
          <thead>
            <tr>
              <th>Item</th>
              <th>Status</th>
              <th className="num">Reach</th>
              <th className="num">Impact</th>
              <th className="num">Confidence</th>
              <th className="num">Effort (pm)</th>
              <th className="num">RICE</th>
              <th className="num">Requests</th>
              <th className="num">MRR asking</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {ranked.map((i) => (
              <tr key={i.id}>
                <td className="click" onClick={() => setItem(i)}>
                  {p.key ? `${p.key}-` : '#'}
                  {i.item_number} {i.title}
                </td>
                <td>{ITEM_STATUS.find((s) => s[0] === i.status)?.[1]}</td>
                <td className="num">{i.reach ?? '—'}</td>
                <td className="num">{i.impact ?? '—'}</td>
                <td className="num">{i.confidence != null ? `${i.confidence}%` : '—'}</td>
                <td className="num">{i.effort ?? '—'}</td>
                <td className="num">
                  <b>{i.score ?? '—'}</b>
                </td>
                <td className="num">
                  {i.votes}
                  {i.critical ? ` (${i.critical} critical)` : ''}
                </td>
                <td className="num">{i.mrr_asking ? inr(i.mrr_asking) : '—'}</td>
                <td className="num">
                  {!i.task_id && p.project_id && (
                    <button className="btn sm" onClick={() => act(() => post(`/api/v1/it/products/${id}/items/${i.id}/to-work`, {}), 'Added to the project backlog')}>
                      To backlog
                    </button>
                  )}
                  {i.task_id && (
                    <Link className="small" to={`/projects/${i.task_project_id}`}>
                      #{i.task_number} {i.task_status?.replace('_', ' ')}
                    </Link>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {view === 'requests' && (
        <table className="data" data-export-title={`${p.name} — customer requests`}>
          <thead>
            <tr>
              <th>Request</th>
              <th>From</th>
              <th>Importance</th>
              <th>Source</th>
              <th>Roadmap item</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {data.requests.map((r: Json) => (
              <tr key={r.id}>
                <td>
                  {r.title}
                  {r.description && <div className="small muted">{r.description}</div>}
                </td>
                <td>{r.account_name ?? r.contact_name ?? '—'}</td>
                <td>
                  <span className={`chip ${r.importance === 'critical' ? 'bad' : r.importance === 'important' ? 'warn' : ''}`}>{r.importance.replace(/_/g, ' ')}</span>
                </td>
                <td>{r.source}</td>
                <td>{r.item_id ? (items.find((i) => i.id === r.item_id)?.title ?? '—') : r.status === 'declined' ? <span className="chip">declined</span> : '—'}</td>
                <td className="num" style={{ whiteSpace: 'nowrap' }}>
                  {r.status === 'new' && (
                    <>
                      <select
                        className="sm"
                        defaultValue=""
                        onChange={(e) =>
                          e.target.value && act(() => post(`/api/v1/it/products/${id}/requests/${r.id}/triage`, e.target.value === '__new' ? { newItem: true } : { itemId: e.target.value }), 'Linked')
                        }
                        aria-label="Link to item"
                      >
                        <option value="">Link to…</option>
                        <option value="__new">+ New roadmap item</option>
                        {items.map((i) => (
                          <option key={i.id} value={i.id}>
                            {i.title}
                          </option>
                        ))}
                      </select>
                      <button className="btn sm ghost" onClick={() => act(() => post(`/api/v1/it/products/${id}/requests/${r.id}/triage`, { decline: true }), 'Declined')}>
                        Decline
                      </button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {item && <ItemModal productId={id} item={item} releases={data.releases} onClose={() => setItem(null)} />}
      {req && <RequestModal onClose={() => setReq(null)} items={items} onSave={async (b) => (await act(() => post(`/api/v1/it/products/${id}/requests`, b), 'Request logged')) && setReq(null)} />}
      {shareUrl && (
        <p className="small muted">
          Public roadmap:{' '}
          <a href={shareUrl} target="_blank" rel="noreferrer">
            {shareUrl}
          </a>{' '}
          — customers see planned, in-progress and released items and can ask for features.
        </p>
      )}
    </div>
  );
}

function ItemModal({ productId, item, releases, onClose }: { productId: string; item: Json; releases: Json[]; onClose: () => void }) {
  const act = useAct([['it']]);
  const [f, setF] = useState({
    title: item.title ?? '',
    description: item.description ?? '',
    kind: item.kind ?? 'feature',
    status: item.status ?? 'idea',
    quarter: item.quarter ?? '',
    reach: item.reach ?? '',
    impact: item.impact ?? '',
    confidence: item.confidence ?? '',
    effort: item.effort ?? '',
    releaseId: item.release_id ?? '',
    public: item.public ?? true,
  });
  const set = (k: string) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const score =
    f.reach !== '' && f.impact !== '' && f.confidence !== '' && Number(f.effort) > 0
      ? Math.round(((Number(f.reach) * Number(f.impact) * Number(f.confidence)) / 100 / Number(f.effort)) * 100) / 100
      : null;
  const y = new Date().getFullYear();
  const quarters = [y, y + 1].flatMap((yy) => [1, 2, 3, 4].map((q) => `${yy}-Q${q}`));
  const save = async () => {
    const b = {
      title: f.title.trim(),
      description: f.description.trim() || null,
      kind: f.kind,
      status: f.status,
      quarter: f.quarter || null,
      reach: num(f.reach),
      impact: num(f.impact),
      confidence: num(f.confidence),
      effort: num(f.effort),
      releaseId: f.releaseId || null,
      public: f.public,
    };
    if (await act(() => (item.id ? put(`/api/v1/it/products/${productId}/items/${item.id}`, b) : post(`/api/v1/it/products/${productId}/items`, b)), 'Saved')) onClose();
  };
  return (
    <Modal
      title={item.id ? `#${item.item_number} ${item.title}` : 'New roadmap item'}
      onClose={onClose}
      wide
      footer={
        <>
          {item.id && (
            <button
              className="btn danger"
              onClick={async () => window.confirm('Delete this roadmap item?') && (await act(() => del(`/api/v1/it/products/${productId}/items/${item.id}`), 'Deleted')) !== null && onClose()}
            >
              Delete
            </button>
          )}
          <button className="btn primary" disabled={!f.title.trim()} onClick={save}>
            Save
          </button>
        </>
      }
    >
      <div className="modal-body grid2">
        <label className="field wide">
          Title
          <input value={f.title} onChange={set('title')} autoFocus />
        </label>
        <label className="field wide">
          Problem and outcome
          <textarea rows={3} value={f.description} onChange={set('description')} />
        </label>
        <label className="field">
          Kind
          <select value={f.kind} onChange={set('kind')}>
            {['feature', 'improvement', 'bug', 'tech_debt', 'integration'].map((k) => (
              <option key={k} value={k}>
                {k.replace('_', ' ')}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          Status
          <select value={f.status} onChange={set('status')}>
            {ITEM_STATUS.map(([k, l]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          Quarter
          <select value={f.quarter} onChange={set('quarter')}>
            <option value="">—</option>
            {quarters.map((q) => (
              <option key={q} value={q}>
                {q}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          Release
          <select value={f.releaseId} onChange={set('releaseId')}>
            <option value="">—</option>
            {releases.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
                {r.version ? ` ${r.version}` : ''} ({r.status})
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          Reach (customers / users a quarter)
          <input inputMode="numeric" value={f.reach} onChange={set('reach')} />
        </label>
        <label className="field">
          Impact
          <select value={String(f.impact)} onChange={set('impact')}>
            <option value="">—</option>
            <option value="3">3 — massive</option>
            <option value="2">2 — high</option>
            <option value="1">1 — medium</option>
            <option value="0.5">0.5 — low</option>
            <option value="0.25">0.25 — minimal</option>
          </select>
        </label>
        <label className="field">
          Confidence %
          <select value={String(f.confidence)} onChange={set('confidence')}>
            <option value="">—</option>
            <option value="100">100 — high</option>
            <option value="80">80 — medium</option>
            <option value="50">50 — low</option>
          </select>
        </label>
        <label className="field">
          Effort (person-months)
          <input inputMode="decimal" value={f.effort} onChange={set('effort')} />
        </label>
        <p className="wide small" style={{ margin: 0 }}>
          RICE score: <b>{score ?? '—'}</b> <span className="muted">(reach × impact × confidence ÷ effort)</span>
        </p>
        <label className="field row wide" style={{ alignItems: 'center' }}>
          <input type="checkbox" checked={f.public} onChange={(e) => setF({ ...f, public: e.target.checked })} /> Show on the public roadmap
        </label>
      </div>
    </Modal>
  );
}

function RequestModal({ items, onClose, onSave }: { items: Json[]; onClose: () => void; onSave: (b: Json) => void }) {
  const [f, setF] = useState({
    title: '',
    description: '',
    accountId: '',
    contactName: '',
    source: 'sales',
    importance: 'important',
    itemId: '',
  });
  const set = (k: string) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  return (
    <Modal
      title="Customer request"
      onClose={onClose}
      footer={
        <button
          className="btn primary"
          disabled={!f.title.trim()}
          onClick={() =>
            onSave({
              title: f.title.trim(),
              description: f.description.trim() || null,
              accountId: f.accountId || null,
              contactName: f.contactName.trim() || null,
              source: f.source,
              importance: f.importance,
              itemId: f.itemId || null,
            })
          }
        >
          Log request
        </button>
      }
    >
      <div className="modal-body grid2">
        <label className="field wide">
          What they asked for
          <input value={f.title} onChange={set('title')} autoFocus />
        </label>
        <label className="field wide">
          Details
          <textarea rows={3} value={f.description} onChange={set('description')} />
        </label>
        <label className="field">
          Customer
          <LookupPicker id="req-account" objectKey="account" value={f.accountId} onChange={(v) => setF({ ...f, accountId: String(v ?? '') })} />
        </label>
        <label className="field">
          Person
          <input value={f.contactName} onChange={set('contactName')} />
        </label>
        <label className="field">
          How important to them
          <select value={f.importance} onChange={set('importance')}>
            <option value="nice_to_have">Nice to have</option>
            <option value="important">Important</option>
            <option value="critical">Critical (deal / renewal depends on it)</option>
          </select>
        </label>
        <label className="field">
          Heard via
          <select value={f.source} onChange={set('source')}>
            {['sales', 'support', 'email', 'call', 'internal'].map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <label className="field wide">
          Roadmap item (optional)
          <select value={f.itemId} onChange={set('itemId')}>
            <option value="">— decide later —</option>
            {items.map((i) => (
              <option key={i.id} value={i.id}>
                {i.title}
              </option>
            ))}
          </select>
        </label>
      </div>
    </Modal>
  );
}

/* ───────────────────────── capacity ───────────────────────── */

function Capacity() {
  const [from, setFrom] = useState(today());
  const { data, error } = useQuery({
    queryKey: ['it', 'capacity', from],
    queryFn: () => get<Json>(`/api/v1/it/capacity?from=${from}`),
  });
  const projects = useQuery({
    queryKey: ['projects', 'all'],
    queryFn: () => get<Json[]>('/api/v1/projects'),
  });
  const act = useAct([['it']]);
  const [edit, setEdit] = useState<Json | null>(null);
  if (error) return <p className="muted">{(error as Error).message}</p>;
  if (!data) return <Spinner />;
  const color = (load: number) => (load > 100 ? 'var(--bad)' : load >= 80 ? 'var(--good)' : load > 0 ? 'var(--accent)' : 'var(--line)');
  return (
    <div className="stack">
      <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
        <label className="row small">
          From <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <button className="btn sm primary" onClick={() => setEdit({ startDate: from, endDate: from, hoursPerWeek: 20 })}>
          + Allocate someone
        </button>
        <span className="small muted">Planned hours a week against each person's capacity; over 100% is overbooked.</span>
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table className="data" data-export-title="Capacity plan">
          <thead>
            <tr>
              <th>Person</th>
              <th className="num">h/week</th>
              {data.weeks.map((w: string) => (
                <th key={w} className="num" style={{ minWidth: 64 }}>
                  {date(w).slice(0, 6)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.people.map((p: Json) => (
              <tr key={p.userId}>
                <td>{p.name}</td>
                <td className="num">{p.capacity}</td>
                {p.weeks.map((w: Json) => (
                  <td
                    key={w.week}
                    className="num"
                    title={`${w.planned} h planned · ${w.logged} h logged${w.projects.length ? ` · ${w.projects.join(', ')}` : ''}`}
                    style={{
                      background: `color-mix(in srgb, ${color(w.load)} ${Math.min(60, w.load / 2)}%, transparent)`,
                    }}
                  >
                    {w.load ? `${w.load}%` : ''}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {data.allocations.length > 0 && (
        <table className="data" data-export-title="Allocations">
          <thead>
            <tr>
              <th>Person</th>
              <th>Project</th>
              <th>Role</th>
              <th>From</th>
              <th>To</th>
              <th className="num">h/week</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {data.allocations.map((a: Json) => (
              <tr key={a.id}>
                <td>{data.people.find((p: Json) => p.userId === a.user_id)?.name}</td>
                <td>{a.project}</td>
                <td>{a.role ?? '—'}</td>
                <td>{date(a.start_date)}</td>
                <td>{date(a.end_date)}</td>
                <td className="num">{a.hours_per_week}</td>
                <td className="num">
                  <button className="btn sm ghost" onClick={() => setEdit(a)}>
                    Edit
                  </button>
                  <button className="btn sm ghost" onClick={() => window.confirm('Remove this allocation?') && act(() => del(`/api/v1/it/allocations/${a.id}`), 'Removed')}>
                    ✕
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {edit && (
        <AllocationModal
          a={edit}
          people={data.people}
          projects={projects.data ?? []}
          onClose={() => setEdit(null)}
          onSave={async (b) => (await act(() => (edit.id ? put(`/api/v1/it/allocations/${edit.id}`, b) : post('/api/v1/it/allocations', b)), 'Saved')) && setEdit(null)}
        />
      )}
    </div>
  );
}

function AllocationModal({ a, people, projects, onClose, onSave }: { a: Json; people: Json[]; projects: Json[]; onClose: () => void; onSave: (b: Json) => void }) {
  const [f, setF] = useState({
    userId: a.user_id ?? people[0]?.userId ?? '',
    projectId: a.project_id ?? projects[0]?.id ?? '',
    startDate: a.start_date ?? a.startDate,
    endDate: a.end_date ?? a.endDate,
    hoursPerWeek: String(a.hours_per_week ?? a.hoursPerWeek ?? 20),
    role: a.role ?? '',
  });
  const set = (k: string) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  return (
    <Modal
      title={a.id ? 'Allocation' : 'Allocate someone'}
      onClose={onClose}
      footer={
        <button
          className="btn primary"
          disabled={!f.userId || !f.projectId || !Number(f.hoursPerWeek)}
          onClick={() =>
            onSave({
              userId: f.userId,
              projectId: f.projectId,
              startDate: f.startDate,
              endDate: f.endDate,
              hoursPerWeek: Number(f.hoursPerWeek),
              role: f.role.trim() || null,
            })
          }
        >
          Save
        </button>
      }
    >
      <div className="modal-body grid2">
        <label className="field">
          Person
          <select value={f.userId} onChange={set('userId')}>
            {people.map((p) => (
              <option key={p.userId} value={p.userId}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          Project
          <select value={f.projectId} onChange={set('projectId')}>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name ?? p.title}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          From
          <input type="date" value={f.startDate} onChange={set('startDate')} />
        </label>
        <label className="field">
          To
          <input type="date" value={f.endDate} onChange={set('endDate')} />
        </label>
        <label className="field">
          Hours a week
          <input inputMode="decimal" value={f.hoursPerWeek} onChange={set('hoursPerWeek')} />
        </label>
        <label className="field">
          Role
          <input value={f.role} onChange={set('role')} placeholder="e.g. Backend developer" />
        </label>
      </div>
    </Modal>
  );
}

/* ───────────────────────── contract documents ───────────────────────── */

const DOC_CATS = ['Bid document', 'Award / LoA / PO', 'Contract', 'SOW', 'NDA', 'MSA', 'Work order', 'Amendment', 'Completion certificate', 'Invoice support', 'Other'];

function ContractDocuments({ id, deal, dealFiles }: { id: string; deal: Json | null; dealFiles: Json[] }) {
  const files = useFiles('service_contract', id);
  const qc = useQueryClient();
  const toast = useToast();
  const [cat, setCat] = useState('SOW');
  const [busy, setBusy] = useState(false);
  const items = files.data?.items ?? [];
  return (
    <div className="panel" style={{ padding: 10 }}>
      <div className="spread" style={{ flexWrap: 'wrap', gap: 6 }}>
        <b>Documents</b>
        <div className="row" style={{ gap: 6 }}>
          <select value={cat} onChange={(e) => setCat(e.target.value)} style={{ width: 'auto' }} aria-label="Document type">
            {DOC_CATS.map((x) => (
              <option key={x}>{x}</option>
            ))}
          </select>
          <label className={`btn sm primary${busy ? ' disabled' : ''}`}>
            {busy ? 'Uploading…' : 'Upload'}
            <input
              type="file"
              multiple
              hidden
              onChange={async (e) => {
                const list = [...(e.target.files ?? [])];
                e.target.value = '';
                if (!list.length) return;
                setBusy(true);
                try {
                  for (const f of list) await uploadFile('service_contract', id, f, 'document', cat);
                  toast(`${list.length} document${list.length > 1 ? 's' : ''} added`);
                  qc.invalidateQueries({ queryKey: ['files', 'service_contract', id] });
                } catch (err) {
                  toast((err as Error).message, true);
                } finally {
                  setBusy(false);
                }
              }}
            />
          </label>
        </div>
      </div>
      {files.data && !files.data.enabled && <p className="muted small">File storage is not set up on this server.</p>}
      {items.length > 0 ? (
        <table className="data" style={{ marginTop: 6 }}>
          <tbody>
            {DOC_CATS.flatMap((c) => items.filter((f) => (f.description ?? 'Other').split(' — ')[0] === c || (c === 'Other' && !DOC_CATS.includes((f.description ?? '').split(' — ')[0]!))).map((f) => ({ c, f })))
              .map(({ c, f }) => (
                <tr key={f.id}>
                  <td style={{ width: 170 }}>
                    <span className="chip">{c}</span>
                  </td>
                  <td>
                    <ViewSignButton fileId={f.id} name={f.name} label={f.name} className="link-btn" />
                  </td>
                  <td>
                    <ViewSignButton fileId={f.id} name={f.name} label="View / sign" />
                  </td>
                  <td className="small muted">{date(f.createdAt)}</td>
                  <td>
                    <button
                      className="btn sm ghost"
                      onClick={async () => {
                        if (!window.confirm(`Remove ${f.name}?`)) return;
                        await del(`/api/v1/files/${f.id}`);
                        qc.invalidateQueries({ queryKey: ['files', 'service_contract', id] });
                      }}
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      ) : (
        <p className="muted small" style={{ margin: '6px 0 0' }}>
          Upload the bid, award letter, SOW, NDA and anything else for this contract.
        </p>
      )}
      {deal && (
        <div className="small" style={{ marginTop: 8 }}>
          From the deal <Link to={`/o/deal/${deal.id}`}>{deal.name}</Link>
          {deal.bid_number ? ` (bid ${deal.bid_number})` : ''}
          {dealFiles.length > 0 && ':'}
          {dealFiles.length > 0 && <DealFileLinks dealId={deal.id} />}
        </div>
      )}
    </div>
  );
}

function DealFileLinks({ dealId }: { dealId: string }) {
  const files = useFiles('deal', dealId);
  return (
    <>
      {(files.data?.items ?? []).map((f) => (
        <ViewSignButton key={f.id} fileId={f.id} name={f.name} label={`📄 ${f.name}`} className="btn sm ghost" />
      ))}
    </>
  );
}
