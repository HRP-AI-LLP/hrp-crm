/** Work order and job work panels shown on their record pages, plus shared manufacturing pickers. */
import { useQuery } from '@tanstack/react-query';
import { type ReactNode, useState } from 'react';
import { Link } from 'react-router-dom';
import { hasAdmin, objectPerm, type RecordDto } from '@synapse/shared';
import { useAuth } from '../../lib/auth';
import { useAct } from '../books/BookPanels';
import { Modal, Spinner } from '../ui';
import { get, post, put } from '../../lib/api';
import { date, dateTime, money2 } from '../../lib/format';

type Json = Record<string, any>;
const today = () => new Date().toISOString().slice(0, 10);
const n = (v: unknown) => Math.round(Number(v ?? 0) * 1000) / 1000;

export const WO_STATUS_CLS: Record<string, string> = { draft: '', released: 'info', in_progress: 'warn', completed: 'good', closed: '', cancelled: 'bad' };

/** Searchable product select (goods only). */
export function ProductPick({ value, onChange, label = 'Product', placeholder = 'Search products…' }: { value: string; onChange: (id: string, p?: Json) => void; label?: string; placeholder?: string }) {
  const [q, setQ] = useState('');
  const { data } = useQuery({ queryKey: ['mfg', 'product-pick', q], queryFn: () => get<{ items: RecordDto[] }>(`/api/v1/records/product?limit=50${q ? `&q=${encodeURIComponent(q)}` : ''}`), staleTime: 30_000 });
  const { data: current } = useQuery({ queryKey: ['record', 'product', value], queryFn: () => get<RecordDto>(`/api/v1/records/product/${value}`), enabled: !!value, retry: false });
  const items = (data?.items ?? []).filter((i) => (i as Json).product_type !== 'service');
  return (
    <div className="stack" style={{ gap: 4, minWidth: 180 }}>
      <input placeholder={placeholder} value={q} onChange={(e) => setQ(e.target.value)} aria-label={`Search ${label.toLowerCase()}`} />
      <select value={value} onChange={(e) => onChange(e.target.value, items.find((i) => i.id === e.target.value) as Json | undefined)} aria-label={label}>
        <option value="">—</option>
        {current && !items.some((i) => i.id === current.id) && <option value={current.id}>{current.title}</option>}
        {items.map((i) => (
          <option key={i.id} value={i.id}>
            {i.title}
            {(i as Json).sku ? ` · ${(i as Json).sku}` : ''}
          </option>
        ))}
      </select>
    </div>
  );
}

const Body = ({ children }: { children: ReactNode }) => (
  <div style={{ padding: '18px 20px', overflow: 'auto', display: 'grid', gap: 12, alignContent: 'start', gridAutoRows: 'max-content' }}>
    {children}
  </div>
);

function Cost({ label, v, tone }: { label: string; v: unknown; tone?: string }) {
  return (
    <div className="kpi panel" style={{ padding: '8px 14px' }}>
      <div className="l">{label}</div>
      <div className={`v${tone ? ` tone-${tone}` : ''}`} style={{ fontSize: 18 }}>
        {v == null ? '—' : money2(v)}
      </div>
    </div>
  );
}

/* ───────────────────────── work order ───────────────────────── */

