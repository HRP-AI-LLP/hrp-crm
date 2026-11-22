/** Books → Compliance: the year's statutory filings (MCA, GST, income tax, TDS, PF, ESI, PT) tracked to filed. */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { del, get, patch, post, put } from '../../lib/api';
import { money2 } from '../../lib/format';
import { FilesPanel } from '../Files';
import { Modal, Spinner, useToast } from '../ui';

type Json = Record<string, any>;
const AUTH = ['MCA', 'GST', 'Income tax', 'TDS', 'EPFO', 'ESIC', 'State', 'Other'];
const today = () => new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
const fyNow = () => {
  const d = new Date(Date.now() + 5.5 * 3_600_000);
  return d.getUTCMonth() >= 3 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
};
const fmt = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

export function Compliance({ manage = true }: { manage?: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [fy, setFy] = useState(fyNow());
  const [auth, setAuth] = useState('');
  const [show, setShow] = useState<'open' | 'all'>('open');
  const [open, setOpen] = useState<Json | null>(null);
  const [adding, setAdding] = useState(false);
  const [settings, setSettings] = useState(false);
  const users = useQuery({ queryKey: ['users-min'], queryFn: () => get<{ items: Json[] }>('/api/v1/users') });
  const key = ['books', 'compliance', fy];
  const { data, isLoading } = useQuery({ queryKey: key, queryFn: () => get<Json[]>(`/api/v1/books/compliance?from=${fy}-04-01&to=${fy + 1}-12-31`) });
  const refresh = () => qc.invalidateQueries({ queryKey: ['books', 'compliance'] });
  const generate = async () => {
    try {
      const r = await post<Json>('/api/v1/books/compliance/generate', { fy });
      toast(r.added ? `${r.added} filing(s) added for FY ${fy}-${String((fy + 1) % 100).padStart(2, '0')}` : 'The calendar is up to date');
      refresh();
    } catch (e) {
      toast((e as Error).message, true);
    }
  };
  const items = (data ?? []) as Json[];
  const t = today();
  const shown = useMemo(() => items.filter((i) => (!auth || i.authority === auth) && (show === 'all' || ['pending', 'in_progress'].includes(i.status))), [items, auth, show]);
  const overdue = items.filter((i) => ['pending', 'in_progress'].includes(i.status) && i.due_date < t);
  const soon = items.filter((i) => ['pending', 'in_progress'].includes(i.status) && i.due_date >= t && i.due_date <= new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10));
  const filed = items.filter((i) => i.status === 'filed');
  const groups = useMemo(() => {
    const m = new Map<string, Json[]>();
    for (const i of shown) {
      const k = i.due_date.slice(0, 7);
      m.set(k, [...(m.get(k) ?? []), i]);
    }
    return [...m.entries()];
  }, [shown]);
  if (isLoading) return <Spinner />;
  return (
    <div className="stack">
      <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
        <select value={fy} onChange={(e) => setFy(Number(e.target.value))} style={{ width: 'auto' }} aria-label="Financial year">
          {[fyNow() - 1, fyNow(), fyNow() + 1].map((y) => (
            <option key={y} value={y}>
              FY {y}-{String((y + 1) % 100).padStart(2, '0')}
            </option>
          ))}
        </select>
        <select value={auth} onChange={(e) => setAuth(e.target.value)} style={{ width: 'auto' }} aria-label="Authority">
          <option value="">All authorities</option>
          {AUTH.map((a) => (
            <option key={a}>{a}</option>
          ))}
        </select>
        <div className="row" style={{ gap: 0 }}>
          <button className={`btn sm${show === 'open' ? ' primary' : ''}`} onClick={() => setShow('open')}>
            To do
          </button>
          <button className={`btn sm${show === 'all' ? ' primary' : ''}`} onClick={() => setShow('all')}>
            Everything
          </button>
        </div>
        <span style={{ flex: 1 }} />
        {manage && (
          <button className="btn sm" onClick={() => setSettings(true)}>
            Settings
          </button>
        )}
        <button className="btn sm" onClick={() => setAdding(true)}>
          + Add a filing
        </button>
        <button className="btn sm primary" onClick={generate}>
          {items.length ? 'Refresh the calendar' : 'Build the calendar'}
        </button>
      </div>
      {manage && <YourCa />}
      {!items.length ? (
        <div className="panel" style={{ padding: 24, textAlign: 'center' }}>
          <h3>Every filing the business owes, in one calendar</h3>
          <p className="muted" style={{ maxWidth: 620, margin: '8px auto 14px' }}>
            Built from your organisation profile (LLP or company), GSTIN, TAN, partners with a DIN and staff on PF / ESI: Form 11 and Form 8, DIR-3 KYC, ITR and tax audit, advance tax, GSTR-1 and 3B, TDS deposits, 26Q / 24Q and Form 16A, PF and ESI. Reminders go out a week before and the day before.
          </p>
          <button className="btn primary" onClick={generate}>
            Build the calendar for FY {fy}-{String((fy + 1) % 100).padStart(2, '0')}
          </button>
        </div>
      ) : (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 12 }}>
            <div className="panel kpi">
              <div className="l">Overdue</div>
              <div className="v" style={{ color: overdue.length ? 'var(--bad)' : undefined }}>{overdue.length}</div>
            </div>
            <div className="panel kpi">
              <div className="l">Due in 30 days</div>
              <div className="v">{soon.length}</div>
            </div>
            <div className="panel kpi">
              <div className="l">Filed</div>
              <div className="v" style={{ color: 'var(--good)' }}>
                {filed.length}
                <span className="small muted" style={{ fontWeight: 500 }}>
                  {' '}
                  / {items.filter((i) => i.status !== 'not_applicable').length}
                </span>
              </div>
            </div>
            <div className="panel kpi">
              <div className="l">Paid with filings</div>
              <div className="v" style={{ fontSize: 20 }}>{money2(items.reduce((s, i) => s + Number(i.amount_paid ?? 0), 0))}</div>
            </div>
          </div>
          {overdue.length > 3 && (
            <div className="notice">
              <span>
                {overdue.length} filings are past their due date. If your CA has already filed them, mark them filed in one go and add the acknowledgements later.
              </span>
              <button
                className="btn sm"
                onClick={async () => {
                  if (!confirm(`Mark the ${overdue.length} filings due before today as filed?`)) return;
                  try {
                    const r = await post<Json>('/api/v1/books/compliance/mark-past-filed', { before: t });
                    toast(`${r.updated} marked filed`);
                    refresh();
                  } catch (e) {
                    toast((e as Error).message, true);
                  }
                }}
              >
                Mark all past ones filed
              </button>
            </div>
          )}
          {groups.map(([month, list]) => (
            <div key={month}>
              <div className="small" style={{ fontWeight: 700, color: 'var(--ink-3)', textTransform: 'uppercase', letterSpacing: '.06em', margin: '6px 0' }}>
                {new Date(`${month}-01T00:00:00Z`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' })}
              </div>
              <div className="panel">
                {list.map((i) => {
                  const late = ['pending', 'in_progress'].includes(i.status) && i.due_date < t;
                  const days = Math.round((Date.parse(`${i.due_date}T00:00:00Z`) - Date.parse(`${t}T00:00:00Z`)) / 86_400_000);
                  return (
                    <div key={i.id} className="attn" style={{ padding: '10px 16px', cursor: 'pointer' }} onClick={() => setOpen(i)}>
                      <span className={`pill ${i.status === 'filed' ? 'good' : i.status === 'not_applicable' ? '' : late ? 'bad' : days <= 7 ? 'warn' : 'info'}`} style={{ minWidth: 76, justifyContent: 'center' }}>
                        {i.status === 'filed' ? 'filed' : i.status === 'not_applicable' ? 'n/a' : late ? `${-days}d late` : days === 0 ? 'today' : `in ${days}d`}
                      </span>
                      <div className="t">
                        <b style={{ fontWeight: 600 }}>{i.name}</b>
                        <div className="meta">
                          {i.authority} · due {fmt(i.due_date)}
                          {i.reference ? ` · ${i.reference}` : ''}
                          {i.assignee ? ` · ${i.assignee}` : ''}
                          {i.files ? ` · ${i.files} file(s)` : ''}
                        </div>
                      </div>
                      {i.amount_paid ? <span className="amt small">{money2(i.amount_paid)}</span> : null}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
          {!groups.length && <p className="muted">Nothing to do here. 🎉</p>}
        </>
      )}
      {open && <ItemModal item={open} users={users.data?.items ?? []} onClose={() => setOpen(null)} onSaved={refresh} />}
      {adding && <AddModal users={users.data?.items ?? []} onClose={() => setAdding(false)} onSaved={refresh} />}
      {settings && <SettingsModal users={users.data?.items ?? []} onClose={() => setSettings(false)} onSaved={refresh} />}
    </div>
  );
}

function ItemModal({ item, users, onClose, onSaved }: { item: Json; users: Json[]; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [f, setF] = useState({ status: item.status, filedOn: item.filed_on ?? '', reference: item.reference ?? '', amountPaid: item.amount_paid ?? '', notes: item.notes ?? '', assigneeId: item.assignee_id ?? '', dueDate: item.due_date });
  const save = async (over: Partial<typeof f> = {}) => {
    const v = { ...f, ...over };
    try {
      await patch(`/api/v1/books/compliance/items/${item.id}`, {
        status: v.status,
        filedOn: v.filedOn || null,
        reference: v.reference || null,
        amountPaid: v.amountPaid === '' ? null : Number(v.amountPaid),
        notes: v.notes || null,
        assigneeId: v.assigneeId || null,
        dueDate: v.dueDate,
      });
      toast('Saved');
      onSaved();
      onClose();
    } catch (e) {
      toast((e as Error).message, true);
    }
  };
  return (
    <Modal
      title={item.name}
      wide
      onClose={onClose}
      footer={
        <>
          {item.status !== 'not_applicable' && (
            <button className="btn ghost" style={{ marginRight: 'auto' }} onClick={() => save({ status: 'not_applicable' })}>
              Not applicable this year
            </button>
          )}
          <button className="btn" onClick={() => save()}>
            Save
          </button>
          {item.status !== 'filed' && (
            <button className="btn primary" onClick={() => save({ status: 'filed', filedOn: f.filedOn || new Date().toISOString().slice(0, 10) })}>
              Mark filed
            </button>
          )}
        </>
      }
    >
      <div className="modal-body">
        <p className="small muted wide" style={{ margin: 0 }}>
          {item.authority} · {item.period}. {item.description}
        </p>
        <label className="field">
          Status
          <select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}>
            <option value="pending">To do</option>
            <option value="in_progress">In progress</option>
            <option value="filed">Filed</option>
            <option value="not_applicable">Not applicable</option>
          </select>
        </label>
        <label className="field">
          Due date (change it for an extension)
          <input type="date" value={f.dueDate} onChange={(e) => setF({ ...f, dueDate: e.target.value })} />
        </label>
        <label className="field">
          Filed on
          <input type="date" value={f.filedOn} onChange={(e) => setF({ ...f, filedOn: e.target.value })} />
        </label>
        <label className="field">
          SRN / ARN / acknowledgement no.
          <input value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} />
        </label>
        <label className="field">
          Fee, tax or penalty paid (₹)
          <input type="number" min={0} value={f.amountPaid} onChange={(e) => setF({ ...f, amountPaid: e.target.value })} />
        </label>
        <label className="field">
          Who files it
          <select value={f.assigneeId} onChange={(e) => setF({ ...f, assigneeId: e.target.value })}>
            <option value="">—</option>
            {users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.full_name ?? u.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field wide">
          Notes
          <textarea rows={2} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} />
        </label>
        {['llp_form8', 'llp_form11'].includes(item.key) && <LlpWorking fy={Number(String(item.period).slice(0, 4))} form={item.key === 'llp_form8' ? 8 : 11} />}
        <Conversation itemId={item.id} />
        <div className="wide">
          <div className="small" style={{ fontWeight: 600, marginBottom: 6 }}>
            Acknowledgement, challan and working papers
          </div>
          <FilesPanel object="compliance_item" id={item.id} canEdit />
        </div>
      </div>
    </Modal>
  );
}

function AddModal({ users, onClose, onSaved }: { users: Json[]; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [f, setF] = useState({ name: '', authority: 'Other', dueDate: '', description: '', assigneeId: '' });
  return (
    <Modal
      title="Add a filing"
      onClose={onClose}
      footer={
        <button
          className="btn primary"
          disabled={!f.name || !f.dueDate}
          onClick={async () => {
            try {
              await post('/api/v1/books/compliance/items', { ...f, assigneeId: f.assigneeId || null, description: f.description || null });
              onSaved();
              onClose();
            } catch (e) {
              toast((e as Error).message, true);
            }
          }}
        >
          Add
        </button>
      }
    >
      <div className="modal-body">
        <label className="field wide">
          What
          <input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Trade licence renewal, Startup India annual report …" />
        </label>
        <label className="field">
          Authority
          <select value={f.authority} onChange={(e) => setF({ ...f, authority: e.target.value })}>
            {AUTH.map((a) => (
              <option key={a}>{a}</option>
            ))}
          </select>
        </label>
        <label className="field">
          Due
          <input type="date" value={f.dueDate} onChange={(e) => setF({ ...f, dueDate: e.target.value })} />
        </label>
        <label className="field">
          Who files it
          <select value={f.assigneeId} onChange={(e) => setF({ ...f, assigneeId: e.target.value })}>
            <option value="">—</option>
            {users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.full_name ?? u.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field wide">
          Notes
          <textarea rows={2} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
        </label>
      </div>
    </Modal>
  );
}

function SettingsModal({ users, onClose, onSaved }: { users: Json[]; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const { data } = useQuery({ queryKey: ['books', 'compliance-settings'], queryFn: () => get<Json>('/api/v1/books/compliance/settings') });
  const [f, setF] = useState<Json | null>(null);
  const v = f ?? data;
  if (!v) return null;
  return (
    <Modal
      title="Compliance settings"
      onClose={onClose}
      footer={
        <button
          className="btn primary"
          onClick={async () => {
            try {
              await put('/api/v1/books/compliance/settings', { ...v, defaultAssigneeId: v.defaultAssigneeId || null });
              await post('/api/v1/books/compliance/generate', {});
              toast('Saved');
              onSaved();
              onClose();
            } catch (e) {
              toast((e as Error).message, true);
            }
          }}
        >
          Save
        </button>
      }
    >
      <div className="modal-body">
        <label className="field">
          GST returns
          <select value={v.gstReturns} onChange={(e) => setF({ ...v, gstReturns: e.target.value })}>
            <option value="monthly">Monthly (GSTR-1 by 11th, 3B by 20th)</option>
            <option value="qrmp">Quarterly (QRMP)</option>
            <option value="none">Not registered</option>
          </select>
        </label>
        <label className="field">
          Statutory audit
          <select value={v.audit} onChange={(e) => setF({ ...v, audit: e.target.value })}>
            <option value="auto">Work it out (LLP: turnover over ₹40 lakh)</option>
            <option value="yes">Accounts are audited</option>
            <option value="no">Not audited</option>
          </select>
        </label>
        <label className="field">
          Tax audit (3CB-3CD)
          <select value={v.taxAudit} onChange={(e) => setF({ ...v, taxAudit: e.target.value })}>
            <option value="auto">Work it out (turnover over ₹1 crore)</option>
            <option value="yes">Applies</option>
            <option value="no">Does not apply</option>
          </select>
        </label>
        <div className="wide small" style={{ fontWeight: 700 }}>
          Staff filings (payroll runs in your HRMS)
        </div>
        <label className="row small">
          <input type="checkbox" checked={!!v.staffPf} onChange={(e) => setF({ ...v, staffPf: e.target.checked })} /> PF (ECR by the 15th)
        </label>
        <label className="row small">
          <input type="checkbox" checked={!!v.staffEsi} onChange={(e) => setF({ ...v, staffEsi: e.target.checked })} /> ESI
        </label>
        <label className="row small">
          <input type="checkbox" checked={!!v.staffPt} onChange={(e) => setF({ ...v, staffPt: e.target.checked })} /> Professional tax
        </label>
        <label className="row small">
          <input type="checkbox" checked={!!v.salaryTds} onChange={(e) => setF({ ...v, salaryTds: e.target.checked })} /> TDS on salaries (24Q, Form 16)
        </label>
        <label className="row small wide">
          <input type="checkbox" checked={!!v.payrollHere} onChange={(e) => setF({ ...v, payrollHere: e.target.checked })} /> Also run payroll in SanchalanOS (shows the Payroll tab in Books)
        </label>
        <label className="field">
          Usually filed by (your CA's login)
          <select value={v.defaultAssigneeId ?? ''} onChange={(e) => setF({ ...v, defaultAssigneeId: e.target.value })}>
            <option value="">The workspace owner</option>
            {users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.full_name ?? u.name}
              </option>
            ))}
          </select>
        </label>
      </div>
    </Modal>
  );
}

/** Figures for Form 11 / Form 8 straight from the books, for the CA to check and file. */
function LlpWorking({ fy, form }: { fy: number; form: 8 | 11 }) {
  const { data } = useQuery({ queryKey: ['books', 'llp-working', fy], queryFn: () => get<Json>(`/api/v1/books/compliance/llp-working?fy=${fy}`) });
  if (!data) return <div className="wide"><Spinner /></div>;
  const f11 = data.form11;
  const f8 = data.form8;
  return (
    <div className="wide panel" style={{ padding: 12, background: 'var(--surface-2)' }}>
      <div className="small" style={{ fontWeight: 700, marginBottom: 6 }}>
        From the books · as on {data.asOf}
      </div>
      {form === 11 ? (
        <>
          <table className="data small" style={{ margin: 0 }}>
            <thead>
              <tr>
                <th>Partner</th>
                <th>DIN / DPIN</th>
                <th>PAN</th>
                <th className="num">Share</th>
                <th className="num">Contribution</th>
              </tr>
            </thead>
            <tbody>
              {f11.partners.map((p: Json) => (
                <tr key={p.name}>
                  <td>
                    {p.name}
                    {p.designated ? <span className="pill info" style={{ marginLeft: 6 }}>designated</span> : null}
                  </td>
                  <td>{p.din ?? '—'}</td>
                  <td>{p.pan ?? '—'}</td>
                  <td className="num">{p.sharePct != null ? `${p.sharePct}%` : '—'}</td>
                  <td className="num">{money2(p.contribution)}</td>
                </tr>
              ))}
              <tr>
                <td colSpan={4}>
                  <b>Total contribution</b>
                </td>
                <td className="num">
                  <b>{money2(f11.totalContribution)}</b>
                </td>
              </tr>
            </tbody>
          </table>
          {f11.warnings.map((w: string) => (
            <div key={w} className="small" style={{ color: 'var(--bad)', marginTop: 4 }}>
              ⚠ {w}
            </div>
          ))}
        </>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 8 }} className="small">
          <div>
            Turnover <b>{money2(f8.turnover)}</b>
          </div>
          <div>
            Income <b>{money2(f8.incomeAndExpenditure.income)}</b>
          </div>
          <div>
            Expenditure <b>{money2(f8.incomeAndExpenditure.expenses)}</b>
          </div>
          <div>
            Profit / loss <b style={{ color: f8.incomeAndExpenditure.netProfit < 0 ? 'var(--bad)' : undefined }}>{money2(f8.incomeAndExpenditure.netProfit)}</b>
          </div>
          <div>
            Total assets <b>{money2(f8.balanceSheet.totals.assets)}</b>
          </div>
          <div>
            Liabilities <b>{money2(f8.balanceSheet.totals.liabilities)}</b>
          </div>
          <div>
            Partners' funds <b>{money2(f8.balanceSheet.totals.equity)}</b>
          </div>
          <div>
            Audit <b>{f8.auditRequired ? 'required (Form 8 certified by the auditor)' : 'not required'}</b>
          </div>
          {!f8.balanceSheet.totals.balanced && <div style={{ color: 'var(--bad)' }}>⚠ The balance sheet does not balance yet: finish the accounts desk first.</div>}
        </div>
      )}
    </div>
  );
}

/** The business's CA: invite them to their own portal, see who has access, remove it. */
function YourCa() {
  const toast = useToast();
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['books', 'accountants'], queryFn: () => get<Json[]>('/api/v1/books/accountants'), retry: false });
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ fullName: '', email: '', firm: '', assignFilings: true });
  const [link, setLink] = useState<string | null>(null);
  if (!data) return null;
  const active = data.filter((a) => a.status !== 'disabled');
  return (
    <div className="panel" style={{ padding: '12px 16px' }}>
      <div className="row" style={{ flexWrap: 'wrap', gap: 10 }}>
        <b>Your CA</b>
        {active.length ? (
          active.map((a) => (
            <span key={a.id} className="row small" style={{ gap: 6, background: 'var(--surface-2)', border: '1px solid var(--line)', borderRadius: 999, padding: '3px 4px 3px 10px' }}>
              {a.full_name}
              {a.firm ? ` · ${a.firm}` : ''}
              <span className={`pill ${a.status === 'active' ? 'good' : 'warn'}`}>{a.status === 'active' ? (a.last_login_at ? 'active' : 'joined') : 'invited'}</span>
              <button
                className="btn ghost sm"
                title="Remove access"
                onClick={async () => {
                  if (!confirm(`Remove ${a.full_name}'s access to the portal?`)) return;
                  await del(`/api/v1/books/accountants/${a.id}`).catch((e) => toast((e as Error).message, true));
                  qc.invalidateQueries({ queryKey: ['books', 'accountants'] });
                }}
              >
                ✕
              </button>
            </span>
          ))
        ) : (
          <span className="small muted">Give your chartered accountant a portal of their own: every filing with its due date, statements, GST and TDS returns and the audit trail — nothing else of the business.</span>
        )}
        <span style={{ flex: 1 }} />
        <button className="btn sm primary" onClick={() => { setLink(null); setOpen(true); }}>
          {active.length ? '+ Another CA' : 'Invite your CA'}
        </button>
      </div>
      {open && (
        <Modal
          title="Invite your CA to their portal"
          onClose={() => setOpen(false)}
          footer={
            link ? (
              <button className="btn primary" onClick={() => setOpen(false)}>
                Done
              </button>
            ) : (
              <button
                className="btn primary"
                disabled={!f.fullName || !f.email}
                onClick={async () => {
                  try {
                    const r = await post<Json>('/api/v1/books/accountants', { ...f, firm: f.firm || null });
                    qc.invalidateQueries({ queryKey: ['books', 'accountants'] });
                    qc.invalidateQueries({ queryKey: ['books', 'compliance'] });
                    if (r.inviteUrl && !r.emailed) setLink(r.inviteUrl);
                    else {
                      toast(r.invited ? `Invitation emailed to ${f.email}` : `${f.fullName} now has the CA portal`);
                      setOpen(false);
                    }
                  } catch (e) {
                    toast((e as Error).message, true);
                  }
                }}
              >
                Send the invitation
              </button>
            )
          }
        >
          <div className="modal-body">
            {link ? (
              <div className="wide">
                <p style={{ marginTop: 0 }}>Email is not set up here, so send your CA this link (valid for 7 days):</p>
                <input readOnly value={link} onFocus={(e) => e.target.select()} />
              </div>
            ) : (
              <>
                <label className="field">
                  Name
                  <input value={f.fullName} onChange={(e) => setF({ ...f, fullName: e.target.value })} placeholder="CA Rakesh Gupta" />
                </label>
                <label className="field">
                  Email
                  <input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
                </label>
                <label className="field">
                  Firm
                  <input value={f.firm} onChange={(e) => setF({ ...f, firm: e.target.value })} placeholder="Gupta & Associates" />
                </label>
                <label className="row small" style={{ alignSelf: 'end' }}>
                  <input type="checkbox" checked={f.assignFilings} onChange={(e) => setF({ ...f, assignFilings: e.target.checked })} /> Make them responsible for the open filings
                </label>
                <p className="small muted wide" style={{ margin: 0 }}>
                  They sign in with their own password (and two-factor if your workspace requires it) and see only the CA portal. Every change they make is in the audit trail under their name.
                </p>
              </>
            )}
          </div>
        </Modal>
      )}
    </div>
  );
}

/** The conversation between the business and its CA on one filing. */
function Conversation({ itemId }: { itemId: string }) {
  const toast = useToast();
  const { data, refetch } = useQuery({ queryKey: ['books', 'compliance-comments', itemId], queryFn: () => get<Json[]>(`/api/v1/books/compliance/items/${itemId}/comments`) });
  const [body, setBody] = useState('');
  return (
    <div className="wide">
      <div className="small" style={{ fontWeight: 600, marginBottom: 6 }}>
        Conversation
      </div>
      <div className="stack" style={{ gap: 6, maxHeight: 220, overflow: 'auto', marginBottom: 6 }}>
        {(data ?? []).map((m) => (
          <div key={m.id} style={{ alignSelf: m.from_ca ? 'flex-start' : 'flex-end', maxWidth: '80%', background: m.from_ca ? 'var(--surface-2)' : 'var(--brand-50)', border: '1px solid var(--line)', borderRadius: 10, padding: '6px 10px' }}>
            <div className="small" style={{ whiteSpace: 'pre-wrap' }}>{m.body}</div>
            <div className="small muted" style={{ fontSize: 11 }}>
              {m.author}
              {m.from_ca ? ' (CA)' : ''} · {new Date(m.created_at).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}
            </div>
          </div>
        ))}
        {!data?.length && <span className="small muted">No messages yet. Ask for a document, share a query or note what was filed.</span>}
      </div>
      <div className="row">
        <input value={body} onChange={(e) => setBody(e.target.value)} placeholder="Write a message…" onKeyDown={(e) => e.key === 'Enter' && body.trim() && (e.currentTarget.nextElementSibling as HTMLButtonElement)?.click()} />
        <button
          className="btn sm"
          disabled={!body.trim()}
          onClick={async () => {
            try {
              await post(`/api/v1/books/compliance/items/${itemId}/comments`, { body: body.trim() });
              setBody('');
              refetch();
            } catch (e) {
              toast((e as Error).message, true);
            }
          }}
        >
          Send
        </button>
      </div>
    </div>
  );
}
