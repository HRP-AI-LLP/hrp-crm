/**
 * Manufacturing: production overview, bills of materials, work centres, MRP, lots and expiry,
 * quality checks, job work (ITC-04) and production reports.
 */
import { hasAdmin } from '@synapse/shared';
import { useQuery } from '@tanstack/react-query';
import { type ReactNode, useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { BarChart } from '../components/charts';
import { useAct } from '../components/books/BookPanels';
import { ProductPick, QcModal, WO_STATUS_CLS } from '../components/mfg/MfgPanels';
import { useApps, useMetaReady } from '../components/ops/OrderPanel';
import { Empty, Modal, Spinner } from '../components/ui';
import { get, post, put } from '../lib/api';
import { useAuth } from '../lib/auth';
import { date, money2, moneyShort } from '../lib/format';

type Json = Record<string, any>;
const today = () => new Date().toISOString().slice(0, 10);
const monthStart = () => `${today().slice(0, 7)}-01`;

type Tab = 'overview' | 'boms' | 'centers' | 'mrp' | 'lots' | 'quality' | 'jobwork' | 'reports';
const TABS: [Tab, string, boolean][] = [
  ['overview', 'Overview', false],
  ['boms', 'Bills of materials', false],
  ['centers', 'Work centres', false],
  ['mrp', 'Planning (MRP)', true],
  ['lots', 'Batches & expiry', false],
  ['quality', 'Quality', false],
  ['jobwork', 'Job work & ITC-04', false],
  ['reports', 'Reports', false],
];

const Body = ({ children }: { children: ReactNode }) => (
  <div style={{ padding: '18px 20px', overflow: 'auto', display: 'grid', gap: 12, alignContent: 'start', gridAutoRows: 'max-content' }}>
    {children}
  </div>
);

function Kpi({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: 'good' | 'bad' }) {
  return (
    <div className="panel kpi">
      <div className="l">{label}</div>
      <div className={`v${tone ? ` tone-${tone}` : ''}`}>{value}</div>
      {sub && <div className="small muted">{sub}</div>}
    </div>
  );
}

export function ManufacturingPage() {
  const { me } = useAuth();
  const apps = useApps();
  const metaReady = useMetaReady();
  const [tab, setTab] = useState<Tab>(() => TABS.find(([k]) => `#${k}` === window.location.hash)?.[0] ?? 'overview');
  if (!me) return null;
  if (!apps.has('manufacturing')) return metaReady ? <Navigate to="/" replace /> : <Spinner />;
  const admin = hasAdmin(me.permissions, 'manufacturing');
  const go = (t: Tab) => {
    setTab(t);
    window.history.replaceState(null, '', `#${t}`);
  };
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Production</h1>
          <p>Bills of materials, work orders, job work, batches, quality and planning, costed into your books.</p>
        </div>
        <div className="row">
          <Link className="btn" to="/o/job_work">
            Job work
          </Link>
          <Link className="btn primary" to="/o/work_order">
            Work orders
          </Link>
        </div>
      </div>
      <section className="panel">
        <div className="tabs" role="tablist">
          {TABS.filter(([, , needsAdmin]) => admin || !needsAdmin).map(([k, l]) => (
            <button key={k} role="tab" aria-selected={tab === k} onClick={() => go(k)}>
              {l}
            </button>
          ))}
        </div>
        <div className="panel-body">
          {tab === 'overview' && <Overview go={go} />}
          {tab === 'boms' && <Boms admin={admin} />}
          {tab === 'centers' && <Centers admin={admin} />}
          {tab === 'mrp' && admin && <Mrp />}
          {tab === 'lots' && <Lots />}
          {tab === 'quality' && <Quality />}
          {tab === 'jobwork' && <JobWorkReport />}
          {tab === 'reports' && <Reports />}
        </div>
      </section>
    </>
  );
}

/* ───────────────────────── overview ───────────────────────── */

function Overview({ go }: { go: (t: Tab) => void }) {
  const { data } = useQuery({ queryKey: ['mfg', 'overview'], queryFn: () => get<Json>('/api/v1/mfg/overview') });
  if (!data) return <Spinner />;
  const scrapPct = data.output_month + data.scrap_month ? Math.round((data.scrap_month / (data.output_month + data.scrap_month)) * 1000) / 10 : 0;
  return (
    <div className="stack">
      <div className="kpis" style={{ margin: 0 }}>
        <Kpi label="Open work orders" value={String(data.released + data.in_progress)} sub={`${data.draft} draft · ${data.in_progress} running`} />
        <Kpi label="Late" value={String(data.late)} tone={data.late ? 'bad' : undefined} />
        <Kpi label="Work in progress" value={data.wip_value == null ? '—' : money2(data.wip_value)} />
        <Kpi label="Output this month" value={String(data.output_month)} sub={`Scrap ${scrapPct}%`} tone={scrapPct > 5 ? 'bad' : undefined} />
        <Kpi label="With job workers" value={data.at_job_workers == null ? '—' : money2(data.at_job_workers)} />
        <Kpi label="QC this month" value={`${data.qc_month - data.qc_failed_month}/${data.qc_month} passed`} tone={data.qc_failed_month ? 'bad' : undefined} />
      </div>
      <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
        {data.lots_expiring > 0 && (
          <button className="chip warn" onClick={() => go('lots')}>
            {data.lots_expiring} batch(es) expire within 30 days
          </button>
        )}
      </div>
      <h3 style={{ margin: 0 }}>Late work orders</h3>
      {!data.lateOrders.length ? (
        <p className="muted">Nothing is late.</p>
      ) : (
        <WoTable rows={data.lateOrders} />
      )}
    </div>
  );
}