export function WorkOrderPanel({ id, canEdit }: { id: string; canEdit: boolean }) {
  const key = ['mfg', 'wo', id];
  const { data } = useQuery({ queryKey: key, queryFn: () => get<Json>(`/api/v1/mfg/work-orders/${id}`) });
  const act = useAct([key, ['record', 'work_order', id], ['mfg', 'overview']]);
  const { me } = useAuth();
  const plan = canEdit && !!me && (hasAdmin(me.permissions, 'manufacturing') || objectPerm(me.permissions, 'work_order').create);
  const [issue, setIssue] = useState<Record<string, string>>({});
  const [produce, setProduce] = useState<boolean>(false);
  const [op, setOp] = useState<Json | null>(null);
  const [qc, setQc] = useState(false);
  const [ret, setRet] = useState(false);
  if (!data) return <Spinner />;
  const w = data.workOrder;
  const live = ['released', 'in_progress', 'completed'].includes(w.status);
  const left = n(w.quantity - w.produced_qty - w.scrapped_qty);
  const base = `/api/v1/mfg/work-orders/${id}`;
  const issueItems = Object.entries(issue)
    .map(([productId, q]) => ({ productId, qty: Number(q) }))
    .filter((x) => x.qty > 0);
  return (
    <section className="panel" style={{ marginBottom: 14 }}>
      <div className="panel-head">
        <h2>Production</h2>
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <span className={`chip ${WO_STATUS_CLS[w.status] ?? ''}`}>{w.status.replace('_', ' ')}</span>
          {plan && w.status === 'draft' && (
            <button className="btn primary sm" onClick={() => act(() => post(`${base}/release`), 'Released: materials and routing are set from the bill of materials')}>
              Release
            </button>
          )}
          {canEdit && ['released', 'in_progress'].includes(w.status) && (
            <>
              <button className="btn sm" onClick={() => act(() => post(`${base}/issue`, { remaining: true }), 'Remaining material issued')}>
                Issue all remaining
              </button>
              <button className="btn primary sm" onClick={() => setProduce(true)}>
                Record output
              </button>
            </>
          )}
          {canEdit && live && (
            <button className="btn sm" onClick={() => setQc(true)}>
              Quality check
            </button>
          )}
          {canEdit && live && (
            <button className="btn sm" onClick={() => setRet(true)}>
              Return material
            </button>
          )}
          {plan && ['completed', 'in_progress'].includes(w.status) && w.produced_qty > 0 && (
            <button className="btn sm" onClick={() => confirm('Close the order? What is left in WIP is booked as a variance.') && act(() => post(`${base}/close`), 'Closed')}>
              Close
            </button>
          )}
          {plan && ['draft', 'released', 'in_progress'].includes(w.status) && (
            <button className="btn ghost sm" onClick={() => confirm('Cancel this work order?') && act(() => post(`${base}/cancel`), 'Cancelled')}>
              Cancel
            </button>
          )}
        </div>
      </div>
      <div className="panel-body stack">
        <div className="row small muted" style={{ flexWrap: 'wrap', gap: 16 }}>
          <span>
            Making <b>{w.quantity}</b> {data.product?.unit ?? ''} of {data.product ? <Link to={`/o/product/${data.product.id}`}>{data.product.name}</Link> : '—'}
          </span>
          <span>
            Produced <b>{w.produced_qty}</b> · scrap <b>{w.scrapped_qty}</b> · left <b>{left}</b>
          </span>
          {data.bom && (
            <span>
              BOM: {data.bom.name} v{data.bom.version}
              {data.bom.requires_qc ? ' · final QC required' : ''}
            </span>
          )}
          {w.planned_end && <span>Due {date(w.planned_end)}</span>}
        </div>
        {data.costs && (
          <div className="kpis" style={{ margin: 0 }}>
            <Cost label="Material" v={data.costs.material} />
            <Cost label="Labour & overhead" v={data.costs.operations} />
            <Cost label="In WIP now" v={data.costs.wip} />
            <Cost label="Standard / unit" v={data.costs.standardPerUnit} />
            <Cost label="Actual / unit" v={data.costs.actualPerUnit} tone={data.costs.actualPerUnit && data.costs.standardPerUnit && data.costs.actualPerUnit > data.costs.standardPerUnit * 1.05 ? 'bad' : undefined} />
            {w.status === 'closed' && <Cost label="Variance" v={data.costs.variance} tone={data.costs.variance > 0 ? 'bad' : 'good'} />}
          </div>
        )}
        <h3 style={{ margin: '6px 0 0' }}>Materials</h3>
        {!data.materials.length ? (
          <p className="muted small">{w.status === 'draft' ? 'Release the order to list its materials.' : 'No materials.'}</p>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Component</th>
                  <th className="num">Required</th>
                  <th className="num">Issued</th>
                  <th className="num">Available</th>
                  <th className="num">Value</th>
                  {canEdit && ['released', 'in_progress'].includes(w.status) && <th className="num">Issue now</th>}
                </tr>
              </thead>
              <tbody>
                {data.materials.map((m: Json) => (
                  <tr key={m.id}>
                    <td>
                      <Link to={`/o/product/${m.product_id}`}>{m.product}</Link>
                      {m.batch_tracked && <span className="chip" style={{ marginLeft: 6 }}>lots</span>}
                      {m.operation_seq != null && <span className="muted small"> · op {m.operation_seq}</span>}
                    </td>
                    <td className="num">{m.required_qty}</td>
                    <td className={`num${m.issued_qty + 1e-9 < m.required_qty ? '' : ' tone-good'}`}>{m.issued_qty}</td>
                    <td className={`num${m.available < m.required_qty - m.issued_qty ? ' tone-bad' : ''}`}>{m.available}</td>
                    <td className="num">{m.issued_value == null ? '—' : money2(m.issued_value)}</td>
                    {canEdit && ['released', 'in_progress'].includes(w.status) && (
                      <td className="num">
                        <input type="number" min={0} step="any" style={{ width: 90 }} value={issue[m.product_id] ?? ''} onChange={(e) => setIssue({ ...issue, [m.product_id]: e.target.value })} aria-label={`Issue ${m.product}`} />
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {issueItems.length > 0 && (
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <button className="btn primary sm" onClick={async () => (await act(() => post(`${base}/issue`, { items: issueItems }), 'Material issued')) && setIssue({})}>
              Issue {issueItems.length} item(s)
            </button>
          </div>
        )}

        <h3 style={{ margin: '6px 0 0' }}>Operations</h3>
        {!data.operations.length ? (
          <p className="muted small">No routing.</p>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Operation</th>
                  <th>Work centre</th>
                  <th className="num">Planned min</th>
                  <th className="num">Actual min</th>
                  <th className="num">Done</th>
                  <th className="num">Absorbed</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.operations.map((o: Json) => (
                  <tr key={o.id}>
                    <td>{o.seq}</td>
                    <td>
                      {o.name}
                      {o.subcontract && <span className="chip" style={{ marginLeft: 6 }}>job work</span>}
                    </td>
                    <td>{o.work_center ?? '—'}</td>
                    <td className="num">{o.planned_minutes}</td>
                    <td className={`num${o.actual_minutes > o.planned_minutes * 1.1 ? ' tone-bad' : ''}`}>{o.actual_minutes}</td>
                    <td className="num">{o.qty_done}</td>
                    <td className="num">{o.absorbed_cost == null ? '—' : money2(o.absorbed_cost)}</td>
                    <td>
                      <span className={`chip ${o.status === 'done' ? 'good' : o.status === 'pending' ? '' : 'warn'}`}>{o.status.replace('_', ' ')}</span>
                      {o.operator && <div className="small muted">{o.operator}</div>}
                    </td>
                    <td>
                      {canEdit && ['released', 'in_progress'].includes(w.status) && o.status !== 'done' && (
                        <button className="btn sm" onClick={() => setOp(o)}>
                          Log time
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {data.qc.length > 0 && (
          <>
            <h3 style={{ margin: '6px 0 0' }}>Quality checks</h3>
            <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
              {data.qc.map((q: Json) => (
                <span key={q.id} className={`chip ${q.result === 'pass' ? 'good' : q.result === 'fail' ? 'bad' : 'warn'}`}>
                  QC-{q.qc_number} · {q.stage.replace('_', ' ')} · {q.result} · {q.qty_inspected - q.qty_rejected}/{q.qty_inspected} ok
                </span>
              ))}
            </div>
          </>
        )}

        <details>
          <summary className="small">Production log ({data.logs.length})</summary>
          <div className="table-wrap" style={{ marginTop: 6 }}>
            <table className="data">
              <tbody>
                {data.logs.map((l: Json) => (
                  <tr key={l.id}>
                    <td className="small">{dateTime(l.created_at)}</td>
                    <td>{l.kind}</td>
                    <td>{l.product ?? l.note ?? ''}</td>
                    <td className="num">{l.kind === 'operation' ? `${l.minutes} min` : l.quantity}</td>
                    <td>{l.lot_number ?? ''}</td>
                    <td className="num">{l.value == null ? '' : money2(l.value)}</td>
                    <td className="small muted">{l.by}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      </div>

      {produce && <ProduceModal base={base} left={left} lotDefault={w.lot_number} batch={!!data.product?.batch_tracked} onClose={() => setProduce(false)} act={act} />}
      {op && <OperationModal base={base} op={op} onClose={() => setOp(null)} act={act} />}
      {qc && <QcModal workOrderId={id} productId={data.product?.id} onClose={() => setQc(false)} act={act} />}
      {ret && <ReturnModal base={base} materials={data.materials.filter((m: Json) => m.issued_qty > 0)} onClose={() => setRet(false)} act={act} />}
    </section>
  );
}

type Act = ReturnType<typeof useAct>;

function ProduceModal({ base, left, lotDefault, batch, onClose, act }: { base: string; left: number; lotDefault: string | null; batch: boolean; onClose: () => void; act: Act }) {
  const [f, setF] = useState({ qty: String(left), scrapQty: '', lotNumber: lotDefault ?? '', expiryDate: '', note: '' });
  const save = async () => {
    const ok = await act(
      () => post(`${base}/produce`, { qty: Number(f.qty) || 0, scrapQty: Number(f.scrapQty) || 0, lotNumber: f.lotNumber || null, expiryDate: f.expiryDate || null, note: f.note || null }),
      'Output recorded and moved to stock',
    );
    if (ok) onClose();
  };
  return (
    <Modal title="Record output" onClose={onClose} footer={<button className="btn primary" onClick={save}>Save</button>}>
      <Body>
      <div className="grid2">
        <label className="field">
          Good quantity
          <input type="number" min={0} step="any" value={f.qty} onChange={(e) => setF({ ...f, qty: e.target.value })} />
        </label>
        <label className="field">
          Scrap
          <input type="number" min={0} step="any" value={f.scrapQty} onChange={(e) => setF({ ...f, scrapQty: e.target.value })} />
        </label>
        <label className="field">
          Batch / lot {batch ? '' : '(optional)'}
          <input value={f.lotNumber} onChange={(e) => setF({ ...f, lotNumber: e.target.value })} placeholder="Generated if blank" />
        </label>
        <label className="field">
          Expiry (default: shelf life)
          <input type="date" value={f.expiryDate} onChange={(e) => setF({ ...f, expiryDate: e.target.value })} />
        </label>
        <label className="field wide">
          Note
          <input value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} />
        </label>
      </div>
      <p className="small muted">{left} left on the order. Cost moves from WIP to stock in proportion; the last output takes everything left in WIP.</p>
      </Body>
    </Modal>
  );
}

function OperationModal({ base, op, onClose, act }: { base: string; op: Json; onClose: () => void; act: Act }) {
  const { data: users } = useQuery({ queryKey: ['users-min'], queryFn: () => get<{ items: Json[] }>('/api/v1/users'), staleTime: 300_000 });
  const [f, setF] = useState({ minutes: '', qtyDone: '', done: false, operatorId: op.operator_id ?? '' });
  const save = async () => {
    const ok = await act(
      () => post(`${base}/operations/${op.id}`, { minutes: Number(f.minutes) || 0, qtyDone: f.qtyDone ? Number(f.qtyDone) : undefined, status: f.done ? 'done' : 'in_progress', operatorId: f.operatorId || null }),
      'Time recorded',
    );
    if (ok) onClose();
  };
  return (
    <Modal title={`${op.seq} · ${op.name}`} onClose={onClose} footer={<button className="btn primary" onClick={save}>Save</button>}>
      <Body>
      <div className="grid2">
        <label className="field">
          Minutes worked
          <input type="number" min={0} value={f.minutes} onChange={(e) => setF({ ...f, minutes: e.target.value })} />
        </label>
        <label className="field">
          Quantity done so far
          <input type="number" min={0} step="any" value={f.qtyDone} onChange={(e) => setF({ ...f, qtyDone: e.target.value })} />
        </label>
        <label className="field">
          Operator
          <select value={f.operatorId} onChange={(e) => setF({ ...f, operatorId: e.target.value })}>
            <option value="">—</option>
            {users?.items.map((u) => (
              <option key={u.id} value={u.id}>
                {u.full_name}
              </option>
            ))}
          </select>
        </label>
        <label className="check" style={{ alignSelf: 'end' }}>
          <input type="checkbox" checked={f.done} onChange={(e) => setF({ ...f, done: e.target.checked })} /> Operation finished
        </label>
      </div>
      <p className="small muted">
        Planned {op.planned_minutes} min, {op.actual_minutes} logged.{op.cost_per_hour != null ? ` Time is costed at ${money2(op.cost_per_hour)}/hour.` : ''}
      </p>
      </Body>
    </Modal>
  );
}

function ReturnModal({ base, materials, onClose, act }: { base: string; materials: Json[]; onClose: () => void; act: Act }) {
  const [q, setQ] = useState<Record<string, string>>({});
  const items = Object.entries(q)
    .map(([productId, v]) => ({ productId, qty: Number(v) }))
    .filter((x) => x.qty > 0);
  return (
    <Modal
      title="Return unused material"
      onClose={onClose}
      footer={
        <button className="btn primary" disabled={!items.length} onClick={async () => (await act(() => post(`${base}/return`, { items }), 'Returned to stock')) && onClose()}>
          Return
        </button>
      }
    >
      <Body>
      {!materials.length ? (
        <p className="muted">Nothing has been issued.</p>
      ) : (
        <table className="data">
          <tbody>
            {materials.map((m) => (
              <tr key={m.id}>
                <td>{m.product}</td>
                <td className="num muted">{m.issued_qty} issued</td>
                <td className="num">
                  <input type="number" min={0} max={m.issued_qty} step="any" style={{ width: 90 }} value={q[m.product_id] ?? ''} onChange={(e) => setQ({ ...q, [m.product_id]: e.target.value })} aria-label={`Return ${m.product}`} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      </Body>
    </Modal>
  );
}

export function QcModal({ workOrderId, productId, lotId, onClose, act }: { workOrderId?: string; productId?: string; lotId?: string; onClose: () => void; act: Act }) {
  const [f, setF] = useState({ stage: workOrderId ? 'final' : 'incoming', productId: productId ?? '', qtyInspected: '', qtyRejected: '', result: 'pass', notes: '' });
  const [params, setParams] = useState<{ name: string; spec: string; value: string; ok: boolean }[]>([{ name: '', spec: '', value: '', ok: true }]);
  const save = async () => {
    const ok = await act(
      () =>
        post('/api/v1/mfg/quality', {
          stage: f.stage,
          productId: f.productId,
          workOrderId: workOrderId ?? null,
          lotId: lotId ?? null,
          qtyInspected: Number(f.qtyInspected),
          qtyRejected: Number(f.qtyRejected) || 0,
          result: f.result,
          parameters: params.filter((p) => p.name.trim()),
          notes: f.notes || null,
        }),
      'Quality check recorded',
    );
    if (ok) onClose();
  };
  return (
    <Modal title="Quality check" onClose={onClose} wide footer={<button className="btn primary" onClick={save}>Save</button>}>
      <Body>
      <div className="grid2">
        <label className="field">
          Stage
          <select value={f.stage} onChange={(e) => setF({ ...f, stage: e.target.value })}>
            <option value="incoming">Incoming</option>
            <option value="in_process">In process</option>
            <option value="final">Final</option>
          </select>
        </label>
        {!productId && (
          <label className="field">
            Product
            <ProductPick value={f.productId} onChange={(id) => setF({ ...f, productId: id })} />
          </label>
        )}
        <label className="field">
          Inspected
          <input type="number" min={0} step="any" value={f.qtyInspected} onChange={(e) => setF({ ...f, qtyInspected: e.target.value })} />
        </label>
        <label className="field">
          Rejected
          <input type="number" min={0} step="any" value={f.qtyRejected} onChange={(e) => setF({ ...f, qtyRejected: e.target.value })} />
        </label>
        <label className="field">
          Result
          <select value={f.result} onChange={(e) => setF({ ...f, result: e.target.value })}>
            <option value="pass">Pass</option>
            <option value="hold">Hold (quarantine the lot)</option>
            <option value="fail">Fail (reject the lot)</option>
          </select>
        </label>
      </div>
      <h3 style={{ marginBottom: 4 }}>Parameters</h3>
      <table className="data">
        <thead>
          <tr>
            <th>Check</th>
            <th>Spec</th>
            <th>Measured</th>
            <th>OK</th>
          </tr>
        </thead>
        <tbody>
          {params.map((p, i) => (
            <tr key={i}>
              {(['name', 'spec', 'value'] as const).map((k) => (
                <td key={k}>
                  <input value={p[k]} onChange={(e) => setParams(params.map((x, j) => (j === i ? { ...x, [k]: e.target.value } : x)))} aria-label={k} />
                </td>
              ))}
              <td>
                <input type="checkbox" checked={p.ok} onChange={(e) => setParams(params.map((x, j) => (j === i ? { ...x, ok: e.target.checked } : x)))} aria-label="OK" />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <button className="btn ghost sm" onClick={() => setParams([...params, { name: '', spec: '', value: '', ok: true }])}>
        + Parameter
      </button>
      <label className="stack" style={{ marginTop: 8 }}>
        Notes
        <textarea rows={2} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} />
      </label>
      </Body>
    </Modal>
  );
}

/* ───────────────────────── job work ───────────────────────── */

export function JobWorkPanel({ id, canEdit }: { id: string; canEdit: boolean }) {
  const key = ['mfg', 'jw', id];
  const { data } = useQuery({ queryKey: key, queryFn: () => get<Json>(`/api/v1/mfg/job-works/${id}`) });
  const act = useAct([key, ['record', 'job_work', id]]);
  const [lines, setLines] = useState<{ productId: string; quantity: string }[] | null>(null);
  const [recv, setRecv] = useState(false);
  if (!data) return <Spinner />;
  const j = data.jobWork;
  const base = `/api/v1/mfg/job-works/${id}`;
  const editing = lines ?? (data.lines as Json[]).map((l) => ({ productId: l.product_id, quantity: String(l.quantity) }));
  const draft = j.status === 'draft';
  return (
    <section className="panel" style={{ marginBottom: 14 }}>
      <div className="panel-head">
        <h2>Job work</h2>
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <span className={`chip ${j.status === 'received' || j.status === 'closed' ? 'good' : j.status === 'draft' ? '' : 'warn'}`}>{j.status.replace('_', ' ')}</span>
          {j.challan_number && <span className="chip info">{j.challan_number}</span>}
          <Link className="btn sm" to={`/print/job_work/${id}`}>
            {j.challan_number ? 'Print challan' : 'Preview challan'}
          </Link>
          {canEdit && draft && data.lines.length > 0 && (
            <button className="btn primary sm" onClick={() => confirm('Send the goods? Stock leaves the warehouse under a delivery challan.') && act(() => post(`${base}/send`, { date: today() }), 'Sent under a delivery challan')}>
              Send
            </button>
          )}
          {canEdit && ['sent', 'partially_received'].includes(j.status) && (
            <button className="btn primary sm" onClick={() => setRecv(true)}>
              Receive back
            </button>
          )}
          {canEdit && ['sent', 'partially_received', 'received'].includes(j.status) && (
            <button
              className="btn ghost sm"
              onClick={() => {
                const reason = prompt('Close this job work? Anything still with the job worker is written off as process loss. Reason:');
                if (reason) act(() => post(`${base}/close`, { reason }), 'Closed');
              }}
            >
              Close
            </button>
          )}
        </div>
      </div>
      <div className="panel-body stack">
        <div className="row small muted" style={{ flexWrap: 'wrap', gap: 16 }}>
          <span>
            Job worker: <b>{data.vendor?.name ?? '—'}</b>
            {data.vendor?.gstin ? ` · ${data.vendor.gstin}` : ''}
          </span>
          {j.process && <span>Process: {j.process}</span>}
          <span>
            Comes back as: <b>{data.output?.name ?? 'the same goods'}</b>
            {j.output_qty != null ? ` · expect ${j.output_qty}` : ''} · received {j.received_qty}
          </span>
          {j.rate > 0 && <span>Rate {money2(j.rate)} / unit</span>}
          {j.sent_date && <span>Sent {date(j.sent_date)}</span>}
          {j.material_value > 0 && <span>Material value {money2(j.material_value)}</span>}
        </div>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Goods sent</th>
                <th className="num">Quantity</th>
                {!draft && (
                  <>
                    <th className="num">Used</th>
                    <th className="num">Returned as is</th>
                    <th className="num">Still with job worker</th>
                    <th className="num">Value</th>
                  </>
                )}
                {draft && canEdit && <th />}
              </tr>
            </thead>
            <tbody>
              {draft && canEdit
                ? editing.map((l, i) => (
                    <tr key={i}>
                      <td>
                        <ProductPick value={l.productId} onChange={(pid) => setLines(editing.map((x, k) => (k === i ? { ...x, productId: pid } : x)))} />
                      </td>
                      <td className="num">
                        <input type="number" min={0} step="any" style={{ width: 100 }} value={l.quantity} onChange={(e) => setLines(editing.map((x, k) => (k === i ? { ...x, quantity: e.target.value } : x)))} aria-label="Quantity" />
                      </td>
                      <td>
                        <button className="btn ghost sm" onClick={() => setLines(editing.filter((_, k) => k !== i))} aria-label="Remove">
                          ✕
                        </button>
                      </td>
                    </tr>
                  ))
                : (data.lines as Json[]).map((l) => (
                    <tr key={l.id}>
                      <td>
                        <Link to={`/o/product/${l.product_id}`}>{l.product}</Link>
                        {l.hsn_sac && <span className="muted small"> · HSN {l.hsn_sac}</span>}
                      </td>
                      <td className="num">{l.sent_qty || l.quantity}</td>
                      {!draft && (
                        <>
                          <td className="num">{l.consumed_qty}</td>
                          <td className="num">{l.returned_qty}</td>
                          <td className={`num${l.sent_qty - l.consumed_qty - l.returned_qty > 0 ? ' tone-bad' : ''}`}>{n(l.sent_qty - l.consumed_qty - l.returned_qty)}</td>
                          <td className="num">{money2(l.value)}</td>
                        </>
                      )}
                    </tr>
                  ))}
            </tbody>
          </table>
        </div>
        {draft && canEdit && (
          <div className="row">
            <button className="btn ghost sm" onClick={() => setLines([...editing, { productId: '', quantity: '' }])}>
              + Item
            </button>
            {lines && (
              <button
                className="btn primary sm"
                onClick={async () => (await act(() => put(`${base}/lines`, { lines: editing.filter((l) => l.productId && Number(l.quantity) > 0).map((l) => ({ productId: l.productId, quantity: Number(l.quantity) })) }), 'Saved')) && setLines(null)}
              >
                Save items
              </button>
            )}
          </div>
        )}
        {data.logs.length > 0 && (
          <details>
            <summary className="small">History ({data.logs.length})</summary>
            <table className="data" style={{ marginTop: 6 }}>
              <tbody>
                {(data.logs as Json[]).map((l) => (
                  <tr key={l.id}>
                    <td className="small">{date(l.log_date ?? l.created_at)}</td>
                    <td>{l.kind}</td>
                    <td className="num">{l.output_qty ? `${l.output_qty} back` : ''}</td>
                    <td className="num">{money2(l.value)}</td>
                    <td className="small muted">{l.challan_ref ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        )}
      </div>
      {recv && <ReceiveModal base={base} data={data} onClose={() => setRecv(false)} act={act} />}
    </section>
  );
}

function ReceiveModal({ base, data, onClose, act }: { base: string; data: Json; onClose: () => void; act: Act }) {
  const pending: Json[] = (data.lines as Json[]).map((l) => ({ ...l, pending: n(l.sent_qty - l.consumed_qty - l.returned_qty) })).filter((l) => l.pending > 0);
  const [f, setF] = useState({ outputQty: '', date: today(), challanRef: '', lotNumber: '' });
  const [ret, setRet] = useState<Record<string, string>>({});
  const save = async () => {
    const returned = Object.entries(ret)
      .map(([productId, q]) => ({ productId, qty: Number(q) }))
      .filter((x) => x.qty > 0);
    const ok = await act(() => post(`${base}/receive`, { outputQty: Number(f.outputQty) || 0, returned, date: f.date, challanRef: f.challanRef || null, lotNumber: f.lotNumber || null }), 'Received into stock');
    if (ok) onClose();
  };
  return (
    <Modal title="Receive from job worker" onClose={onClose} footer={<button className="btn primary" onClick={save}>Receive</button>}>
      <Body>
      <div className="grid2">
        <label className="field">
          Processed quantity back ({data.output?.name ?? 'same goods'})
          <input type="number" min={0} step="any" value={f.outputQty} onChange={(e) => setF({ ...f, outputQty: e.target.value })} />
        </label>
        <label className="field">
          Date
          <input type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} />
        </label>
        <label className="field">
          Job worker's challan no.
          <input value={f.challanRef} onChange={(e) => setF({ ...f, challanRef: e.target.value })} />
        </label>
        <label className="field">
          Lot (optional)
          <input value={f.lotNumber} onChange={(e) => setF({ ...f, lotNumber: e.target.value })} />
        </label>
      </div>
      {pending.length > 0 && (
        <>
          <h3 style={{ marginBottom: 4 }}>Unprocessed goods coming back</h3>
          <table className="data">
            <tbody>
              {pending.map((l) => (
                <tr key={l.id}>
                  <td>{l.product}</td>
                  <td className="num muted">{l.pending} with job worker</td>
                  <td className="num">
                    <input type="number" min={0} max={l.pending} step="any" style={{ width: 90 }} value={ret[l.product_id] ?? ''} onChange={(e) => setRet({ ...ret, [l.product_id]: e.target.value })} aria-label={`Returned ${l.product}`} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      <p className="small muted">Material used is taken in proportion to the output. The processed goods are valued at that material plus the job work rate; the job worker's bill settles the charge.</p>
      </Body>
    </Modal>
  );
}
