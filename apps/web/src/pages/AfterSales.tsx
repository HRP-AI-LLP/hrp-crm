/** After-sales: warranties by serial, complaints and CAPA with quality numbers, and the escalation matrix. */
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Chart } from '../components/charts';
import { LookupPicker } from '../components/fields';
import { d, Head, inr, type Json, Kpis, label, NoRows, today, useAct } from '../components/industry/kit';
import { SideTabs } from '../components/SideTabs';
import { Modal, Spinner } from '../components/ui';
import { get, post, put } from '../lib/api';

type Sec = 'warranties' | 'capa' | 'quality' | 'escalation';

export function AfterSalesPage() {
  const [sec, setSec] = useState<Sec>('warranties');
  const ov = useQuery({ queryKey: ['after-sales'], queryFn: () => get<Json>('/api/v1/after-sales/overview') });
  return (
    <div>
      <div className="page-head">
        <div>
          <h1>After-sales</h1>
          <p className="muted small" style={{ margin: 0 }}>
            Warranties, spare parts, complaints with root cause and corrective action, and escalations
          </p>
        </div>
      </div>
      {ov.data && (
        <Kpis
          items={[
            { l: 'Under warranty', v: ov.data.active },
            { l: 'Ending in 60 days', v: ov.data.expiring, tone: ov.data.expiring ? 'warn' : undefined, sub: 'offer an AMC' },
            { l: 'Spares issued this month', v: ov.data.parts_month, sub: ov.data.parts_value ? `${inr(ov.data.parts_value)} chargeable` : undefined },
            { l: 'Escalated tickets', v: ov.data.escalated, tone: ov.data.escalated ? 'bad' : undefined },
          ]}
        />
      )}
      <SideTabs
        id="aftersales"
        title="After-sales"
        items={[
          { key: 'warranties', label: 'Warranties' },
          { key: 'capa', label: 'Complaints & CAPA' },
          { key: 'quality', label: 'Quality numbers' },
          { key: 'escalation', label: 'Escalation matrix' },
        ]}
        value={sec}
        onChange={setSec}
      >
        <div className="panel-body" style={{ padding: 14 }}>
          {sec === 'warranties' && <Warranties />}
          {sec === 'capa' && <Capas />}
          {sec === 'quality' && <Quality />}
          {sec === 'escalation' && <Escalation />}
        </div>
      </SideTabs>
    </div>
  );
}