function WoTable({ rows }: { rows: Json[] }) {
  return (
    <div className="table-wrap">
      <table className="data">
        <thead>
          <tr>
            <th>Order</th>
            <th>Product</th>
            <th className="num">Qty</th>
            <th className="num">Made</th>
            <th>Due</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((w) => (
            <tr key={w.id}>
              <td>
                <Link to={`/o/work_order/${w.id}`}>{w.wo_number ?? w.name}</Link>
              </td>
              <td>{w.product}</td>
              <td className="num">{w.quantity}</td>
              <td className="num">{w.produced_qty}</td>
              <td>{date(w.planned_end)}</td>
              <td>
                <span className={`chip ${WO_STATUS_CLS[w.status] ?? ''}`}>{String(w.status).replace('_', ' ')}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ───────────────────────── bills of materials ───────────────────────── */

function Boms({ admin }: { admin: boolean }) {
  const { data } = useQuery({ queryKey: ['mfg', 'boms'], queryFn: () => get<Json[]>('/api/v1/mfg/boms') });
  const [open, setOpen] = useState<string | 'new' | null>(null);
  const [q, setQ] = useState('');
  if (!data) return <Spinner />;
  const rows = data.filter((b) => !q || `${b.product} ${b.sku ?? ''} ${b.name}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="stack">
      <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap' }}>
        <input placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 260 }} />
        {admin && (
          <button className="btn primary" onClick={() => setOpen('new')}>
            New bill of materials
          </button>
        )}
      </div>
      {!rows.length ? (
        <Empty title="No bills of materials">A bill of materials lists the components and operations that make a product. Sub-assemblies can have their own.</Empty>
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Product</th>
                <th>BOM</th>
                <th>Kind</th>
                <th className="num">Makes</th>
                <th className="num">Components</th>
                <th className="num">Operations</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((b) => (
                <tr key={b.id} onClick={() => setOpen(b.id)} style={{ cursor: 'pointer' }}>
                  <td>
                    {b.product}
                    {b.sku && <span className="muted small"> · {b.sku}</span>}
                  </td>
                  <td>
                    {b.name} <span className="muted small">v{b.version}</span>
                  </td>
                  <td>{b.kind}</td>
                  <td className="num">{b.quantity}</td>
                  <td className="num">{b.components}</td>
                  <td className="num">{b.operations}</td>
                  <td>
                    <span className={`chip ${b.status === 'active' ? 'good' : b.status === 'archived' ? '' : 'warn'}`}>{b.status}</span>
                    {b.is_default && <span className="chip info" style={{ marginLeft: 4 }}>default</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {open && <BomModal id={open === 'new' ? null : open} admin={admin} onClose={() => setOpen(null)} onOpen={(id) => setOpen(id)} />}
    </div>
  );
}

interface BomLine {
  kind: 'component' | 'byproduct';
  productId: string;
  quantity: string;
  scrapPct: string;
  costSharePct: string;
  operationSeq: string;
}
interface BomOp {
  seq: string;
  name: string;
  workCenterId: string;
  setupMinutes: string;
  runMinutes: string;
  subcontract: boolean;
}

function BomModal({ id, admin, onClose, onOpen }: { id: string | null; admin: boolean; onClose: () => void; onOpen: (id: string) => void }) {
  const { data } = useQuery({ queryKey: ['mfg', 'bom', id], queryFn: () => get<Json>(`/api/v1/mfg/boms/${id}`), enabled: !!id });
  const centers = useQuery({ queryKey: ['mfg', 'centers'], queryFn: () => get<Json[]>('/api/v1/mfg/work-centers') });
  const act = useAct([['mfg', 'boms'], ['mfg', 'bom', id]]);
  const [form, setForm] = useState<{ productId: string; name: string; kind: string; quantity: string; yieldPct: string; requiresQc: boolean; notes: string; lines: BomLine[]; ops: BomOp[] } | null>(null);
  const [explodeQty, setExplodeQty] = useState('1');
  const explode = useQuery({ queryKey: ['mfg', 'explode', id, explodeQty], queryFn: () => get<Json[]>(`/api/v1/mfg/boms/${id}/explode?qty=${Number(explodeQty) || 1}`), enabled: !!id && data?.status === 'active' });
  if (id && !data) return null;
  const editable = admin && (!id || data?.status === 'draft');
  const f =
    form ??
    (data
      ? {
          productId: data.product_id,
          name: data.name,
          kind: data.kind,
          quantity: String(data.quantity),
          yieldPct: String(data.yield_pct),
          requiresQc: !!data.requires_qc,
          notes: data.notes ?? '',
          lines: (data.lines as Json[]).map((l) => ({ kind: l.line_kind, productId: l.product_id, quantity: String(l.quantity), scrapPct: String(l.scrap_pct || ''), costSharePct: String(l.cost_share_pct || ''), operationSeq: l.operation_seq == null ? '' : String(l.operation_seq) })),
          ops: (data.operations as Json[]).map((o) => ({ seq: String(o.seq), name: o.name, workCenterId: o.work_center_id ?? '', setupMinutes: String(o.setup_minutes || ''), runMinutes: String(o.run_minutes || ''), subcontract: !!o.subcontract })),
        }
      : { productId: '', name: 'Standard', kind: 'manufacture', quantity: '1', yieldPct: '100', requiresQc: false, notes: '', lines: [{ kind: 'component' as const, productId: '', quantity: '1', scrapPct: '', costSharePct: '', operationSeq: '' }], ops: [] });
  const set = (p: Partial<typeof f>) => setForm({ ...f, ...p });
  const save = async () => {
    const body = {
      productId: f.productId,
      name: f.name,
      kind: f.kind,
      quantity: Number(f.quantity),
      yieldPct: Number(f.yieldPct) || 100,
      requiresQc: f.requiresQc,
      notes: f.notes || null,
      lines: f.lines.filter((l) => l.productId).map((l) => ({ kind: l.kind, productId: l.productId, quantity: Number(l.quantity), scrapPct: Number(l.scrapPct) || 0, costSharePct: Number(l.costSharePct) || 0, operationSeq: l.operationSeq ? Number(l.operationSeq) : null })),
      operations: f.ops.filter((o) => o.name.trim()).map((o) => ({ seq: Number(o.seq), name: o.name.trim(), workCenterId: o.workCenterId || null, setupMinutes: Number(o.setupMinutes) || 0, runMinutes: Number(o.runMinutes) || 0, subcontract: o.subcontract })),
    };
    const r = (await act(() => (id ? put(`/api/v1/mfg/boms/${id}`, body) : post<{ id: string }>('/api/v1/mfg/boms', body)), 'Saved as draft')) as { id?: string } | null;
    if (r && !id && r.id) onOpen(r.id);
    setForm(null);
  };
  const status = (action: string, ok: string) => act(() => post(`/api/v1/mfg/boms/${id}/status`, { action }), ok);
  return (
    <Modal
      title={id ? `${data!.product} · ${data!.name} v${data!.version}` : 'New bill of materials'}
      onClose={onClose}
      wide
      footer={
        <>
          {id && admin && data!.status === 'draft' && (
            <button className="btn" onClick={() => status('activate', 'Active')}>
              Activate
            </button>
          )}
          {id && admin && data!.status === 'active' && !data!.is_default && (
            <button className="btn" onClick={() => status('make_default', 'Now the default')}>
              Make default
            </button>
          )}
          {id && admin && data!.status !== 'archived' && (
            <button className="btn ghost" onClick={() => status('archive', 'Archived')}>
              Archive
            </button>
          )}
          {id && admin && (
            <button className="btn" onClick={async () => {
              const r = (await act(() => post<{ id: string }>(`/api/v1/mfg/boms/${id}/copy`), 'New draft version')) as { id?: string } | null;
              if (r?.id) onOpen(r.id);
            }}>
              New version
            </button>
          )}
          {editable && (
            <button className="btn primary" onClick={save}>
              Save
            </button>
          )}
        </>
      }
    >
      <Body>
        {id && data!.status !== 'draft' && <div className="notice small">{data!.status === 'active' ? 'Active bills of materials are not edited: use “New version”, change it, then activate it.' : 'Archived.'}</div>}
        <div className="grid2">
          <label className="field">
            Product made
            {id ? <input value={data!.product} disabled /> : <ProductPick value={f.productId} onChange={(pid) => set({ productId: pid })} />}
          </label>
          <label className="field">
            Name
            <input value={f.name} disabled={!editable} onChange={(e) => set({ name: e.target.value })} />
          </label>
          <label className="field">
            Kind
            <select value={f.kind} disabled={!editable} onChange={(e) => set({ kind: e.target.value })}>
              <option value="manufacture">Discrete (assemble / fabricate)</option>
              <option value="process">Process / batch (recipe, formula)</option>
              <option value="kit">Kit</option>
            </select>
          </label>
          <label className="field">
            Makes (quantity per batch)
            <input type="number" min={0} step="any" value={f.quantity} disabled={!editable} onChange={(e) => set({ quantity: e.target.value })} />
          </label>
          <label className="field">
            Yield %
            <input type="number" min={1} max={100} step="any" value={f.yieldPct} disabled={!editable} onChange={(e) => set({ yieldPct: e.target.value })} />
          </label>
          <label className="check" style={{ alignSelf: 'end' }}>
            <input type="checkbox" checked={f.requiresQc} disabled={!editable} onChange={(e) => set({ requiresQc: e.target.checked })} /> Output needs a passing final quality check
          </label>
        </div>

        <h3 style={{ margin: '8px 0 0' }}>Components and by-products</h3>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Type</th>
                <th>Product</th>
                <th className="num">Qty</th>
                <th className="num">Scrap %</th>
                <th className="num">Cost share %</th>
                <th className="num">At op</th>
                {editable && <th />}
              </tr>
            </thead>
            <tbody>
              {f.lines.map((l, i) => {
                const setL = (p: Partial<BomLine>) => set({ lines: f.lines.map((x, k) => (k === i ? { ...x, ...p } : x)) });
                const info = data?.lines?.find((x: Json) => x.product_id === l.productId);
                return (
                  <tr key={i}>
                    <td>
                      <select value={l.kind} disabled={!editable} onChange={(e) => setL({ kind: e.target.value as BomLine['kind'] })} aria-label="Type">
                        <option value="component">Component</option>
                        <option value="byproduct">By-product</option>
                      </select>
                    </td>
                    <td>
                      {editable ? <ProductPick value={l.productId} onChange={(pid) => setL({ productId: pid })} /> : <>{info?.product}{info?.has_bom && <span className="chip" style={{ marginLeft: 6 }}>sub-assembly</span>}</>}
                    </td>
                    <td className="num">
                      <input type="number" min={0} step="any" style={{ width: 80 }} value={l.quantity} disabled={!editable} onChange={(e) => setL({ quantity: e.target.value })} aria-label="Quantity" />
                    </td>
                    <td className="num">
                      <input type="number" min={0} max={90} step="any" style={{ width: 70 }} value={l.scrapPct} disabled={!editable || l.kind === 'byproduct'} onChange={(e) => setL({ scrapPct: e.target.value })} aria-label="Scrap %" />
                    </td>
                    <td className="num">
                      <input type="number" min={0} max={99} step="any" style={{ width: 70 }} value={l.costSharePct} disabled={!editable || l.kind !== 'byproduct'} onChange={(e) => setL({ costSharePct: e.target.value })} aria-label="Cost share %" />
                    </td>
                    <td className="num">
                      <input type="number" min={1} style={{ width: 60 }} value={l.operationSeq} disabled={!editable} onChange={(e) => setL({ operationSeq: e.target.value })} aria-label="Operation" />
                    </td>
                    {editable && (
                      <td>
                        <button className="btn ghost sm" onClick={() => set({ lines: f.lines.filter((_, k) => k !== i) })} aria-label="Remove">
                          ✕
                        </button>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {editable && (
          <button className="btn ghost sm" onClick={() => set({ lines: [...f.lines, { kind: 'component', productId: '', quantity: '1', scrapPct: '', costSharePct: '', operationSeq: '' }] })}>
            + Line
          </button>
        )}

        <h3 style={{ margin: '8px 0 0' }}>Routing</h3>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th className="num">#</th>
                <th>Operation</th>
                <th>Work centre</th>
                <th className="num">Setup min</th>
                <th className="num">Min / unit</th>
                <th>Job work</th>
                {editable && <th />}
              </tr>
            </thead>
            <tbody>
              {f.ops.map((o, i) => {
                const setO = (p: Partial<BomOp>) => set({ ops: f.ops.map((x, k) => (k === i ? { ...x, ...p } : x)) });
                return (
                  <tr key={i}>
                    <td className="num">
                      <input type="number" min={1} style={{ width: 60 }} value={o.seq} disabled={!editable} onChange={(e) => setO({ seq: e.target.value })} aria-label="Sequence" />
                    </td>
                    <td>
                      <input value={o.name} disabled={!editable} onChange={(e) => setO({ name: e.target.value })} aria-label="Operation" />
                    </td>
                    <td>
                      <select value={o.workCenterId} disabled={!editable} onChange={(e) => setO({ workCenterId: e.target.value })} aria-label="Work centre">
                        <option value="">—</option>
                        {centers.data?.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.code} · {c.name}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="num">
                      <input type="number" min={0} step="any" style={{ width: 70 }} value={o.setupMinutes} disabled={!editable} onChange={(e) => setO({ setupMinutes: e.target.value })} aria-label="Setup minutes" />
                    </td>
                    <td className="num">
                      <input type="number" min={0} step="any" style={{ width: 70 }} value={o.runMinutes} disabled={!editable} onChange={(e) => setO({ runMinutes: e.target.value })} aria-label="Minutes per unit" />
                    </td>
                    <td>
                      <input type="checkbox" checked={o.subcontract} disabled={!editable} onChange={(e) => setO({ subcontract: e.target.checked })} aria-label="Done by a job worker" />
                    </td>
                    {editable && (
                      <td>
                        <button className="btn ghost sm" onClick={() => set({ ops: f.ops.filter((_, k) => k !== i) })} aria-label="Remove">
                          ✕
                        </button>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {editable && (
          <button className="btn ghost sm" onClick={() => set({ ops: [...f.ops, { seq: String((f.ops.length + 1) * 10), name: '', workCenterId: '', setupMinutes: '', runMinutes: '', subcontract: false }] })}>
            + Operation
          </button>
        )}

        {data?.cost && (
          <div className="kpis" style={{ margin: 0 }}>
            <Kpi label="Material per batch" value={money2(data.cost.material)} />
            <Kpi label="Operations per batch" value={money2(data.cost.operations)} />
            <Kpi label="Standard cost / unit" value={money2(data.cost.perUnit)} sub="Rolled up through sub-assemblies, after scrap, yield and by-products" />
          </div>
        )}
        {id && data?.status === 'active' && (
          <details>
            <summary>Everything needed (exploded through sub-assemblies)</summary>
            <label className="row small" style={{ margin: '6px 0' }}>
              For
              <input type="number" min={1} style={{ width: 90 }} value={explodeQty} onChange={(e) => setExplodeQty(e.target.value)} /> units
            </label>
            <table className="data">
              <tbody>
                {explode.data?.map((x) => (
                  <tr key={x.productId}>
                    <td style={{ paddingLeft: 8 + (x.level - 1) * 18 }}>{x.product}</td>
                    <td className="num">{x.qty}</td>
                    <td className="small muted">{x.make ? 'made' : 'bought'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        )}
      </Body>
    </Modal>
  );
}

/* ───────────────────────── work centres ───────────────────────── */

function Centers({ admin }: { admin: boolean }) {
  const { data } = useQuery({ queryKey: ['mfg', 'centers'], queryFn: () => get<Json[]>('/api/v1/mfg/work-centers') });
  const [edit, setEdit] = useState<Json | null>(null);
  const act = useAct([['mfg', 'centers']]);
  if (!data) return <Spinner />;
  return (
    <div className="stack">
      {admin && (
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button className="btn primary" onClick={() => setEdit({ code: '', name: '', hours_per_day: 8, days_per_week: 6, parallel_units: 1, cost_per_hour: 0, is_active: true })}>
            New work centre
          </button>
        </div>
      )}
      {!data.length ? (
        <Empty title="No work centres">A work centre is a machine, line or team. Its hourly cost is what routing time is charged at; its hours set capacity.</Empty>
      ) : (
        <table className="data">
          <thead>
            <tr>
              <th>Code</th>
              <th>Name</th>
              <th className="num">Hours / day</th>
              <th className="num">Days / week</th>
              <th className="num">Machines</th>
              <th className="num">Cost / hour</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {data.map((c) => (
              <tr key={c.id} className={c.is_active ? '' : 'muted'}>
                <td>{c.code}</td>
                <td>{c.name}</td>
                <td className="num">{c.hours_per_day}</td>
                <td className="num">{c.days_per_week}</td>
                <td className="num">{c.parallel_units}</td>
                <td className="num">{c.cost_per_hour == null ? '—' : money2(c.cost_per_hour)}</td>
                <td>
                  {admin && (
                    <button className="btn sm" onClick={() => setEdit(c)}>
                      Edit
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {edit && (
        <Modal
          title={edit.id ? 'Work centre' : 'New work centre'}
          onClose={() => setEdit(null)}
          footer={
            <button
              className="btn primary"
              onClick={async () => {
                const body = { code: edit.code, name: edit.name, hoursPerDay: Number(edit.hours_per_day), daysPerWeek: Number(edit.days_per_week), parallelUnits: Number(edit.parallel_units), costPerHour: Number(edit.cost_per_hour), isActive: !!edit.is_active };
                if (await act(() => (edit.id ? put(`/api/v1/mfg/work-centers/${edit.id}`, body) : post('/api/v1/mfg/work-centers', body)), 'Saved')) setEdit(null);
              }}
            >
              Save
            </button>
          }
        >
          <div className="modal-body grid2">
            {(
              [
                ['code', 'Code', 'text'],
                ['name', 'Name', 'text'],
                ['hours_per_day', 'Hours per day', 'number'],
                ['days_per_week', 'Days per week', 'number'],
                ['parallel_units', 'Machines / people in parallel', 'number'],
                ['cost_per_hour', 'Cost per hour (labour + overhead)', 'number'],
              ] as const
            ).map(([k, l, t]) => (
              <label key={k} className="field">
                {l}
                <input type={t} value={edit[k] ?? ''} onChange={(e) => setEdit({ ...edit, [k]: e.target.value })} />
              </label>
            ))}
            <label className="check">
              <input type="checkbox" checked={!!edit.is_active} onChange={(e) => setEdit({ ...edit, is_active: e.target.checked })} /> Active
            </label>
          </div>
        </Modal>
      )}
    </div>
  );
}

/* ───────────────────────── MRP ───────────────────────── */

function Mrp() {
  const { data, isLoading } = useQuery({ queryKey: ['mfg', 'mrp'], queryFn: () => get<Json | null>('/api/v1/mfg/mrp') });
  const act = useAct([['mfg', 'mrp']]);
  const nav = useNavigate();
  const [opts, setOpts] = useState({ horizonDays: '30', includeReorder: true });
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [show, setShow] = useState<'actions' | 'all'>('actions');
  if (isLoading) return <Spinner />;
  const lines = ((data?.lines ?? []) as Json[]).filter((l) => show === 'all' || l.action !== 'none');
  const toggle = (id: string) => {
    const s = new Set(sel);
    if (s.has(id)) s.delete(id);
    else s.add(id);
    setSel(s);
  };
  return (
    <div className="stack">
      <div className="row" style={{ flexWrap: 'wrap', gap: 10 }}>
        <label className="row small">
          Look ahead
          <input type="number" min={1} max={365} style={{ width: 70 }} value={opts.horizonDays} onChange={(e) => setOpts({ ...opts, horizonDays: e.target.value })} /> days
        </label>
        <label className="row small">
          <input type="checkbox" checked={opts.includeReorder} onChange={(e) => setOpts({ ...opts, includeReorder: e.target.checked })} /> Top up to reorder levels
        </label>
        <button className="btn primary" onClick={() => act(() => post('/api/v1/mfg/mrp/run', { horizonDays: Number(opts.horizonDays) || 30, includeReorder: opts.includeReorder }), 'Plan ready').then(() => setSel(new Set()))}>
          Run MRP
        </button>
        {data && <span className="small muted">Last run {new Date(data.run.created_at).toLocaleString()} · {data.run.horizon_days} days</span>}
      </div>
      {!data ? (
        <Empty title="No plan yet">MRP nets open sales orders and work order material against stock, open purchase orders and running work orders, level by level through your bills of materials, and suggests what to buy and make, and by when.</Empty>
      ) : (
        <>
          <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap' }}>
            <div className="tabs" role="tablist" style={{ border: 0 }}>
              <button role="tab" aria-selected={show === 'actions'} onClick={() => setShow('actions')}>
                Suggestions
              </button>
              <button role="tab" aria-selected={show === 'all'} onClick={() => setShow('all')}>
                All items
              </button>
            </div>
            {sel.size > 0 && (
              <div className="row">
                <button
                  className="btn primary"
                  onClick={async () => {
                    const r = (await act(() => post<{ created: Json[] }>(`/api/v1/mfg/mrp/${data.run.id}/act`, { lineIds: [...sel] }), 'Draft orders created')) as { created?: Json[] } | null;
                    setSel(new Set());
                    if (r?.created?.length === 1) nav(`/o/${r.created[0]!.object}/${r.created[0]!.id}`);
                  }}
                >
                  Create orders ({sel.size})
                </button>
                <button className="btn ghost" onClick={() => act(() => post(`/api/v1/mfg/mrp/${data.run.id}/ignore`, { lineIds: [...sel] }), 'Ignored').then(() => setSel(new Set()))}>
                  Ignore
                </button>
              </div>
            )}
          </div>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th />
                  <th>Item</th>
                  <th className="num">Level</th>
                  <th className="num">Needed</th>
                  <th className="num">On hand</th>
                  <th className="num">On order</th>
                  <th className="num">Safety</th>
                  <th className="num">Short</th>
                  <th className="num">Suggest</th>
                  <th>Action</th>
                  <th>Order by</th>
                  <th>Need by</th>
                  <th>Vendor</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((l) => (
                  <tr key={l.id} className={l.status !== 'open' ? 'muted' : ''}>
                    <td>{l.status === 'open' && l.action !== 'none' && <input type="checkbox" checked={sel.has(l.id)} onChange={() => toggle(l.id)} aria-label={`Select ${l.product}`} />}</td>
                    <td title={(l.sources as Json[]).map((s) => `${s.source}: ${s.qty}`).join('\n')}>
                      <Link to={`/o/product/${l.product_id}`}>{l.product}</Link>
                    </td>
                    <td className="num">{l.level}</td>
                    <td className="num">{l.gross_req}</td>
                    <td className="num">{l.on_hand}</td>
                    <td className="num">{l.on_order}</td>
                    <td className="num">{l.safety_stock || ''}</td>
                    <td className={`num${l.net_req > 0 ? ' tone-bad' : ''}`}>{l.net_req || ''}</td>
                    <td className="num">
                      <b>{l.suggested_qty || ''}</b>
                    </td>
                    <td>
                      {l.status === 'done' && l.ref_id ? (
                        <Link className="chip good" to={`/o/${l.ref_object}/${l.ref_id}`}>
                          {l.ref_object === 'purchase_order' ? 'PO made' : 'WO made'}
                        </Link>
                      ) : l.status === 'ignored' ? (
                        <span className="chip">ignored</span>
                      ) : l.action === 'none' ? (
                        <span className="muted small">covered</span>
                      ) : (
                        <span className={`chip ${l.action === 'make' ? 'info' : 'warn'}`}>{l.action}</span>
                      )}
                    </td>
                    <td className={l.order_by < today() && l.status === 'open' && l.action !== 'none' ? 'tone-bad' : ''}>{date(l.order_by)}</td>
                    <td>{date(l.need_by)}</td>
                    <td className="small">{l.action === 'buy' ? l.vendor ?? <span className="tone-bad">set a preferred vendor</span> : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="small muted">Buy lines become draft purchase orders, one per vendor; make lines become draft work orders. Lead time, minimum order quantity, safety stock and the preferred vendor come from each product.</p>
        </>
      )}
    </div>
  );
}

/* ───────────────────────── lots ───────────────────────── */

function Lots() {
  const [f, setF] = useState({ productId: '', expiring: '', all: false });
  const params = new URLSearchParams({ ...(f.productId ? { productId: f.productId } : {}), ...(f.expiring ? { expiringDays: f.expiring } : {}), ...(f.all ? { all: '1' } : {}) });
  const { data } = useQuery({ queryKey: ['mfg', 'lots', params.toString()], queryFn: () => get<Json[]>(`/api/v1/mfg/lots?${params}`) });
  const [trace, setTrace] = useState<string | null>(null);
  const [reg, setReg] = useState(false);
  const [qc, setQc] = useState<Json | null>(null);
  const act = useAct([['mfg', 'lots']]);
  return (
    <div className="stack">
      <div className="row" style={{ flexWrap: 'wrap', gap: 10, alignItems: 'end' }}>
        <ProductPick value={f.productId} onChange={(id) => setF({ ...f, productId: id })} />
        <select value={f.expiring} onChange={(e) => setF({ ...f, expiring: e.target.value })} style={{ width: 'auto' }} aria-label="Expiry">
          <option value="">Any expiry</option>
          <option value="0">Expired</option>
          <option value="30">Expiring in 30 days</option>
          <option value="90">Expiring in 90 days</option>
        </select>
        <label className="row small">
          <input type="checkbox" checked={f.all} onChange={(e) => setF({ ...f, all: e.target.checked })} /> Include used up
        </label>
        <span style={{ flex: 1 }} />
        <button className="btn" onClick={() => setReg(true)}>
          Register a batch
        </button>
      </div>
      {!data ? (
        <Spinner />
      ) : !data.length ? (
        <Empty title="No batches">Batches are created when batch-tracked products are produced or received back from job work, or registered against stock you hold.</Empty>
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Batch</th>
                <th>Product</th>
                <th>Warehouse</th>
                <th className="num">On hand</th>
                <th>Made</th>
                <th>Expires</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.map((l) => (
                <tr key={l.id}>
                  <td>
                    <b>{l.lot_number}</b>
                    <div className="small muted">{l.source}</div>
                  </td>
                  <td>{l.product}</td>
                  <td>{l.warehouse}</td>
                  <td className="num">{l.on_hand}</td>
                  <td>{date(l.mfg_date)}</td>
                  <td className={l.days_left != null && l.days_left <= 30 ? 'tone-bad' : ''}>
                    {date(l.expiry_date)}
                    {l.days_left != null && <div className="small">{l.days_left < 0 ? 'expired' : `${l.days_left} days`}</div>}
                  </td>
                  <td>
                    <select value={l.status} onChange={(e) => act(() => post(`/api/v1/mfg/lots/${l.id}/status`, { status: e.target.value }), 'Updated')} style={{ width: 'auto' }} aria-label="Status">
                      <option value="available">Available</option>
                      <option value="quarantine">Quarantine</option>
                      <option value="rejected">Rejected</option>
                    </select>
                  </td>
                  <td className="row" style={{ gap: 4 }}>
                    <button className="btn sm" onClick={() => setTrace(l.id)}>
                      Trace
                    </button>
                    <button className="btn sm" onClick={() => setQc(l)}>
                      Inspect
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {trace && <TraceModal id={trace} onClose={() => setTrace(null)} />}
      {reg && <RegisterLot onClose={() => setReg(false)} />}
      {qc && <QcModal productId={qc.product_id} lotId={qc.id} onClose={() => setQc(null)} act={act} />}
    </div>
  );
}

function TraceModal({ id, onClose }: { id: string; onClose: () => void }) {
  const { data } = useQuery({ queryKey: ['mfg', 'trace', id], queryFn: () => get<Json>(`/api/v1/mfg/lots/${id}/trace`) });
  const list = (rows: Json[], empty: string) =>
    !rows.length ? (
      <p className="muted small">{empty}</p>
    ) : (
      <table className="data">
        <tbody>
          {rows.map((r) => (
            <tr key={`${r.depth}-${r.id}`}>
              <td style={{ paddingLeft: 8 + (r.depth - 1) * 18 }}>
                <b>{r.lot_number}</b> · {r.product}
              </td>
              <td className="small">{r.work_order ?? ''}</td>
              <td className="small">{date(r.expiry_date)}</td>
              <td>
                <span className={`chip ${r.status === 'available' ? '' : 'bad'}`}>{r.status}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  return (
    <Modal title={data ? `Batch ${data.lot.lot_number} · ${data.lot.product}` : 'Batch'} onClose={onClose} wide>
      <Body>
        {!data ? (
          <Spinner />
        ) : (
          <>
            <h3 style={{ margin: 0 }}>Made from (backward)</h3>
            {list(data.inputs, 'No recorded inputs (bought or registered stock).')}
            <h3 style={{ margin: '8px 0 0' }}>Went into (forward)</h3>
            {list(data.usedIn, 'Not used in production yet.')}
          </>
        )}
      </Body>
    </Modal>
  );
}

function RegisterLot({ onClose }: { onClose: () => void }) {
  const wh = useQuery({ queryKey: ['warehouses'], queryFn: () => get<{ items: Json[] }>('/api/v1/warehouses') });
  const act = useAct([['mfg', 'lots']]);
  const [f, setF] = useState({ productId: '', warehouseId: '', lotNumber: '', qty: '', mfgDate: '', expiryDate: '' });
  const warehouseId = f.warehouseId || wh.data?.items[0]?.id || '';
  return (
    <Modal
      title="Register a batch"
      onClose={onClose}
      footer={
        <button
          className="btn primary"
          onClick={async () => (await act(() => post('/api/v1/mfg/lots', { productId: f.productId, warehouseId, lotNumber: f.lotNumber, qty: Number(f.qty), mfgDate: f.mfgDate || null, expiryDate: f.expiryDate || null }), 'Batch registered')) && onClose()}
        >
          Register
        </button>
      }
    >
      <div className="modal-body grid2">
        <label className="field wide">
          Product
          <ProductPick value={f.productId} onChange={(id) => setF({ ...f, productId: id })} />
        </label>
        <label className="field">
          Warehouse
          <select value={warehouseId} onChange={(e) => setF({ ...f, warehouseId: e.target.value })}>
            {wh.data?.items.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          Batch number
          <input value={f.lotNumber} onChange={(e) => setF({ ...f, lotNumber: e.target.value })} />
        </label>
        <label className="field">
          Quantity
          <input type="number" min={0} step="any" value={f.qty} onChange={(e) => setF({ ...f, qty: e.target.value })} />
        </label>
        <label className="field">
          Manufactured on
          <input type="date" value={f.mfgDate} onChange={(e) => setF({ ...f, mfgDate: e.target.value })} />
        </label>
        <label className="field">
          Expires on
          <input type="date" value={f.expiryDate} onChange={(e) => setF({ ...f, expiryDate: e.target.value })} />
        </label>
        <p className="small muted wide">For stock already received (purchase or opening stock). The product becomes batch-tracked; batches can never add up to more than the stock on hand.</p>
      </div>
    </Modal>
  );
}

/* ───────────────────────── quality ───────────────────────── */

function Quality() {
  const [r, setR] = useState({ from: monthStart(), to: today(), result: '' });
  const params = new URLSearchParams({ from: r.from, to: r.to, ...(r.result ? { result: r.result } : {}) });
  const { data } = useQuery({ queryKey: ['mfg', 'qc', params.toString()], queryFn: () => get<Json[]>(`/api/v1/mfg/quality?${params}`) });
  const [add, setAdd] = useState(false);
  const act = useAct([['mfg', 'qc']]);
  return (
    <div className="stack">
      <div className="row" style={{ flexWrap: 'wrap', gap: 10 }}>
        <input type="date" value={r.from} onChange={(e) => setR({ ...r, from: e.target.value })} style={{ width: 'auto' }} aria-label="From" />
        <input type="date" value={r.to} onChange={(e) => setR({ ...r, to: e.target.value })} style={{ width: 'auto' }} aria-label="To" />
        <select value={r.result} onChange={(e) => setR({ ...r, result: e.target.value })} style={{ width: 'auto' }} aria-label="Result">
          <option value="">All results</option>
          <option value="pass">Passed</option>
          <option value="fail">Failed</option>
          <option value="hold">On hold</option>
        </select>
        <span style={{ flex: 1 }} />
        <button className="btn primary" onClick={() => setAdd(true)}>
          Record inspection
        </button>
      </div>
      {!data ? (
        <Spinner />
      ) : !data.length ? (
        <Empty title="No inspections in this period">Record incoming inspections of purchased goods, in-process checks and final inspections of output.</Empty>
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>#</th>
                <th>Date</th>
                <th>Stage</th>
                <th>Product</th>
                <th>Work order / batch</th>
                <th className="num">Inspected</th>
                <th className="num">Rejected</th>
                <th>Result</th>
                <th>Inspector</th>
              </tr>
            </thead>
            <tbody>
              {data.map((q) => (
                <tr key={q.id} title={(q.parameters as Json[]).map((p) => `${p.name}: ${p.value ?? ''} (spec ${p.spec ?? '—'}) ${p.ok === false ? '✗' : '✓'}`).join('\n')}>
                  <td>QC-{q.qc_number}</td>
                  <td>{date(q.created_at)}</td>
                  <td>{q.stage.replace('_', ' ')}</td>
                  <td>{q.product}</td>
                  <td>
                    {q.work_order_id && <Link to={`/o/work_order/${q.work_order_id}`}>{q.wo_number}</Link>} {q.lot_number}
                  </td>
                  <td className="num">{q.qty_inspected}</td>
                  <td className="num">{q.qty_rejected}</td>
                  <td>
                    <span className={`chip ${q.result === 'pass' ? 'good' : q.result === 'fail' ? 'bad' : 'warn'}`}>{q.result}</span>
                  </td>
                  <td className="small">{q.inspector}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {add && <QcModal onClose={() => setAdd(false)} act={act} />}
    </div>
  );
}

/* ───────────────────────── job work / ITC-04 ───────────────────────── */

function JobWorkReport() {
  const [r, setR] = useState({ from: monthStart(), to: today() });
  const { data, error } = useQuery({ queryKey: ['mfg', 'itc04', r], queryFn: () => get<Json>(`/api/v1/mfg/reports/itc04?from=${r.from}&to=${r.to}`), retry: false });
  const csv = () => {
    if (!data) return;
    const rows = [
      ['Section', 'Challan', 'Date', 'Job worker', 'GSTIN', 'Product', 'HSN', 'Unit', 'Qty', 'Taxable value', 'GST %'],
      ...(data.sent as Json[]).map((s) => ['Sent', s.challan_number, s.log_date, s.job_worker, s.gstin ?? '', s.product, s.hsn_sac ?? '', s.unit ?? '', s.qty, s.taxable, s.tax_rate]),
      ...(data.received as Json[]).map((s) => ['Received', `${s.original_challan} / ${s.job_worker_challan ?? ''}`, s.log_date, s.job_worker, s.gstin ?? '', s.product, '', '', s.qty, s.value, '']),
    ];
    // formula-safe: a cell starting with = + - @ (or tab / CR) is prefixed so spreadsheets treat it as text
    const cell = (c: unknown) => {
      const v = String(c ?? '');
      const safe = typeof c === 'number' || !/^[=+\-@\t\r]/.test(v) ? v : `'${v}`;
      return `"${safe.replace(/"/g, '""')}"`;
    };
    const blob = new Blob([rows.map((x) => x.map(cell).join(',')).join('\n')], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `ITC-04_${r.from}_${r.to}.csv`;
    a.click();
  };
  return (
    <div className="stack">
      <div className="row" style={{ flexWrap: 'wrap', gap: 10 }}>
        <input type="date" value={r.from} onChange={(e) => setR({ ...r, from: e.target.value })} style={{ width: 'auto' }} aria-label="From" />
        <input type="date" value={r.to} onChange={(e) => setR({ ...r, to: e.target.value })} style={{ width: 'auto' }} aria-label="To" />
        <span style={{ flex: 1 }} />
        <Link className="btn" to="/o/job_work">
          All job work
        </Link>
        {data && (
          <button className="btn" onClick={csv}>
            Download CSV
          </button>
        )}
      </div>
      {error ? (
        <Empty title="ITC-04 needs the manufacturing, books or billing permission" />
      ) : !data ? (
        <Spinner />
      ) : (
        <>
          {data.nearingOneYear.length > 0 && (
            <div className="notice">
              {data.nearingOneYear.length} item(s) have been with job workers for over 300 days. Inputs not back within a year are treated as supplied on the day they were sent (rule 45).
            </div>
          )}
          <h3 style={{ margin: 0 }}>Sent to job workers</h3>
          <ItcTable rows={data.sent} cols={[['challan_number', 'Challan'], ['log_date', 'Date'], ['job_worker', 'Job worker'], ['gstin', 'GSTIN'], ['product', 'Goods'], ['hsn_sac', 'HSN'], ['qty', 'Qty'], ['taxable', 'Value']]} />
          <h3 style={{ margin: '8px 0 0' }}>Received back</h3>
          <ItcTable rows={data.received} cols={[['original_challan', 'Our challan'], ['job_worker_challan', 'Their challan'], ['log_date', 'Date'], ['job_worker', 'Job worker'], ['product', 'Goods'], ['qty', 'Qty'], ['value', 'Value']]} />
          {data.nearingOneYear.length > 0 && (
            <>
              <h3 style={{ margin: '8px 0 0' }}>Out for more than 300 days</h3>
              <ItcTable rows={data.nearingOneYear} cols={[['challan_number', 'Challan'], ['sent_date', 'Sent'], ['job_worker', 'Job worker'], ['product', 'Goods'], ['pending_qty', 'Pending'], ['pending_value', 'Value'], ['days_out', 'Days']]} />
            </>
          )}
        </>
      )}
    </div>
  );
}

function ItcTable({ rows, cols }: { rows: Json[]; cols: [string, string][] }) {
  if (!rows.length) return <p className="muted small">None in this period.</p>;
  const isNum = (k: string) => ['qty', 'taxable', 'value', 'pending_qty', 'pending_value', 'days_out'].includes(k);
  return (
    <div className="table-wrap">
      <table className="data">
        <thead>
          <tr>
            {cols.map(([k, l]) => (
              <th key={k} className={isNum(k) ? 'num' : ''}>
                {l}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {cols.map(([k]) => (
                <td key={k} className={isNum(k) ? 'num' : ''}>
                  {k.endsWith('date') ? date(r[k]) : ['taxable', 'value', 'pending_value'].includes(k) ? money2(r[k]) : r[k] ?? ''}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ───────────────────────── reports ───────────────────────── */

function Reports() {
  const [r, setR] = useState({ from: monthStart(), to: today() });
  const load = useQuery({ queryKey: ['mfg', 'load'], queryFn: () => get<Json[]>('/api/v1/mfg/reports/load?weeks=8') });
  const prod = useQuery({ queryKey: ['mfg', 'production', r], queryFn: () => get<Json[]>(`/api/v1/mfg/reports/production?from=${r.from}&to=${r.to}`) });
  const centers = [...new Map((load.data ?? []).map((x) => [x.id, x])).values()];
  const weeks = [...new Set((load.data ?? []).filter((x) => x.load > 0).map((x) => x.week as string))].sort();
  return (
    <div className="stack">
      <h3 style={{ margin: 0 }}>Work centre load (hours of open work against weekly capacity)</h3>
      {!load.data ? (
        <Spinner />
      ) : !weeks.length ? (
        <p className="muted">No open operations on released work orders.</p>
      ) : (
        <>
          <BarChart
            data={{ categories: weeks.map((w) => date(w)), series: centers.map((c) => ({ label: c.code, values: weeks.map((w) => Math.round(((load.data ?? []).find((x) => x.id === c.id && x.week === w)?.load ?? 0) / 6) / 10) })) }}
            stacked={false}
            fmt={(n) => `${n} h`}
          />
          <table className="data">
            <thead>
              <tr>
                <th>Work centre</th>
                <th className="num">Capacity / week</th>
                {weeks.map((w) => (
                  <th key={w} className="num">
                    {date(w)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {centers.map((c) => (
                <tr key={c.id}>
                  <td>{c.name}</td>
                  <td className="num">{Math.round(c.capacity / 60)} h</td>
                  {weeks.map((w) => {
                    const m = (load.data ?? []).find((x) => x.id === c.id && x.week === w)?.load ?? 0;
                    const pct = c.capacity ? Math.round((m / c.capacity) * 100) : 0;
                    return (
                      <td key={w} className={`num${pct > 100 ? ' tone-bad' : ''}`}>
                        {m ? `${Math.round(m / 6) / 10} h · ${pct}%` : ''}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      <div className="row" style={{ flexWrap: 'wrap', gap: 10, marginTop: 10 }}>
        <h3 style={{ margin: 0, flex: 1 }}>Production cost: actual against standard</h3>
        <input type="date" value={r.from} onChange={(e) => setR({ ...r, from: e.target.value })} style={{ width: 'auto' }} aria-label="From" />
        <input type="date" value={r.to} onChange={(e) => setR({ ...r, to: e.target.value })} style={{ width: 'auto' }} aria-label="To" />
      </div>
      {!prod.data ? (
        <Spinner />
      ) : !prod.data.length ? (
        <p className="muted">No orders finished in this period.</p>
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Order</th>
                <th>Product</th>
                <th className="num">Made</th>
                <th className="num">Scrap %</th>
                <th className="num">Material</th>
                <th className="num">Operations</th>
                <th className="num">Standard / unit</th>
                <th className="num">Actual / unit</th>
                <th className="num">Variance</th>
              </tr>
            </thead>
            <tbody>
              {prod.data.map((p) => (
                <tr key={p.id}>
                  <td>
                    <Link to={`/o/work_order/${p.id}`}>{p.wo_number ?? p.name}</Link>
                  </td>
                  <td>{p.product}</td>
                  <td className="num">{p.produced}</td>
                  <td className={`num${p.scrap_pct > 5 ? ' tone-bad' : ''}`}>{p.scrap_pct}%</td>
                  <td className="num">{p.material == null ? '—' : moneyShort(p.material)}</td>
                  <td className="num">{p.operations == null ? '—' : moneyShort(p.operations)}</td>
                  <td className="num">{money2(p.standard_unit_cost)}</td>
                  <td className={`num${p.actual_unit_cost && p.standard_unit_cost && p.actual_unit_cost > p.standard_unit_cost * 1.05 ? ' tone-bad' : ''}`}>{money2(p.actual_unit_cost)}</td>
                  <td className="num">{money2(p.variance)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