function Warranties() {
  const [serial, setSerial] = useState('');
  const [status, setStatus] = useState('active');
  const [expiring, setExpiring] = useState(false);
  const [edit, setEdit] = useState<Json | null>(null);
  const qs = new URLSearchParams({ ...(serial ? { serial } : {}), ...(status ? { status } : {}), ...(expiring ? { expiring: '60' } : {}) }).toString();
  const { data } = useQuery({ queryKey: ['warranties', qs], queryFn: () => get<{ items: Json[] }>(`/api/v1/warranties?${qs}`) });
  const act = useAct([['warranties'], ['after-sales']]);
  return (
    <>
      <Head title="Warranties" sub="Started automatically when an order with a warranted product is delivered. Add or correct serial numbers here.">
        <input placeholder="Serial number…" value={serial} onChange={(e) => setSerial(e.target.value)} style={{ width: 180 }} aria-label="Search serial" />
        <select value={status} onChange={(e) => setStatus(e.target.value)} style={{ width: 'auto' }} aria-label="Status">
          <option value="active">In warranty</option>
          <option value="expired">Expired</option>
          <option value="void">Void</option>
          <option value="">All</option>
        </select>
        <label className="check-row">
          <input type="checkbox" checked={expiring} onChange={(e) => setExpiring(e.target.checked)} /> Ending in 60 days
        </label>
        <button className="btn sm primary" onClick={() => setEdit({ accountId: '', productId: '', serialNo: '', quantity: 1, startsOn: today(), months: 12, notes: '' })}>
          Add warranty
        </button>
      </Head>
      {data?.items.length ? (
        <table className="data" data-export-title="Warranties">
          <thead>
            <tr>
              <th>Customer</th>
              <th>Product</th>
              <th>Serial</th>
              <th className="num">Qty</th>
              <th>From</th>
              <th>Until</th>
              <th>Order</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {data.items.map((w) => (
              <tr key={w.id}>
                <td>
                  <Link to={`/o/account/${w.account_id}`}>{w.account}</Link>
                </td>
                <td>{w.product ?? '—'}</td>
                <td className="mono">{w.serial_no ?? '—'}</td>
                <td className="num">{w.quantity}</td>
                <td>{d(w.starts_on)}</td>
                <td>
                  {d(w.ends_on)} {w.in_warranty ? w.days_left <= 60 && <span className="chip warn">{w.days_left} d</span> : <span className="chip">{w.status === 'void' ? 'void' : 'expired'}</span>}
                </td>
                <td>{w.sales_order_id ? <Link to={`/o/sales_order/${w.sales_order_id}`}>{w.order_number}</Link> : '—'}</td>
                <td>
                  <button className="btn sm" onClick={() => setEdit({ id: w.id, accountId: w.account_id, productId: w.product_id ?? '', serialNo: w.serial_no ?? '', quantity: w.quantity, startsOn: w.starts_on, endsOn: w.ends_on, status: w.status, notes: w.notes ?? '' })}>
                    Edit
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <NoRows>No warranties match. Set "Warranty (months)" on products; deliveries start them.</NoRows>
      )}
      {edit && (
        <Modal
          title={edit.id ? 'Warranty' : 'Add a warranty'}
          onClose={() => setEdit(null)}
          footer={
            <button
              className="btn primary"
              disabled={!edit.accountId || !edit.startsOn}
              onClick={async () => {
                const body = { accountId: edit.accountId, productId: edit.productId || null, serialNo: edit.serialNo || null, quantity: Number(edit.quantity) || 1, startsOn: edit.startsOn, endsOn: edit.endsOn || null, months: edit.endsOn ? null : Number(edit.months) || null, status: edit.status, notes: edit.notes || null };
                if (await act(() => (edit.id ? put(`/api/v1/warranties/${edit.id}`, body) : post('/api/v1/warranties', body)), 'Warranty saved')) setEdit(null);
              }}
            >
              Save
            </button>
          }
        >
          <div className="modal-body grid2">
            <div className="field">
              Customer
              <LookupPicker id="w-acc" objectKey="account" value={edit.accountId} onChange={(v) => setEdit({ ...edit, accountId: String(v ?? '') })} />
            </div>
            <div className="field">
              Product
              <LookupPicker id="w-prod" objectKey="product" value={edit.productId} onChange={(v) => setEdit({ ...edit, productId: String(v ?? '') })} />
            </div>
            <label className="field">
              Serial number
              <input value={edit.serialNo} onChange={(e) => setEdit({ ...edit, serialNo: e.target.value })} />
            </label>
            <label className="field">
              Quantity
              <input type="number" min={1} value={edit.quantity} onChange={(e) => setEdit({ ...edit, quantity: e.target.value })} />
            </label>
            <label className="field">
              Starts on
              <input type="date" value={edit.startsOn} onChange={(e) => setEdit({ ...edit, startsOn: e.target.value })} />
            </label>
            {edit.id ? (
              <label className="field">
                Ends on
                <input type="date" value={edit.endsOn ?? ''} onChange={(e) => setEdit({ ...edit, endsOn: e.target.value })} />
              </label>
            ) : (
              <label className="field">
                Months (blank: the product's)
                <input type="number" min={0} value={edit.months} onChange={(e) => setEdit({ ...edit, months: e.target.value })} />
              </label>
            )}
            {edit.id && (
              <label className="field">
                Status
                <select value={edit.status} onChange={(e) => setEdit({ ...edit, status: e.target.value })}>
                  <option value="active">Active</option>
                  <option value="void">Void</option>
                </select>
              </label>
            )}
            <label className="field" style={{ gridColumn: '1 / -1' }}>
              Notes
              <textarea rows={2} value={edit.notes} onChange={(e) => setEdit({ ...edit, notes: e.target.value })} />
            </label>
          </div>
        </Modal>
      )}
    </>
  );
}

const CAUSES = ['man', 'machine', 'method', 'material', 'measurement', 'environment', 'design', 'supplier', 'other'];
const CAPA_STEPS = ['open', 'investigating', 'action', 'verifying', 'closed'];

export function CapaModal({ capa, onClose }: { capa: Json; onClose: () => void }) {
  const [f, setF] = useState<Json>(capa);
  const act = useAct([['capas'], ['quality'], ['after-sales']]);
  const users = useQuery({ queryKey: ['users-min'], queryFn: () => get<{ items: Json[] }>('/api/v1/users'), staleTime: 300_000 });
  const T = (k: string, l: string, rows = 3) => (
    <label className="field" style={{ gridColumn: '1 / -1' }}>
      {l}
      <textarea rows={rows} value={f[k] ?? ''} onChange={(e) => setF({ ...f, [k]: e.target.value })} />
    </label>
  );
  return (
    <Modal
      title={f.id ? `${f.number ?? 'CAPA'} · ${f.title}` : 'Raise a CAPA'}
      wide
      onClose={onClose}
      footer={
        <button
          className="btn primary"
          disabled={!f.title?.trim()}
          onClick={async () => {
            const body = {
              title: f.title, ticketId: f.ticket_id || null, accountId: f.account_id || null, productId: f.product_id || null, severity: f.severity, rootCauseCategory: f.root_cause_category || null,
              rootCause: f.root_cause || null, containment: f.containment || null, correctiveAction: f.corrective_action || null, preventiveAction: f.preventive_action || null,
              ownerId: f.owner_id || null, dueOn: f.due_on || null, status: f.status, effective: f.effective ?? null,
            };
            if (await act(() => (f.id ? put(`/api/v1/capas/${f.id}`, body) : post('/api/v1/capas', body)), 'CAPA saved')) onClose();
          }}
        >
          Save
        </button>
      }
    >
      <div className="modal-body">
        <div className="stage-pills" style={{ marginBottom: 10 }}>
          {CAPA_STEPS.map((s) => (
            <button key={s} className={`btn sm${f.status === s ? ' primary' : ' ghost'}`} onClick={() => setF({ ...f, status: s })}>
              {label(s)}
            </button>
          ))}
        </div>
        <div className="grid2">
          <label className="field" style={{ gridColumn: '1 / -1' }}>
            Problem
            <input value={f.title ?? ''} onChange={(e) => setF({ ...f, title: e.target.value })} />
          </label>
          <label className="field">
            Severity
            <select value={f.severity ?? 'minor'} onChange={(e) => setF({ ...f, severity: e.target.value })}>
              <option value="minor">Minor</option>
              <option value="major">Major</option>
              <option value="critical">Critical</option>
            </select>
          </label>
          <label className="field">
            Root cause (6M)
            <select value={f.root_cause_category ?? ''} onChange={(e) => setF({ ...f, root_cause_category: e.target.value })}>
              <option value="">Not found yet</option>
              {CAUSES.map((c) => (
                <option key={c} value={c}>
                  {label(c)}
                </option>
              ))}
            </select>
          </label>
          <div className="field">
            Customer
            <LookupPicker id="capa-acc" objectKey="account" value={f.account_id ?? ''} onChange={(v) => setF({ ...f, account_id: v })} />
          </div>
          <div className="field">
            Product
            <LookupPicker id="capa-prod" objectKey="product" value={f.product_id ?? ''} onChange={(v) => setF({ ...f, product_id: v })} />
          </div>
          <label className="field">
            Owner
            <select value={f.owner_id ?? ''} onChange={(e) => setF({ ...f, owner_id: e.target.value })}>
              <option value="">—</option>
              {(users.data?.items ?? []).map((u) => (
                <option key={u.id} value={u.id}>
                  {u.full_name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            Due
            <input type="date" value={f.due_on ?? ''} onChange={(e) => setF({ ...f, due_on: e.target.value })} />
          </label>
          {T('containment', 'Containment (what was done right away)', 2)}
          {T('root_cause', 'Root cause (5 whys)')}
          {T('corrective_action', 'Corrective action (fix this one)')}
          {T('preventive_action', 'Preventive action (stop it happening again)')}
          {f.status === 'closed' && (
            <label className="field">
              Effective?
              <select value={f.effective == null ? '' : f.effective ? 'y' : 'n'} onChange={(e) => setF({ ...f, effective: e.target.value === '' ? null : e.target.value === 'y' })}>
                <option value="">Not checked yet</option>
                <option value="y">Yes — no repeat</option>
                <option value="n">No — it happened again</option>
              </select>
            </label>
          )}
        </div>
      </div>
    </Modal>
  );
}

function Capas() {
  const [status, setStatus] = useState('open');
  const { data } = useQuery({ queryKey: ['capas', status], queryFn: () => get<{ items: Json[] }>(`/api/v1/capas${status ? `?status=${status}` : ''}`) });
  const [edit, setEdit] = useState<Json | null>(null);
  return (
    <>
      <Head title="Complaints and CAPA" sub="Each complaint gets a root cause, containment, a corrective and a preventive action, an owner and a date; closing needs the corrective action.">
        <select value={status} onChange={(e) => setStatus(e.target.value)} style={{ width: 'auto' }} aria-label="Status">
          <option value="open">Open</option>
          <option value="closed">Closed</option>
          <option value="">All</option>
        </select>
        <button className="btn sm primary" onClick={() => setEdit({ title: '', severity: 'minor', status: 'open' })}>
          Raise CAPA
        </button>
      </Head>
      {data?.items.length ? (
        <table className="data" data-export-title="CAPA">
          <thead>
            <tr>
              <th>CAPA</th>
              <th>Customer / product</th>
              <th>Cause</th>
              <th>Owner</th>
              <th>Due</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {data.items.map((c) => (
              <tr key={c.id} onClick={() => setEdit(c)} style={{ cursor: 'pointer' }}>
                <td>
                  <b>{c.number}</b> {c.title}
                  <div className="small">
                    <span className={`chip${c.severity === 'critical' ? ' bad' : c.severity === 'major' ? ' warn' : ''}`}>{c.severity}</span>
                    {c.ticket_number && (
                      <Link to={`/o/ticket/${c.ticket_id}`} onClick={(e) => e.stopPropagation()}>
                        {' '}
                        {c.ticket_number}
                      </Link>
                    )}
                  </div>
                </td>
                <td className="small">{[c.account, c.product].filter(Boolean).join(' · ') || '—'}</td>
                <td>{c.root_cause_category ? label(c.root_cause_category) : '—'}</td>
                <td>{c.owner ?? '—'}</td>
                <td>{c.overdue ? <span className="chip bad">{d(c.due_on)}</span> : d(c.due_on)}</td>
                <td>
                  <span className={`chip${c.status === 'closed' ? ' good' : ''}`}>{label(c.status)}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <NoRows>No CAPAs here.</NoRows>
      )}
      {edit && <CapaModal capa={edit} onClose={() => setEdit(null)} />}
    </>
  );
}

function Quality() {
  const [days, setDays] = useState(180);
  const { data } = useQuery({ queryKey: ['quality', days], queryFn: () => get<Json>(`/api/v1/quality-stats?days=${days}`) });
  if (!data) return <Spinner />;
  return (
    <>
      <Head title="Quality numbers" sub="Where complaints come from and how fast they close.">
        <select value={days} onChange={(e) => setDays(Number(e.target.value))} style={{ width: 'auto' }} aria-label="Period">
          <option value={90}>Last 90 days</option>
          <option value={180}>Last 6 months</option>
          <option value={365}>Last 12 months</option>
        </select>
      </Head>
      <Kpis
        items={[
          { l: 'Open CAPAs', v: data.open, sub: data.critical ? `${data.critical} critical` : undefined, tone: data.critical ? 'bad' : undefined },
          { l: 'Overdue', v: data.overdue, tone: data.overdue ? 'bad' : undefined },
          { l: 'Closed in period', v: data.closed },
          { l: 'Days to close', v: data.avgDaysToClose ?? '—' },
          { l: 'Effective', v: data.effective + data.ineffective ? `${Math.round((data.effective / (data.effective + data.ineffective)) * 100)}%` : '—' },
        ]}
      />
      <div className="two-col">
        <div className="panel" style={{ padding: 12 }}>
          <h3 className="small" style={{ marginTop: 0 }}>
            Root causes
          </h3>
          {data.byCause.length ? <Chart id="q-cause" initial="donut" fmt={(n) => String(n)} data={{ categories: data.byCause.map((r: Json) => label(r.key)), series: [{ label: 'CAPAs', values: data.byCause.map((r: Json) => r.n) }] }} /> : <NoRows>None yet.</NoRows>}
        </div>
        <div className="panel" style={{ padding: 12 }}>
          <h3 className="small" style={{ marginTop: 0 }}>
            Products with most CAPAs
          </h3>
          {data.byProduct.length ? <Chart id="q-prod" initial="hbar" fmt={(n) => String(n)} data={{ categories: data.byProduct.map((r: Json) => r.key), series: [{ label: 'CAPAs', values: data.byProduct.map((r: Json) => r.n) }] }} /> : <NoRows>None yet.</NoRows>}
        </div>
        <div className="panel" style={{ padding: 12 }}>
          <h3 className="small" style={{ marginTop: 0 }}>
            Tickets by category
          </h3>
          {data.byTicketCategory.length ? <Chart id="q-tix" initial="bar" fmt={(n) => String(n)} data={{ categories: data.byTicketCategory.map((r: Json) => label(r.key)), series: [{ label: 'Tickets', values: data.byTicketCategory.map((r: Json) => r.n) }] }} /> : <NoRows>No tickets.</NoRows>}
        </div>
      </div>
    </>
  );
}

function Escalation() {
  const { data } = useQuery({ queryKey: ['escalation'], queryFn: () => get<{ enabled: boolean; levels: Json[] }>('/api/v1/escalation-matrix') });
  const users = useQuery({ queryKey: ['users-min'], queryFn: () => get<{ items: Json[] }>('/api/v1/users'), staleTime: 300_000 });
  const [f, setF] = useState<{ enabled: boolean; levels: Json[] } | null>(null);
  const act = useAct([['escalation']]);
  const cur = f ?? data;
  if (!cur) return <Spinner />;
  const setLevel = (i: number, p: Json) => setF({ ...cur, levels: cur.levels.map((l, j) => (j === i ? { ...l, ...p } : l)) });
  return (
    <>
      <Head title="Escalation matrix" sub="When a ticket passes its resolution time, it climbs: each level tells its people after its hours (counted from the breach).">
        <label className="check-row">
          <input type="checkbox" checked={cur.enabled} onChange={(e) => setF({ ...cur, enabled: e.target.checked })} /> On
        </label>
        <button className="btn sm primary" disabled={!f} onClick={async () => (await act(() => put('/api/v1/escalation-matrix', f), 'Escalation matrix saved')) && setF(null)}>
          Save
        </button>
      </Head>
      {cur.levels.map((l, i) => (
        <div key={i} className="panel" style={{ padding: 12, marginBottom: 10 }}>
          <div className="spread">
            <b>Level {i + 1}</b>
            <button className="btn sm ghost" onClick={() => setF({ ...cur, levels: cur.levels.filter((_, j) => j !== i) })}>
              Remove
            </button>
          </div>
          <div className="grid2" style={{ marginTop: 6 }}>
            <label className="field">
              Hours after the breach
              <input type="number" min={0} value={l.afterHours} onChange={(e) => setLevel(i, { afterHours: Number(e.target.value) })} />
            </label>
            <label className="field">
              Only these priorities (blank: all)
              <input value={(l.priorities ?? []).join(', ')} placeholder="urgent, high" onChange={(e) => setLevel(i, { priorities: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })} />
            </label>
            <div className="field" style={{ gridColumn: '1 / -1' }}>
              Tell
              <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
                {(users.data?.items ?? []).map((u) => (
                  <label key={u.id} className="check-row" style={{ marginRight: 10 }}>
                    <input type="checkbox" checked={l.userIds.includes(u.id)} onChange={(e) => setLevel(i, { userIds: e.target.checked ? [...l.userIds, u.id] : l.userIds.filter((x: string) => x !== u.id) })} />
                    {u.full_name}
                  </label>
                ))}
              </div>
              <label className="check-row">
                <input type="checkbox" checked={!!l.notifyManager} onChange={(e) => setLevel(i, { notifyManager: e.target.checked })} /> and the ticket owner's {i === 0 ? 'manager' : "manager's manager"}
              </label>
            </div>
          </div>
        </div>
      ))}
      {cur.levels.length < 5 && (
        <button className="btn sm" onClick={() => setF({ ...cur, levels: [...cur.levels, { afterHours: cur.levels.length ? (cur.levels[cur.levels.length - 1]!.afterHours as number) * 2 || 4 : 0, userIds: [], notifyManager: true }] })}>
          Add a level
        </button>
      )}
    </>
  );
}
