/**
 * Books → Accounts desk: the agents that keep the books (bank clerk, bookkeeper, compliance clerk,
 * controller), the review queue where people approve, change or reject what they propose, what they
 * found, the month-end close, and where bank transactions come from (statements and live feeds).
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { del, get, patch, post, put } from '../../lib/api';
import { date, money2 } from '../../lib/format';
import { combineStatements, PdfPasswordError, readStatementFile, type StatementLine } from '../../lib/statement';
import { SelectAll } from '../SelectAll';
import { InvoiceImport } from './InvoiceImport';
import { OwnAccounts } from './OwnAccounts';
import { Empty, Modal, Spinner, useToast } from '../ui';

type Json = Record<string, any>;
type View = 'queue' | 'findings' | 'close' | 'sources' | 'own' | 'invoices' | 'activity';

const AUTONOMY: [string, string, string][] = [
  ['auto_sure', 'Book the sure ones, ask about the rest', 'Your bank rules, exact matches to invoices, bills and entries, and payees always booked the same way are posted by the agents. Everything else waits for you.'],
  ['suggest', 'Suggest only', 'Nothing is posted until a person approves it.'],
  ['auto_all', 'Book everything above the threshold', 'The agents post every suggestion at or above the confidence threshold; you review afterwards (everything can be undone in Banking).'],
];
const SOURCE: Record<string, string> = { rule: 'Your rule', ledger: 'Posted entry', invoice: 'Open invoice', bill: 'Open bill', gateway: 'Razorpay settlement', missing: 'Nothing in the books fits', history: 'Booked like this before', keyword: 'Narration', ai: 'AI', person: 'You', own: 'Own account' };
const KIND: Record<string, string> = { match: 'Match', receipt: 'Receipt', vendor_payment: 'Vendor payment', categorize: 'Categorise', exclude: 'Exclude', settlement: 'Settlement', new_party: 'New party' };
const ROLE: Record<string, string> = {
  existing_customer: 'Customer advance',
  paid_for_customer: 'Paid for a customer',
  new_customer: 'New customer',
  existing_vendor: 'Vendor advance',
  new_vendor: 'New vendor',
};
/** What a suggestion is, in a word or two: who the money is from or to, not just how it is booked. */
function kindLabel(p: Json): string {
  if (p.kind === 'new_party') return ROLE[p.payload?.role] ?? (p.amount > 0 ? 'New customer' : 'New vendor');
  if (p.kind === 'categorize' && p.payload?.ownPersonId) return 'Partner / owner';
  if (p.kind === 'categorize' && p.payload?.newParty) return p.payload.newParty.type === 'vendor' ? 'Expense · new vendor' : 'Income · new customer';
  if (p.kind === 'receipt' && p.payload?.payerName) return 'Receipt · new contact';
  return KIND[p.kind] ?? p.kind;
}
const SEV: Record<string, [string, string]> = { risk: ['Risk', 'bad'], warn: ['Needs attention', 'warn'], info: ['Note', 'info'] };
const AGENT_ICON: Record<string, string> = { bank_clerk: '🏦', bookkeeper: '📒', compliance: '🧾', controller: '📊' };

const ago = (s: string | null | undefined) => {
  if (!s) return 'never';
  const m = Math.round((Date.now() - Date.parse(s)) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
};
const ymNow = () => new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 7);
const ymPrev = () => {
  const d = new Date(Date.now() + 5.5 * 3_600_000);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
};
const monthName = (ym: string) => new Date(`${ym}-01T00:00:00Z`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' });

function Confidence({ v }: { v: number }) {
  const pct = Math.round(v * 100);
  const tone = v >= 0.9 ? 'var(--good)' : v >= 0.7 ? 'var(--accent)' : '#c2410c';
  return (
    <div title={`${pct}% sure`} style={{ minWidth: 70 }}>
      <div style={{ height: 6, borderRadius: 3, background: 'var(--line-2)' }}>
        <div style={{ width: `${pct}%`, height: 6, borderRadius: 3, background: tone }} />
      </div>
      <div className="muted small">{pct}%</div>
    </div>
  );
}

export function AccountsDesk({ go }: { go?: (tab: string) => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { data, error } = useQuery({ queryKey: ['books', 'desk'], queryFn: () => get<Json>('/api/v1/books/desk') });
  const [view, setView] = useState<View>('queue');
  const [running, setRunning] = useState(false);
  const [settings, setSettings] = useState(false);
  const refresh = () => qc.invalidateQueries({ queryKey: ['books'] });

  const runAll = async () => {
    setRunning(true);
    try {
      const r = await post<Json>('/api/v1/books/desk/run', { agents: ['bank_clerk', 'bookkeeper', 'compliance'] });
      const k = r.bookkeeper ?? {};
      toast(k.error ? `Bookkeeper: ${k.error}` : `Done: ${k.applied ?? 0} booked, ${k.waiting ?? 0} waiting for you${r.bank_clerk?.added ? `, ${r.bank_clerk.added} new from feeds` : ''}`, !!k.error);
      refresh();
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setRunning(false);
    }
  };

  if (error) return <Empty title="The accounts desk could not load">{(error as Error).message}</Empty>;
  if (!data) return <Spinner />;
  const c = data.counts ?? {};
  const s = data.settings ?? {};
  return (
    <div className="stack">
      <div className="spread" style={{ flexWrap: 'wrap', gap: 10 }}>
        <div>
          <h2 style={{ margin: 0 }}>Accounts desk</h2>
          <div className="muted small">
            Four agents keep the books; you approve what they aren't sure about. Mode: <b>{AUTONOMY.find((a) => a[0] === s.autonomy)?.[1]}</b>
            {s.useAi ? ' · AI on' : ' · AI off'}
            {!s.enabled && ' · paused'}
          </div>
        </div>
        <div className="row">
          <button className="btn sm" onClick={() => setSettings(true)}>
            Settings
          </button>
          <button className="btn sm primary" disabled={running} onClick={runAll}>
            {running ? 'Working…' : 'Run the desk now'}
          </button>
        </div>
      </div>

      <div className="kpis" style={{ margin: 0 }}>
        <button className="panel kpi" style={{ textAlign: 'left', cursor: 'pointer' }} onClick={() => setView('queue')}>
          <div className="l">Waiting for you</div>
          <div className="v" style={{ color: c.pending ? 'var(--accent)' : undefined }}>{c.pending ?? 0}</div>
          <div className="muted small">{c.unmatched ?? 0} bank line(s) not booked yet</div>
        </button>
        <div className="panel kpi">
          <div className="l">Booked in the last 30 days</div>
          <div className="v">{(c.auto_month ?? 0) + (c.person_month ?? 0)}</div>
          <div className="muted small">
            {c.auto_month ?? 0} by the agents · {c.person_month ?? 0} approved by you
          </div>
        </div>
        <button className="panel kpi" style={{ textAlign: 'left', cursor: 'pointer' }} onClick={() => setView('findings')}>
          <div className="l">Open findings</div>
          <div className="v" style={{ color: c.risks ? 'var(--bad)' : undefined }}>{c.findings ?? 0}</div>
          <div className="muted small">{c.risks ?? 0} risk(s): GST, TDS and month-end</div>
        </button>
        <button className="panel kpi" style={{ textAlign: 'left', cursor: 'pointer' }} onClick={() => setView('close')}>
          <div className="l">Last month-end close</div>
          <div className="v" style={{ fontSize: 20 }}>{data.lastClose ? monthName(data.lastClose.period) : '—'}</div>
          <div className="muted small">{data.lastClose ? (data.lastClose.stats?.ready ? 'Ready to close' : `${data.lastClose.stats?.checklist ?? 0} item(s) open`) : 'Not run yet'}</div>
        </button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))', gap: 10 }}>
        {(data.agents as Json[]).map((a) => (
          <div key={a.key} className="panel" style={{ padding: 12 }}>
            <div className="spread">
              <b>
                {AGENT_ICON[a.key]} {a.name}
              </b>
              <span className="muted small">{ago(a.lastRun?.finished_at ?? a.lastRun?.started_at)}</span>
            </div>
            <div className="muted small" style={{ margin: '4px 0 6px' }}>
              {a.role}
            </div>
            <div className="small" style={{ color: a.lastRun?.error ? 'var(--bad)' : undefined }}>
              {a.lastRun ? (a.lastRun.error ?? a.lastRun.summary ?? 'Working…') : 'Has not run yet.'}
            </div>
          </div>
        ))}
      </div>

      <div className="tabs" role="tablist" style={{ padding: 0 }}>
        {(
          [
            ['queue', `Review queue${c.pending ? ` (${c.pending})` : ''}`],
            ['findings', `Findings${c.findings ? ` (${c.findings})` : ''}`],
            ['close', 'Month-end close'],
            ['sources', 'Bank feeds & statements'],
            ['own', 'Own accounts'],
            ['invoices', 'Import invoices'],
            ['activity', 'Activity'],
          ] as [View, string][]
        ).map(([k, l]) => (
          <button key={k} role="tab" aria-selected={view === k} onClick={() => setView(k)}>
            {l}
          </button>
        ))}
      </div>
      {view === 'queue' && <Queue />}
      {view === 'findings' && <Findings go={go} setView={setView} />}
      {view === 'close' && <Close last={data.lastClose} go={go} />}
      {view === 'sources' && <Sources />}
      {view === 'own' && <OwnAccounts />}
      {view === 'invoices' && <InvoiceImport />}
      {view === 'activity' && <Activity />}
      {settings && <SettingsModal current={s} onClose={() => setSettings(false)} onSaved={refresh} />}
    </div>
  );
}

/* ───────────────────────── settings ───────────────────────── */

function SettingsModal({ current, onClose, onSaved }: { current: Json; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [f, setF] = useState({ autonomy: current.autonomy ?? 'auto_sure', minConfidence: current.minConfidence ?? 0.6, useAi: current.useAi ?? true, enabled: current.enabled ?? true });
  const save = async () => {
    try {
      await put('/api/v1/books/desk/settings', f);
      toast('Saved');
      onSaved();
      onClose();
    } catch (e) {
      toast((e as Error).message, true);
    }
  };
  return (
    <Modal
      title="Accounts desk settings"
      onClose={onClose}
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={save}>
            Save
          </button>
        </>
      }
    >
      <div className="modal-body stack">
        <div className="field">
          How much the agents do on their own
          {AUTONOMY.map(([k, l, d]) => (
            <label key={k} className="row" style={{ alignItems: 'flex-start', gap: 8, fontWeight: 400 }}>
              <input type="radio" name="autonomy" checked={f.autonomy === k} onChange={() => setF({ ...f, autonomy: k })} style={{ marginTop: 4 }} />
              <span>
                <b>{l}</b>
                <div className="muted small">{d}</div>
              </span>
            </label>
          ))}
        </div>
        {f.autonomy === 'auto_all' && (
          <label className="field">
            Confidence threshold: {Math.round(f.minConfidence * 100)}%
            <input type="range" min={0.5} max={0.99} step={0.01} value={f.minConfidence} onChange={(e) => setF({ ...f, minConfidence: Number(e.target.value) })} />
          </label>
        )}
        <label className="row" style={{ gap: 8 }}>
          <input type="checkbox" checked={f.useAi} onChange={(e) => setF({ ...f, useAi: e.target.checked })} />
          Use AI for lines the rules can't place (uses your AI model settings; bank narrations are sent to the model)
        </label>
        <label className="row" style={{ gap: 8 }}>
          <input type="checkbox" checked={f.enabled} onChange={(e) => setF({ ...f, enabled: e.target.checked })} />
          Run every day on its own (feeds, bookkeeping, GST/TDS checks; the month-end close in the first week)
        </label>
      </div>
    </Modal>
  );
}

/* ───────────────────────── review queue ───────────────────────── */

function Queue() {
  const qc = useQueryClient();
  const toast = useToast();
  const [status, setStatus] = useState<'pending' | 'done'>('pending');
  const { data } = useQuery({ queryKey: ['books', 'desk', 'proposals', status], queryFn: () => get<Json[]>(`/api/v1/books/desk/proposals?status=${status}`) });
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [change, setChange] = useState<Json | null>(null);
  const [grouping, setGrouping] = useState(false);
  const [q, setQ] = useState('');
  const refresh = () => {
    setSel(new Set());
    qc.invalidateQueries({ queryKey: ['books'] });
  };
  const act = async (fn: () => Promise<Json>, ok: (r: Json) => string) => {
    setBusy(true);
    try {
      const r = await fn();
      toast(ok(r));
      refresh();
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  };
  const rows = (data ?? []).filter((p) => !q.trim() || `${p.description} ${p.title} ${p.counterparty ?? ''}`.toLowerCase().includes(q.trim().toLowerCase()));
  const sure = rows.filter((p) => p.confidence >= 0.9);
  return (
    <div className="stack">
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <div className="seg">
          <button aria-pressed={status === 'pending'} onClick={() => setStatus('pending')}>
            Waiting
          </button>
          <button aria-pressed={status === 'done'} onClick={() => setStatus('done')}>
            Decided
          </button>
        </div>
        {status === 'pending' && rows.length > 0 && (
          <>
            <button className="btn sm primary" disabled={busy || !sel.size} onClick={() => act(() => post<Json>('/api/v1/books/desk/proposals/approve', { ids: [...sel] }), (r) => `${r.approved} approved${r.results.some((x: Json) => !x.ok) ? `; ${r.results.filter((x: Json) => !x.ok).length} could not be applied` : ''}`)}>
              Approve selected{sel.size ? ` (${sel.size})` : ''}
            </button>
            <button className="btn sm ghost" disabled={busy || !sure.length} onClick={() => setSel(new Set(sure.map((p) => p.id)))}>
              Select the 90%+ ones ({sure.length})
            </button>
            {sel.size > 0 && (
              <button className="btn sm ghost" onClick={() => setSel(new Set())}>
                Clear
              </button>
            )}
          </>
        )}
        <button className="btn sm" style={{ marginLeft: 'auto' }} title="Lines with no suggestion, grouped by payee" onClick={() => setGrouping(true)}>
          Book by payee
        </button>
        <input placeholder="Search narration…" value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 240 }} />
      </div>
      {!data ? (
        <Spinner />
      ) : !rows.length ? (
        <Empty title={status === 'pending' ? 'Nothing waiting for you' : 'No decisions yet'}>
          {status === 'pending' ? 'Bring in bank lines (Bank feeds & statements) and the bookkeeper will suggest what each one is.' : 'Approved, changed and rejected suggestions appear here.'}
        </Empty>
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                {status === 'pending' && (
                  <th style={{ width: 28 }}>
                    <SelectAll ids={rows.map((p) => p.id)} sel={sel} setSel={setSel} />
                  </th>
                )}
                <th>Date</th>
                <th>Bank line</th>
                <th className="num">Amount</th>
                <th>Suggestion</th>
                <th>{status === 'pending' ? 'Sure' : 'Outcome'}</th>
                {status === 'pending' && <th />}
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.id}>
                  {status === 'pending' && (
                    <td>
                      <input
                        type="checkbox"
                        checked={sel.has(p.id)}
                        onChange={() =>
                          setSel((s) => {
                            const n = new Set(s);
                            if (n.has(p.id)) n.delete(p.id);
                            else n.add(p.id);
                            return n;
                          })
                        }
                      />
                    </td>
                  )}
                  <td className="small">{date(p.txn_date)}</td>
                  <td style={{ maxWidth: 260, whiteSpace: 'normal' }}>
                    <div className="small" style={{ wordBreak: 'break-word' }}>
                      {p.description}
                    </div>
                    <div className="muted small">
                      {p.bank_account}
                      {p.counterparty ? ` · ${p.counterparty}` : ''}
                      {p.reference ? ` · ${p.reference}` : ''}
                    </div>
                  </td>
                  <td className="num" style={{ color: p.amount > 0 ? 'var(--good)' : undefined, whiteSpace: 'nowrap' }}>
                    {p.amount > 0 ? '+' : '−'}
                    {money2(Math.abs(p.amount))}
                  </td>
                  <td style={{ minWidth: 260, maxWidth: 440, whiteSpace: 'normal' }}>
                    <div>
                      <span className="chip" style={{ marginRight: 6 }}>
                        {kindLabel(p)}
                      </span>
                      <b className="small">{p.title}</b>
                    </div>
                    <div className="muted small">
                      {SOURCE[p.source] ?? p.source}: {p.reason}
                    </div>
                    {p.error && <div className="small" style={{ color: 'var(--bad)' }}>{p.error}</div>}
                  </td>
                  <td>
                    {status === 'pending' ? (
                      <Confidence v={p.confidence} />
                    ) : (
                      <span className={`chip ${p.status === 'applied' ? 'good' : p.status === 'rejected' ? '' : 'warn'}`}>
                        {p.status === 'applied' ? (p.applied_by === 'agent' ? 'Booked by agent' : 'Approved') : p.status === 'rejected' ? 'Rejected' : p.status}
                      </span>
                    )}
                  </td>
                  {status === 'pending' && (
                    <td>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'stretch' }}>
                        <button className="btn sm primary" disabled={busy} onClick={() => act(() => post<Json>(`/api/v1/books/desk/proposals/${p.id}`, { decision: 'approve' }), () => 'Booked')}>
                          Approve
                        </button>
                        <button className="btn sm" disabled={busy} onClick={() => setChange(p)}>
                          Change
                        </button>
                        <button className="btn sm ghost" disabled={busy} title="Not this; the bookkeeper won't suggest it again" onClick={() => act(() => post<Json>(`/api/v1/books/desk/proposals/${p.id}`, { decision: 'reject' }), () => 'Rejected')}>
                          Reject
                        </button>
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="muted small">
        Lines with no suggestion at all are in Books → Banking, where you can categorise them by hand. Everything booked here can be undone there (un-match / un-categorise).
      </div>
      {change && <ChangeModal p={change} onClose={() => setChange(null)} onDone={refresh} />}
      {grouping && <BookByPayee onClose={() => setGrouping(false)} />}
    </div>
  );
}

interface Receipt {
  customerId: string;
  /** invoice id → amount applied ('' = its balance) */
  alloc: Record<string, string>;
  /** a receipt already recorded (invoice imported as paid) that this bank line is the money of */
  paymentId: string;
  /** what the unapplied money is for: 'project:<id>', 'contract:<id>', 'deal:<id>' */
  target: string;
  tds: string;
  gstTds: string;
}

function receiptChange(rc: Receipt, docs: Json | undefined) {
  if (rc.paymentId) return { kind: 'receipt', paymentId: rc.paymentId };
  const inv = (docs?.invoices ?? []) as Json[];
  const allocations = Object.entries(rc.alloc).map(([invoiceId, a]) => ({ invoiceId, amount: Number(a) || Number(inv.find((x) => x.id === invoiceId)?.balance ?? 0) })).filter((x) => x.amount > 0);
  const [tt, tid] = rc.target.split(':');
  const work = tid ? ((docs?.[tt === 'project' ? 'projects' : tt === 'contract' ? 'contracts' : 'deals'] ?? []) as Json[]).find((x) => x.id === tid) : null;
  const customerId = rc.customerId || (inv.find((x) => rc.alloc[x.id] !== undefined)?.account_id ?? work?.account_id ?? null);
  return {
    kind: 'receipt',
    allocations,
    customerId,
    tdsAmount: Number(rc.tds) || 0,
    gstTdsAmount: Number(rc.gstTds) || 0,
    projectId: tt === 'project' ? tid : null,
    contractId: tt === 'contract' ? tid : null,
    dealId: tt === 'deal' ? tid : null,
  };
}

/**
 * Money received: for one or more invoices of a customer (open ones, with the amount for each), for the
 * receipt already recorded of an invoice imported as paid, or as an advance for a project, contract
 * (monthly maintenance…) or deal; part for invoices and the rest as an advance works too.
 */
function ReceiptFor({ amount, docs, customers, value, onChange }: { amount: number; docs: Json | undefined; customers: Json[]; value: Receipt; onChange: (r: Receipt) => void }) {
  const [q, setQ] = useState('');
  const [showPaid, setShowPaid] = useState(false);
  const inv = (docs?.invoices ?? []) as Json[];
  const chosenCustomer = value.customerId || inv.find((x) => value.alloc[x.id] !== undefined)?.account_id || '';
  // the same customer may be on file twice ("Food Corporation of India" and "Food Corporation of India, Zonal Office (North)")
  const key = (n: string) =>
    n
      .toLowerCase()
      .replace(/\b(the|of|and|ltd|limited|pvt|private|llp|india|inc)\b/g, ' ')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim()
      .split(' ')
      .filter((w) => w.length >= 3)
      .slice(0, 2)
      .join(' ');
  const chosenName = customers.find((c) => c.id === chosenCustomer)?.name ?? inv.find((x) => x.account_id === chosenCustomer)?.party ?? '';
  const match = (x: Json) => !q || `${x.number ?? ''} ${x.party} ${x.subject ?? ''} ${x.project ?? ''} ${x.deal ?? ''} ${x.recurring ?? ''}`.toLowerCase().includes(q.toLowerCase());
  const mine = (x: Json) => !chosenCustomer || x.account_id === chosenCustomer || (!!key(chosenName) && key(String(x.party)) === key(chosenName));
  const open = inv.filter((x) => ['issued', 'partially_paid'].includes(x.status) && x.balance > 0 && mine(x) && match(x));
  const paid = inv.filter((x) => x.status === 'paid' && x.unbanked && mine(x) && match(x));
  const drafts = inv.filter((x) => x.status === 'draft' && mine(x) && match(x));
  const applied = Object.entries(value.alloc).reduce((a, [id, v]) => a + (Number(v) || Number(inv.find((x) => x.id === id)?.balance ?? 0)), 0);
  const total = amount + (Number(value.tds) || 0) + (Number(value.gstTds) || 0);
  // short of the invoices by what a government buyer deducts: TDS (1%, 2% or 10%) and GST TDS (2%) on the taxable value
  const picked = inv.filter((x) => value.alloc[x.id] !== undefined);
  const due = picked.reduce((a, x) => a + x.balance, 0);
  const taxable = picked.reduce((a, x) => a + (x.taxable ?? 0), 0);
  const short = Math.round((due - amount) * 100) / 100;
  const r2 = (n: number) => Math.round(n * 100) / 100;
  const fits: { label: string; tds: number; gst: number }[] = [];
  if (short > 0.5 && taxable > 0)
    for (const t of [0, 0.01, 0.02, 0.1])
      for (const g of [0, 0.02]) {
        const tds = r2(taxable * t);
        const gst = r2(taxable * g);
        if ((tds || gst) && Math.abs(tds + gst - short) <= 1) fits.push({ label: [tds ? `TDS ${t * 100}% (${money2(tds)})` : null, gst ? `GST TDS 2% (${money2(gst)})` : null].filter(Boolean).join(' + '), tds, gst });
      }
  const rest = Math.round((total - applied) * 100) / 100;
  const toggle = (x: Json, on: boolean) => {
    const next = { ...value.alloc };
    if (on) {
      const room = Math.max(0, Math.round((total - applied) * 100) / 100);
      next[x.id] = String(Math.min(x.balance, room || x.balance));
    } else delete next[x.id];
    onChange({ ...value, alloc: next, paymentId: '', customerId: on ? x.account_id : value.customerId });
  };
  const targets = [
    ...((docs?.contracts ?? []) as Json[]).filter((c) => !chosenCustomer || c.account_id === chosenCustomer).map((c) => [`contract:${c.id}`, `Contract ${c.number} · ${c.name}`]),
    ...((docs?.projects ?? []) as Json[]).filter((c) => !chosenCustomer || c.account_id === chosenCustomer).map((c) => [`project:${c.id}`, `Project · ${c.name}`]),
    ...((docs?.deals ?? []) as Json[]).filter((c) => !chosenCustomer || c.account_id === chosenCustomer).map((c) => [`deal:${c.id}`, `Deal · ${c.name}`]),
  ];
  const cell = { padding: '4px 6px' };
  return (
    <div className="stack" style={{ gap: 8 }}>
      <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
        <select value={chosenCustomer} onChange={(e) => onChange({ ...value, customerId: e.target.value, alloc: {}, paymentId: '', target: '' })} style={{ maxWidth: 260 }} aria-label="Customer">
          <option value="">All customers</option>
          {customers.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <input placeholder="Search number, project, maintenance…" value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 260 }} />
      </div>
      <div style={{ maxHeight: 260, overflowY: 'auto', border: '1px solid var(--line)', borderRadius: 8 }}>
        <table className="data small" style={{ margin: 0 }}>
          <thead>
            <tr>
              <th />
              <th>Invoice</th>
              <th>Customer</th>
              <th>For</th>
              <th className="num">Balance</th>
              <th className="num">Apply</th>
            </tr>
          </thead>
          <tbody>
            {open.map((x) => {
              const on = value.alloc[x.id] !== undefined;
              return (
                <tr key={x.id}>
                  <td style={cell}>
                    <input type="checkbox" checked={on} onChange={(e) => toggle(x, e.target.checked)} aria-label={`Apply to ${x.number}`} />
                  </td>
                  <td style={cell}>
                    {x.number}
                    <div className="muted">{x.date}</div>
                  </td>
                  <td style={cell}>{x.party}</td>
                  <td style={cell}>{[x.recurring ? `🔁 ${x.recurring}` : null, x.project ? `Project: ${x.project}` : null, x.deal && !x.recurring ? `Deal: ${x.deal}` : null, !x.project && !x.recurring ? x.subject : null].filter(Boolean).join(' · ')}</td>
                  <td style={cell} className="num">
                    {money2(x.balance, x.currency ?? 'INR')}
                  </td>
                  <td style={{ ...cell, width: 110 }}>{on && <input className="num" value={value.alloc[x.id]} onChange={(e) => onChange({ ...value, alloc: { ...value.alloc, [x.id]: e.target.value } })} />}</td>
                </tr>
              );
            })}
            {!open.length && (
              <tr>
                <td colSpan={6} className="muted" style={cell}>
                  No open invoices{chosenCustomer ? ' for this customer' : ''}
                  {q ? ' matching the search' : ''}.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {paid.length > 0 && (
        <details open={showPaid} onToggle={(e) => setShowPaid((e.target as HTMLDetailsElement).open)}>
          <summary className="small">Invoices already marked paid whose money is not matched to a bank line yet ({paid.length})</summary>
          {paid.map((x) => {
            const pid = String(x.unbanked).split(',')[0]!.split(':')[0]!;
            return (
              <label key={x.id} className="row small" style={{ gap: 6 }}>
                <input type="radio" name="paid-receipt" checked={value.paymentId === pid} onChange={() => onChange({ ...value, paymentId: pid, alloc: {}, target: '' })} />
                {x.number} · {x.party} · {money2(x.total, x.currency ?? 'INR')} · {x.date} — this bank line is its money
              </label>
            );
          })}
        </details>
      )}
      {fits.length > 0 && !value.paymentId && (
        <div className="small" style={{ background: 'var(--panel-2, #f4f6fb)', padding: 8, borderRadius: 6 }}>
          The bank line is {money2(short)} less than the invoice{picked.length > 1 ? 's' : ''}: that is exactly{' '}
          {fits.map((f, i) => (
            <button
              key={i}
              className="btn sm"
              style={{ marginLeft: 4 }}
              onClick={() => onChange({ ...value, tds: String(f.tds), gstTds: String(f.gst), alloc: Object.fromEntries(picked.map((x) => [x.id, String(x.balance)])) })}
            >
              {f.label} deducted
            </button>
          ))}
        </div>
      )}
      {(docs?.pendingImports?.n ?? 0) > 0 && (
        <div className="small" style={{ color: 'var(--warn)' }}>
          {docs!.pendingImports.n} imported invoice(s){docs!.pendingImports.customers ? ` (${docs!.pendingImports.customers})` : ''} are still waiting for approval in Accounts desk → Import invoices: approve them to see them here.
        </div>
      )}
      {drafts.length > 0 && <div className="small muted">{drafts.length} draft invoice(s) are not shown: issue them first (Invoices) to apply money to them.</div>}
      {!value.paymentId && (
        <>
          <div className="small">
            Bank line {money2(amount)}
            {Number(value.tds) ? ` + TDS ${money2(Number(value.tds))}` : ''}
            {Number(value.gstTds) ? ` + GST TDS ${money2(Number(value.gstTds))}` : ''} · applied to invoices {money2(applied)} ·{' '}
            {rest > 0.004 ? <b>{money2(rest)} left as an advance</b> : rest < -0.004 ? <b style={{ color: 'var(--bad)' }}>{money2(-rest)} more than received</b> : 'all applied'}
          </div>
          {(rest > 0.004 || !Object.keys(value.alloc).length) && (
            <label className="field">
              {Object.keys(value.alloc).length ? 'The rest is an advance for' : 'No invoice yet? It is an advance for'}
              <select value={value.target} onChange={(e) => onChange({ ...value, target: e.target.value })}>
                <option value="">{chosenCustomer ? 'The customer (not tied to any work)' : 'Choose the customer above, or the work below'}</option>
                {targets.map(([k, l]) => (
                  <option key={k} value={k}>
                    {l}
                  </option>
                ))}
              </select>
            </label>
          )}
          <div className="grid2">
            <label className="field">
              TDS deducted by the customer
              <input type="number" min={0} step="0.01" value={value.tds} onChange={(e) => onChange({ ...value, tds: e.target.value })} />
            </label>
            <label className="field">
              GST TDS deducted (government buyers)
              <input type="number" min={0} step="0.01" value={value.gstTds} onChange={(e) => onChange({ ...value, gstTds: e.target.value })} />
            </label>
          </div>
        </>
      )}
    </div>
  );
}

/** a short default for "remember as a rule": the narration's first distinctive words */
const ruleText = (description: string, counterparty?: string | null) =>
  (counterparty && counterparty.length >= 3 ? counterparty : description)
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter((w) => w.length >= 3 && !/\d/.test(w) && !['UPI', 'NEFT', 'IMPS', 'RTGS', 'TRF', 'FROM', 'PAYMENT', 'TRANSFER'].includes(w))
    .slice(0, 2)
    .join(' ');

function ChangeModal({ p, onClose, onDone }: { p: Json; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const inflow = p.amount > 0;
  const accounts = useQuery({ queryKey: ['books', 'accounts'], queryFn: () => get<Json[]>('/api/v1/books/accounts'), staleTime: 30_000 });
  const docs = useQuery({ queryKey: ['books', 'desk', 'open-documents'], queryFn: () => get<Json>('/api/v1/books/desk/open-documents') });
  const customers = useQuery({ queryKey: ['books', 'parties', 'accounts_receivable'], queryFn: () => get<{ items: Json[] }>('/api/v1/records/account?limit=200&sort=name&dir=asc') });
  const vendors = useQuery({ queryKey: ['books', 'parties', 'accounts_payable'], queryFn: () => get<{ items: Json[] }>('/api/v1/records/vendor?limit=200&sort=name&dir=asc') });
  const initialKind = p.kind === 'categorize' && p.payload?.ownPersonId ? 'partner' : ['receipt', 'vendor_payment', 'categorize', 'new_party'].includes(p.kind) ? p.kind : 'categorize';
  const own = useQuery({ queryKey: ['books', 'desk', 'own'], queryFn: () => get<Json>('/api/v1/books/desk/own'), staleTime: 30_000 });
  const [kind, setKind] = useState<string>(initialKind);
  const [f, setF] = useState<Json>({
    accountId: p.kind === 'categorize' ? (p.payload.accountId ?? '') : '',
    partyId: p.kind === 'categorize' ? (p.payload.partyId ?? '') : '',
    invoiceId: p.payload.invoiceId ?? '',
    billId: p.payload.billId ?? '',
    tdsAmount: p.payload.tdsAmount ?? 0,
    narration: '',
    party: p.kind === 'new_party' ? (p.payload.partyId ?? 'new') : 'new',
    partyName: p.kind === 'new_party' ? (p.payload.name ?? '') : (p.counterparty ?? ''),
    contactName: p.payload?.contactName ?? '',
    personId: p.payload?.ownPersonId ?? 'new',
    personName: p.kind === 'new_party' && !p.payload?.partyId ? (p.payload.name ?? '') : '',
    personRole: 'partner',
  });
  const [rc, setRc] = useState<Receipt>({ customerId: '', alloc: p.payload?.invoiceId ? { [p.payload.invoiceId]: '' } : {}, paymentId: '', target: '', tds: String(p.payload?.tdsAmount ?? 0), gstTds: '0' });
  const [rule, setRule] = useState(false);
  const [ruleText_, setRuleText] = useState(ruleText(p.description, p.counterparty));
  const [busy, setBusy] = useState(false);
  const acc = (accounts.data ?? []).find((a) => a.id === f.accountId);
  const needsParty = acc && ['accounts_receivable', 'accounts_payable'].includes(acc.subtype);
  const partyList = acc?.subtype === 'accounts_payable' ? (vendors.data?.items ?? []) : (customers.data?.items ?? []);
  const usable = (accounts.data ?? []).filter((a) => a.is_active && a.subtype !== 'retained_earnings');
  const groups = ['asset', 'liability', 'equity', 'income', 'expense'];
  const save = async () => {
    setBusy(true);
    try {
      const change =
        kind === 'categorize'
          ? { kind, accountId: f.accountId || null, partyType: needsParty ? (acc.subtype === 'accounts_payable' ? 'vendor' : 'customer') : null, partyId: needsParty ? f.partyId || null : null, narration: f.narration || null }
          : kind === 'receipt'
            ? receiptChange(rc, docs.data)
            : kind === 'vendor_payment'
              ? { kind, billId: f.billId || null }
              : kind === 'new_party'
                ? { kind, partyType: inflow ? 'customer' : 'vendor', partyId: f.party !== 'new' ? f.party : null, partyName: f.party === 'new' ? f.partyName : null, contactName: inflow && f.contactName.trim() ? f.contactName.trim() : null }
                : kind === 'partner'
                  ? { kind, personId: f.personId !== 'new' ? f.personId : null, personName: f.personId === 'new' ? f.personName : null, personRole: f.personRole }
                  : { kind };
      await post(`/api/v1/books/desk/proposals/${p.id}`, { decision: 'approve', change, makeRule: rule && kind === 'categorize' && ruleText_.trim().length >= 2 ? { contains: ruleText_.trim() } : null });
      toast(rule ? 'Booked, and the rule will book lines like it from now on' : 'Booked');
      onDone();
      onClose();
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title="What is this bank line?"
      onClose={onClose}
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy} onClick={save}>
            Book it
          </button>
        </>
      }
    >
      <div className="modal-body stack">
        <div className="panel" style={{ padding: 10 }}>
          <div className="small">{p.description}</div>
          <div className="muted small">
            {date(p.txn_date)} · {p.bank_account} · <b style={{ color: inflow ? 'var(--good)' : undefined }}>{inflow ? '+' : '−'}{money2(Math.abs(p.amount))}</b>
          </div>
        </div>
        <div className="seg">
          {(inflow ? ['receipt', 'new_party', 'partner', 'categorize', 'exclude'] : ['vendor_payment', 'new_party', 'partner', 'categorize', 'exclude']).map((k) => (
            <button key={k} aria-pressed={kind === k} onClick={() => setKind(k)}>
              {k === 'receipt'
                ? 'Against an invoice'
                : k === 'vendor_payment'
                  ? 'Against a bill'
                  : k === 'new_party'
                    ? inflow
                      ? 'Customer (or paid for one)'
                      : 'Vendor'
                    : k === 'partner'
                      ? 'Partner / owner money'
                      : k === 'categorize'
                        ? 'Book to an account'
                        : 'Not business'}
            </button>
          ))}
        </div>
        {kind === 'categorize' && (
          <>
            <label className="field">
              Account
              <select value={f.accountId} onChange={(e) => setF({ ...f, accountId: e.target.value, partyId: '' })}>
                <option value="">Choose account</option>
                {groups.map((g) => {
                  const xs = usable.filter((a) => a.type === g);
                  return xs.length ? (
                    <optgroup key={g} label={g[0]!.toUpperCase() + g.slice(1)}>
                      {xs.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.code ? `${a.code} · ` : ''}
                          {a.name}
                        </option>
                      ))}
                    </optgroup>
                  ) : null;
                })}
              </select>
            </label>
            {needsParty && (
              <label className="field">
                {acc.subtype === 'accounts_payable' ? 'Vendor' : 'Customer'}
                <select value={f.partyId} onChange={(e) => setF({ ...f, partyId: e.target.value })}>
                  <option value="">Choose…</option>
                  {partyList.map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label className="field">
              Narration (optional)
              <input value={f.narration} maxLength={500} onChange={(e) => setF({ ...f, narration: e.target.value })} placeholder={p.description} />
            </label>
            <label className="row" style={{ gap: 8 }}>
              <input type="checkbox" checked={rule} onChange={(e) => setRule(e.target.checked)} />
              Always book lines whose narration contains
              <input value={ruleText_} onChange={(e) => setRuleText(e.target.value)} style={{ maxWidth: 180 }} disabled={!rule} />
              here
            </label>
          </>
        )}
        {kind === 'receipt' && <ReceiptFor amount={Math.abs(p.amount)} docs={docs.data} customers={customers.data?.items ?? []} value={rc} onChange={setRc} />}
        {kind === 'vendor_payment' && (
          <label className="field">
            Bill
            <select value={f.billId} onChange={(e) => setF({ ...f, billId: e.target.value })}>
              <option value="">Choose the bill</option>
              {(docs.data?.bills ?? []).map((b: Json) => (
                <option key={b.id} value={b.id}>
                  {b.number ?? 'Bill'} · {b.party} · balance {money2(b.balance)}
                </option>
              ))}
            </select>
          </label>
        )}
        {kind === 'new_party' && (
          <>
            <label className="field">
              {inflow ? 'Customer' : 'Vendor'}
              <select value={f.party} onChange={(e) => setF({ ...f, party: e.target.value })}>
                <option value="new">➕ New {inflow ? 'customer' : 'vendor'}…</option>
                {(inflow ? (customers.data?.items ?? []) : (vendors.data?.items ?? [])).map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.name}
                  </option>
                ))}
              </select>
            </label>
            {f.party === 'new' && (
              <label className="field">
                Name of the new {inflow ? 'customer' : 'vendor'}
                <input value={f.partyName} maxLength={120} onChange={(e) => setF({ ...f, partyName: e.target.value })} />
              </label>
            )}
            {inflow && (
              <label className="field">
                Paid by (optional: a person at this customer, added as their contact)
                <input value={f.contactName} maxLength={120} placeholder="e.g. Shalini Pathak" onChange={(e) => setF({ ...f, contactName: e.target.value })} />
              </label>
            )}
            <div className="muted small">
              The {inflow ? 'receipt' : 'payment'} is recorded against the {inflow ? 'customer' : 'vendor'} as an advance, so the bank line is booked now; it is applied to the {inflow ? 'invoice' : 'bill'} when that is
              {inflow ? ' raised' : ' entered'} (Payments → allocate).
            </div>
          </>
        )}
        {kind === 'partner' && (
          <>
            <label className="field">
              Partner / owner
              <select value={f.personId} onChange={(e) => setF({ ...f, personId: e.target.value })}>
                <option value="new">➕ Add to the partner list…</option>
                {((own.data?.persons ?? []) as Json[]).map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.name} ({x.role})
                  </option>
                ))}
              </select>
            </label>
            {f.personId === 'new' && (
              <div className="row" style={{ gap: 8 }}>
                <label className="field" style={{ flex: 2 }}>
                  Name
                  <input value={f.personName} maxLength={120} onChange={(e) => setF({ ...f, personName: e.target.value })} />
                </label>
                <label className="field" style={{ flex: 1 }}>
                  Role
                  <select value={f.personRole} onChange={(e) => setF({ ...f, personRole: e.target.value })}>
                    <option value="partner">Partner</option>
                    <option value="director">Director</option>
                    <option value="proprietor">Proprietor</option>
                    <option value="other">Other owner</option>
                  </select>
                </label>
              </div>
            )}
            <div className="muted small">
              {inflow ? 'Money brought in by them (capital or a loan)' : 'Money taken out by them (drawings or a repayment)'} is booked to their own account, not as {inflow ? 'a sale' : 'an expense'}. Someone new is added to
              Organisation → Partners &amp; directors, and their other lines are recognised from now on.
            </div>
          </>
        )}
        {kind === 'exclude' && <div className="muted small">The line stays in the statement but is left out of the books (e.g. a failed payment and its reversal).</div>}
      </div>
    </Modal>
  );
}

/* ───────────────────────── findings ───────────────────────── */

function Findings({ go, setView }: { go?: (tab: string) => void; setView: (v: View) => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [status, setStatus] = useState<'open' | 'done' | 'dismissed'>('open');
  const { data } = useQuery({ queryKey: ['books', 'desk', 'findings', status], queryFn: () => get<Json[]>(`/api/v1/books/desk/findings?status=${status}`) });
  const [running, setRunning] = useState(false);
  const [fixing, setFixing] = useState<string | null>(null);
  const [grouping, setGrouping] = useState(false);
  const navigate = useNavigate();
  const doAction = async (f: Json, a: Json) => {
    if (a.kind === 'tab') {
      if (['queue', 'findings', 'close', 'sources', 'own', 'invoices', 'activity'].includes(a.target)) setView(a.target as View);
      else go?.(a.target);
      return;
    }
    if (a.kind === 'link') {
      // findings made before the GSTR-2B review moved to Books → GST & TDS
      if (a.target === '/billing' && String(f.kind ?? '').startsWith('gstr2b') && go) a = { ...a, target: `/books#gst${f.period ? `:${f.period}` : ''}` };
      if (/^https?:/.test(a.target)) window.open(a.target, '_blank', 'noopener');
      else if (a.target.startsWith('/books#') && go) {
        // "/books#gst:2026-06": the Books tab, and the month to open there
        const [tab, month] = a.target.slice(7).split(':');
        try {
          if (month) sessionStorage.setItem('books.gstMonth', month);
        } catch {
          /* storage unavailable */
        }
        go(tab!);
      }
      else navigate(a.target);
      return;
    }
    if (a.kind === 'ui') {
      if (a.key === 'group') setGrouping(true);
      return;
    }
    if (a.confirm && !window.confirm(a.confirm)) return;
    setFixing(`${f.id}:${a.key}`);
    try {
      const r = await post<Json>(`/api/v1/books/desk/findings/${f.id}/fix`, { action: a.key });
      toast(`${r.message}${r.cleared ? ' — resolved' : ''}`);
      qc.invalidateQueries({ queryKey: ['books'] });
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setFixing(null);
    }
  };
  const set = async (id: string, st: string) => {
    try {
      await post(`/api/v1/books/desk/findings/${id}`, { status: st });
      qc.invalidateQueries({ queryKey: ['books'] });
    } catch (e) {
      toast((e as Error).message, true);
    }
  };
  const check = async () => {
    setRunning(true);
    try {
      const r = await post<Json>('/api/v1/books/desk/run', { agents: ['compliance'] });
      toast(r.compliance?.summary ?? 'Checked');
      qc.invalidateQueries({ queryKey: ['books'] });
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setRunning(false);
    }
  };
  return (
    <div className="stack">
      <div className="row" style={{ gap: 8 }}>
        <div className="seg">
          {(['open', 'done', 'dismissed'] as const).map((k) => (
            <button key={k} aria-pressed={status === k} onClick={() => setStatus(k)}>
              {k === 'open' ? 'Open' : k === 'done' ? 'Done' : 'Dismissed'}
            </button>
          ))}
        </div>
        <button className="btn sm" disabled={running} onClick={check}>
          {running ? 'Checking…' : 'Check GST & TDS now'}
        </button>
      </div>
      {!data ? (
        <Spinner />
      ) : !data.length ? (
        <Empty title={status === 'open' ? 'Nothing open' : 'Nothing here'}>The compliance clerk checks GST and TDS every day; the controller adds the month-end checklist.</Empty>
      ) : (
        <div className="stack" style={{ gap: 8 }}>
          {data.map((f) => (
            <div key={f.id} className="panel" style={{ padding: 12 }}>
              <div className="spread" style={{ alignItems: 'flex-start', gap: 10 }}>
                <div>
                  <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                    <span className={`chip ${SEV[f.severity]?.[1] ?? ''}`}>{SEV[f.severity]?.[0] ?? f.severity}</span>
                    <span className="muted small">{AGENT_ICON[f.agent]} {f.agent === 'controller' ? 'Controller' : f.agent === 'compliance' ? 'Compliance clerk' : f.agent}</span>
                  </div>
                  <b style={{ display: 'block', marginTop: 4 }}>{f.title}</b>
                  {f.body && <div className="muted small" style={{ marginTop: 2 }}>{f.body}</div>}
                  {status === 'open' && f.resolution && (f.resolution.steps?.length > 0 || f.resolution.actions?.length > 0) && (
                    <div style={{ marginTop: 8, padding: '8px 10px', borderRadius: 8, background: 'var(--accent-soft, #eef4ff)' }}>
                      <div className="small" style={{ fontWeight: 600, marginBottom: 4 }}>
                        How to resolve
                      </div>
                      {f.resolution.steps?.length > 0 && (
                        <ol className="small" style={{ margin: '0 0 6px', paddingLeft: 18 }}>
                          {(f.resolution.steps as string[]).map((st, i) => (
                            <li key={i} style={{ marginBottom: 2 }}>
                              {st}
                            </li>
                          ))}
                        </ol>
                      )}
                      {f.resolution.actions?.length > 0 && (
                        <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                          {(f.resolution.actions as Json[]).map((a) => (
                            <button key={a.key} className={`btn sm${a.primary ? ' primary' : ''}`} disabled={!!fixing} onClick={() => doAction(f, a)}>
                              {fixing === `${f.id}:${a.key}` ? 'Working…' : a.label}
                              {a.kind === 'link' && /^https?:/.test(a.target) ? ' ↗' : ''}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
                <div className="row" style={{ gap: 4, flexWrap: 'nowrap' }}>
                  {f.link &&
                    !(status === 'open' && f.resolution?.actions?.length) &&
                    (f.link.startsWith('/books#') && go ? (
                      <button className="btn sm" onClick={() => go(f.link.slice(7))}>
                        Open
                      </button>
                    ) : (
                      <Link className="btn sm" to={f.link}>
                        Open
                      </Link>
                    ))}
                  {status === 'open' ? (
                    <>
                      <button className="btn sm ghost" onClick={() => set(f.id, 'done')}>
                        Done
                      </button>
                      <button className="btn sm ghost" title="Hide it for 30 days" onClick={() => set(f.id, 'dismissed')}>
                        Dismiss
                      </button>
                    </>
                  ) : (
                    <button className="btn sm ghost" onClick={() => set(f.id, 'open')}>
                      Reopen
                    </button>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
      {grouping && <BookByPayee onClose={() => setGrouping(false)} />}
    </div>
  );
}

/** Bank lines nobody placed, grouped by payee: book a whole group to one account, optionally as a rule. */
export function BookByPayee({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { data, refetch } = useQuery({ queryKey: ['books', 'desk', 'unbooked'], queryFn: () => get<Json[]>('/api/v1/books/desk/unbooked') });
  const accounts = useQuery({ queryKey: ['books', 'accounts'], queryFn: () => get<Json[]>('/api/v1/books/accounts'), staleTime: 30_000 });
  const customers = useQuery({ queryKey: ['books', 'parties', 'accounts_receivable'], queryFn: () => get<{ items: Json[] }>('/api/v1/records/account?limit=200&sort=name&dir=asc') });
  const vendors = useQuery({ queryKey: ['books', 'parties', 'accounts_payable'], queryFn: () => get<{ items: Json[] }>('/api/v1/records/vendor?limit=200&sort=name&dir=asc') });
  const [pick, setPick] = useState<Record<string, { accountId: string; partyId: string; rule: boolean; ruleText: string; partyName?: string }>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const accs = (accounts.data ?? []).filter((a) => a.is_active && !['retained_earnings'].includes(a.subtype));
  const groupsOf = ['asset', 'liability', 'equity', 'income', 'expense'];
  const gid = (g: Json) => `${g.inflow ? 'in' : 'out'}|${g.key}`;
  const titleCase = (x: string) => x.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());
  const book = async (g: Json) => {
    const p: { accountId: string; partyId: string; rule: boolean; ruleText: string; partyName?: string } = pick[gid(g)] ?? { accountId: g.suggestedAccountId ?? '', partyId: '', rule: !!g.ruleText, ruleText: g.ruleText ?? '' };
    if (p.accountId.startsWith('adv:')) {
      const who = p.accountId.slice(4);
      const name = who === 'new' ? (p.partyName ?? titleCase(g.key)).trim() : null;
      if (who === 'new' && (!name || name.length < 2)) return toast('Name the new customer or vendor', true);
      setBusy(gid(g));
      try {
        const r = await post<Json>('/api/v1/books/desk/unbooked/book', { txnIds: g.txnIds, advance: { partyType: g.inflow ? 'customer' : 'vendor', partyId: who === 'new' ? null : who, name } });
        toast(`${r.booked} line(s) recorded as ${g.inflow ? 'receipts from' : 'payments to'} ${name ?? 'the ' + (g.inflow ? 'customer' : 'vendor')} (advance)${r.failed ? `; ${r.failed} not booked: ${r.errors[0]}` : ''}`, r.failed > 0);
        qc.invalidateQueries({ queryKey: ['books'] });
        refetch();
      } catch (e) {
        toast((e as Error).message, true);
      } finally {
        setBusy(null);
      }
      return;
    }
    const acc = accs.find((a) => a.id === p.accountId);
    if (!acc) return toast('Choose the account first', true);
    const needsParty = ['accounts_receivable', 'accounts_payable'].includes(acc.subtype);
    if (needsParty && !p.partyId) return toast(`Choose the ${acc.subtype === 'accounts_payable' ? 'vendor' : 'customer'}`, true);
    setBusy(gid(g));
    try {
      const r = await post<Json>('/api/v1/books/desk/unbooked/book', {
        txnIds: g.txnIds,
        accountId: p.accountId,
        partyType: needsParty ? (acc.subtype === 'accounts_payable' ? 'vendor' : 'customer') : null,
        partyId: needsParty ? p.partyId : null,
        rule: p.rule && p.ruleText.trim().length >= 2 ? { contains: p.ruleText.trim(), direction: g.inflow ? 'in' : 'out' } : null,
      });
      toast(`${r.booked} line(s) booked to ${acc.name}${r.rule ? '; lines like these will be booked automatically' : ''}${r.failed ? `; ${r.failed} not booked: ${r.errors[0]}` : ''}`, r.failed > 0);
      qc.invalidateQueries({ queryKey: ['books'] });
      refetch();
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy(null);
    }
  };
  const rows = (data ?? []).filter((g) => !q.trim() || `${g.key} ${g.samples.join(' ')}`.toLowerCase().includes(q.trim().toLowerCase()));
  return (
    <Modal title="Book bank lines by payee" onClose={onClose} wide>
      <div className="modal-body stack">
        <div className="row" style={{ gap: 8 }}>
          <span className="muted small">Bank lines not booked yet (other than ones matched to an invoice or bill), grouped by who was paid or who paid you. Choose the account once for a whole group; "Always" keeps it as a bank rule for next time.</span>
          <input placeholder="Search…" value={q} onChange={(e) => setQ(e.target.value)} style={{ marginLeft: 'auto', maxWidth: 200 }} />
        </div>
        {!data ? (
          <Spinner />
        ) : !rows.length ? (
          <Empty title="Nothing to place">Every bank line is booked or has a suggestion waiting in the review queue.</Empty>
        ) : (
          <div className="table-wrap" style={{ maxHeight: 520, overflow: 'auto' }}>
            <table className="data">
              <thead>
                <tr>
                  <th>Payee</th>
                  <th className="num">Lines</th>
                  <th className="num">Total</th>
                  <th>Book to</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((g) => {
                  const p: { accountId: string; partyId: string; rule: boolean; ruleText: string; partyName?: string } = pick[gid(g)] ?? { accountId: g.suggestedAccountId ?? '', partyId: '', rule: !!g.ruleText, ruleText: g.ruleText ?? '' };
                  const set = (x: Partial<typeof p>) => setPick((cur) => ({ ...cur, [gid(g)]: { ...p, ...x } }));
                  const adv = p.accountId.startsWith('adv:');
                  const partyList = g.inflow ? (customers.data?.items ?? []) : (vendors.data?.items ?? []);
                  const acc = accs.find((a) => a.id === p.accountId);
                  const parties = acc?.subtype === 'accounts_payable' ? (vendors.data?.items ?? []) : acc?.subtype === 'accounts_receivable' ? (customers.data?.items ?? []) : null;
                  return (
                    <tr key={gid(g)}>
                      <td style={{ whiteSpace: 'normal', maxWidth: 300 }}>
                        <b className="small">{g.key}</b> <span className={`chip ${g.inflow ? 'good' : ''}`}>{g.inflow ? 'money in' : 'money out'}</span>
                        <div className="muted small" style={{ wordBreak: 'break-word' }}>
                          {g.samples[0]}
                          {g.count > 1 ? ` · ${date(g.from)} – ${date(g.to)}` : ` · ${date(g.from)}`}
                        </div>
                      </td>
                      <td className="num">{g.count}</td>
                      <td className="num">{money2(g.total)}</td>
                      <td style={{ whiteSpace: 'normal', minWidth: 240 }}>
                        <select value={p.accountId} onChange={(e) => set({ accountId: e.target.value, partyId: '' })} style={{ width: '100%' }}>
                          <option value="">Choose account</option>
                          <optgroup label={g.inflow ? 'From a customer (kept as an advance)' : 'To a vendor (kept as an advance)'}>
                            <option value="adv:new">➕ New {g.inflow ? 'customer' : 'vendor'} “{titleCase(g.key)}”</option>
                            {partyList.map((x) => (
                              <option key={x.id} value={`adv:${x.id}`}>
                                {x.name}
                              </option>
                            ))}
                          </optgroup>
                          {groupsOf.map((t) => {
                            const xs = accs.filter((a) => a.type === t && (g.inflow ? a.type !== 'expense' : a.type !== 'income'));
                            return xs.length ? (
                              <optgroup key={t} label={t[0]!.toUpperCase() + t.slice(1)}>
                                {xs.map((a) => (
                                  <option key={a.id} value={a.id}>
                                    {a.name}
                                  </option>
                                ))}
                              </optgroup>
                            ) : null;
                          })}
                        </select>
                        {p.accountId === 'adv:new' && (
                          <input value={p.partyName ?? titleCase(g.key)} onChange={(e) => set({ partyName: e.target.value })} style={{ width: '100%', marginTop: 4 }} placeholder="Name" />
                        )}
                        {parties && (
                          <select value={p.partyId} onChange={(e) => set({ partyId: e.target.value })} style={{ width: '100%', marginTop: 4 }}>
                            <option value="">Choose {acc!.subtype === 'accounts_payable' ? 'vendor' : 'customer'}</option>
                            {parties.map((x) => (
                              <option key={x.id} value={x.id}>
                                {x.name}
                              </option>
                            ))}
                          </select>
                        )}
                        {!adv && <label className="small" style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6, fontWeight: 400, whiteSpace: 'nowrap' }}>
                          <input type="checkbox" checked={p.rule} onChange={(e) => set({ rule: e.target.checked })} />
                          Always, when the narration has
                        </label>}
                        {!adv && p.rule && <input value={p.ruleText} onChange={(e) => set({ ruleText: e.target.value })} style={{ width: '100%', marginTop: 4 }} placeholder="e.g. ZOMATO" />}
                      </td>
                      <td>
                        <button className="btn sm primary" disabled={!!busy || !p.accountId} onClick={() => book(g)}>
                          {busy === gid(g) ? 'Booking…' : `Book ${g.count}`}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Modal>
  );
}

/* ───────────────────────── month-end close ───────────────────────── */

function Close({ last, go }: { last: Json | null; go?: (tab: string) => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [period, setPeriod] = useState(last?.period ?? ymPrev());
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<Json | null>(null);
  const runs = useQuery({ queryKey: ['books', 'desk', 'runs', 'controller'], queryFn: () => get<Json[]>('/api/v1/books/desk/runs?agent=controller') });
  const findings = useQuery({ queryKey: ['books', 'desk', 'findings', 'all'], queryFn: () => get<Json[]>('/api/v1/books/desk/findings?status=all') });
  const run = (runs.data ?? []).find((r) => r.period === period && r.finished_at) ?? null;
  const stats = result?.figures ?? run?.stats ?? null;
  const note = result?.summary ?? run?.summary ?? null;
  const list = (findings.data ?? []).filter((f) => f.key.startsWith(`close:${period}:`));
  const close = async () => {
    setRunning(true);
    try {
      const r = await post<Json>('/api/v1/books/desk/run', { agents: ['controller'], period });
      if (r.controller?.error) throw new Error(r.controller.error);
      setResult(r.controller);
      qc.invalidateQueries({ queryKey: ['books'] });
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setRunning(false);
    }
  };
  const from = `${period}-01`;
  const to = new Date(Date.UTC(Number(period.slice(0, 4)), Number(period.slice(5, 7)), 0)).toISOString().slice(0, 10);
  return (
    <div className="stack">
      <div className="row" style={{ gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <label className="field">
          Month
          <input type="month" value={period} max={ymNow()} onChange={(e) => (setPeriod(e.target.value), setResult(null))} />
        </label>
        <button className="btn primary" disabled={running} onClick={close}>
          {running ? 'The controller is working…' : run ? 'Run the close again' : 'Close this month'}
        </button>
        <span className="muted small">The controller runs on its own in the first week of each month for the month before.</span>
      </div>
      {!stats ? (
        <Empty title={`${monthName(period)} has not been closed yet`}>The controller checks the month (bank lines, reconciliation, drafts, uncategorised amounts, depreciation, trial balance), works out the P&amp;L and balance sheet, and writes a short note.</Empty>
      ) : (
        <>
          <div className="kpis" style={{ margin: 0 }}>
            <div className="panel kpi">
              <div className="l">Income</div>
              <div className="v">{money2(stats.income)}</div>
            </div>
            <div className="panel kpi">
              <div className="l">Expenses</div>
              <div className="v">{money2(stats.expenses)}</div>
            </div>
            <div className="panel kpi">
              <div className="l">Net {stats.netProfit < 0 ? 'loss' : 'profit'}</div>
              <div className="v" style={{ color: stats.netProfit < 0 ? 'var(--bad)' : 'var(--good)' }}>{money2(Math.abs(stats.netProfit))}</div>
              {stats.previousNetProfit != null && <div className="muted small">Previous month {money2(stats.previousNetProfit)}</div>}
            </div>
            <div className="panel kpi">
              <div className="l">Cash and bank at month end</div>
              <div className="v">{money2(stats.cash)}</div>
              <div className="muted small">Assets {money2(stats.assets)} · Liabilities {money2(stats.liabilities)}</div>
            </div>
          </div>
          {note && (
            <div className="panel" style={{ padding: 14 }}>
              <div className="muted small" style={{ marginBottom: 4 }}>
                📊 Controller's note{run?.model ? ` · ${run.model}` : ''}
              </div>
              <div style={{ whiteSpace: 'pre-wrap' }}>{note}</div>
            </div>
          )}
          {stats.topExpenses?.length > 0 && (
            <div className="panel" style={{ padding: 12 }}>
              <b>Largest expenses</b>
              <table className="data" style={{ marginTop: 6 }}>
                <tbody>
                  {stats.topExpenses.map((x: Json) => (
                    <tr key={x.name}>
                      <td>{x.name}</td>
                      <td className="num">{money2(x.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="panel" style={{ padding: 12 }}>
            <div className="spread">
              <b>Close checklist</b>
              <span className={`chip ${list.some((f) => f.status === 'open' && f.severity !== 'info') ? 'warn' : 'good'}`}>
                {list.some((f) => f.status === 'open' && f.severity !== 'info') ? 'Not ready' : 'Ready to close'}
              </span>
            </div>
            {!list.length ? (
              <div className="muted small" style={{ marginTop: 6 }}>Nothing found: bank lines booked, accounts reconciled, no drafts or uncategorised amounts.</div>
            ) : (
              <ul style={{ margin: '8px 0 0', paddingLeft: 18 }}>
                {list.map((f) => (
                  <li key={f.id} style={{ marginBottom: 4, opacity: f.status === 'open' ? 1 : 0.55 }}>
                    <span className={`chip ${SEV[f.severity]?.[1] ?? ''}`} style={{ marginRight: 6 }}>
                      {f.status === 'open' ? SEV[f.severity]?.[0] : f.status === 'done' ? 'Done' : 'Dismissed'}
                    </span>
                    {f.title}
                    {f.body && <div className="muted small">{f.body}</div>}
                  </li>
                ))}
              </ul>
            )}
          </div>
          {go && (
            <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
              <span className="muted small">
                Full statements for {monthName(period)} ({from} to {to}):
              </span>
              <button className="btn sm" onClick={() => go('reports')}>
                P&amp;L, balance sheet, ledgers and trial balance
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/* ───────────────────────── bank feeds & statements ───────────────────────── */

function Sources() {
  const qc = useQueryClient();
  const toast = useToast();
  const banks = useQuery({ queryKey: ['books', 'bank-accounts'], queryFn: () => get<Json[]>('/api/v1/books/bank-accounts') });
  const feeds = useQuery({ queryKey: ['books', 'feeds'], queryFn: () => get<Json>('/api/v1/books/feeds') });
  const bankList = useMemo(() => (banks.data ?? []).filter((b) => b.kind === 'bank' || b.kind === 'credit_card'), [banks.data]);
  const [bankId, setBankId] = useState('');
  // every chosen file: read, waiting for its PDF password, or failed
  const [files, setFiles] = useState<StatementFile[]>([]);
  const ok = files.filter((f) => f.lines);
  const combined = useMemo(() => combineStatements(ok.map((f) => ({ name: f.file.name, lines: f.lines! }))), [files]);
  const [busy, setBusy] = useState(false);
  const [connect, setConnect] = useState(false);
  const target = bankId || bankList[0]?.id || '';
  const refresh = () => qc.invalidateQueries({ queryKey: ['books'] });

  const isCard = bankList.find((b) => b.id === target)?.kind === 'credit_card';
  const read = async (file: File, password?: string, card = isCard): Promise<StatementFile> => {
    try {
      const lines = await readStatementFile(file, { password, card });
      return lines.length ? { file, lines, password, card } : { file, error: 'No transactions found (no header row with Date, Narration and Debit / Credit or Amount)' };
    } catch (e) {
      if (e instanceof PdfPasswordError) return { file, locked: true, error: e.wrong ? 'Wrong password, try again' : undefined };
      return { file, error: (e as Error).message };
    }
  };
  const choose = async (list: FileList | null) => {
    if (!list?.length) return;
    setBusy(true);
    const got: StatementFile[] = [];
    for (const f of Array.from(list).slice(0, 24)) got.push(await read(f));
    // choosing more files adds to the ones already chosen
    setFiles((cur) => [...cur.filter((c) => !got.some((g) => g.file.name === c.file.name)), ...got]);
    setBusy(false);
  };
  // a card's statement reads its amounts the other way round: read the files again when the account changes
  useEffect(() => {
    if (!files.some((f) => f.lines && !!f.card !== isCard)) return;
    let live = true;
    (async () => {
      const again = await Promise.all(files.map((f) => (f.lines && !!f.card !== isCard ? read(f.file, f.password, isCard) : Promise.resolve(f))));
      if (live) setFiles(again);
    })();
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isCard]);
  const unlock = async (f: StatementFile, password: string) => {
    const r = await read(f.file, password);
    setFiles((cur) => cur.map((c) => (c.file === f.file ? r : c)));
  };
  const upload = async () => {
    if (!combined.lines.length || !target) return;
    setBusy(true);
    try {
      let added = 0;
      let skipped = 0;
      let applied = 0;
      let waiting = 0;
      for (let i = 0; i < combined.lines.length; i += 5000) {
        const r = await post<Json>(`/api/v1/books/bank-accounts/${target}/statement`, { rows: combined.lines.slice(i, i + 5000), toDesk: true });
        added += r.added;
        skipped += r.skipped;
        applied += r.bookkeeper?.applied ?? 0;
        waiting += r.bookkeeper?.waiting ?? 0;
      }
      toast(`${added} new line(s), ${skipped} already there; the bookkeeper booked ${applied} and suggested ${waiting} for review`);
      setFiles([]);
      refresh();
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  };
  const sync = async (id: string) => {
    setBusy(true);
    try {
      const r = await post<Json>(`/api/v1/books/feeds/${id}/sync`);
      toast(`${r.added} new line(s)${r.bookkeeper ? `; ${r.bookkeeper.applied} booked, ${r.bookkeeper.waiting} for review` : ''}${r.more ? ' — more to fetch, sync again' : ''}`);
      refresh();
    } catch (e) {
      toast((e as Error).message, true);
      refresh();
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="stack">
      <section className="panel" style={{ padding: 14 }}>
        <div className="spread" style={{ flexWrap: 'wrap', gap: 8 }}>
          <div>
            <b>Upload bank statements</b>
            <div className="muted small">
              PDF, Excel or CSV straight from net banking (Yes Bank, ICICI, HDFC, SBI, Axis, Kotak and others), several at once. Password-protected PDFs are opened with the password you type here (it isn't stored or sent anywhere). Lines already imported are skipped.
            </div>
          </div>
          <div className="row" style={{ gap: 8 }}>
            <select value={target} onChange={(e) => setBankId(e.target.value)}>
              {bankList.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
            <label className={`btn sm primary${busy ? ' disabled' : ''}`}>
              {busy && !files.length ? 'Reading…' : files.length ? 'Add more files' : 'Choose files'}
              <input
                type="file"
                hidden
                multiple
                accept=".pdf,.csv,.tsv,.txt,.xls,.xlsx,application/pdf,text/csv"
                onChange={async (e) => {
                  const list = e.target.files;
                  await choose(list);
                  e.target.value = '';
                }}
              />
            </label>
          </div>
        </div>
        {files.length > 0 && (
          <div className="stack" style={{ marginTop: 10 }}>
            <table className="data">
              <thead>
                <tr>
                  <th>File</th>
                  <th>Lines</th>
                  <th>Period</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {files.map((f) => (
                  <tr key={f.file.name}>
                    <td className="small" style={{ whiteSpace: 'normal', maxWidth: 320 }}>
                      {f.file.name}
                    </td>
                    {f.lines ? (
                      <>
                        <td className="small">{f.lines.length}</td>
                        <td className="small">
                          {date(f.lines.map((l) => l.date).sort()[0]!)} – {date(f.lines.map((l) => l.date).sort().slice(-1)[0]!)}
                        </td>
                      </>
                    ) : f.locked ? (
                      <td colSpan={2}>
                        <PdfPassword wrong={!!f.error} onUnlock={(pw) => unlock(f, pw)} />
                      </td>
                    ) : (
                      <td colSpan={2} className="small" style={{ color: 'var(--bad)', whiteSpace: 'normal' }}>
                        {f.error}
                      </td>
                    )}
                    <td>
                      <button className="btn sm ghost" onClick={() => setFiles((cur) => cur.filter((c) => c !== f))}>
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {combined.lines.length > 0 && (
              <>
                <div className="muted small">
                  {combined.lines.length} line(s) from {date(combined.lines[0]!.date)} to {date(combined.lines[combined.lines.length - 1]!.date)} · in{' '}
                  {money2(combined.lines.filter((l) => l.amount > 0).reduce((s, l) => s + l.amount, 0))} · out {money2(-combined.lines.filter((l) => l.amount < 0).reduce((s, l) => s + l.amount, 0))}
                  {combined.duplicates > 0 && ` · ${combined.duplicates} line(s) repeated across files left out`}
                </div>
                <div className="table-wrap" style={{ maxHeight: 260, overflow: 'auto' }}>
                  <table className="data">
                    <thead>
                      <tr>
                        <th>Date</th>
                        <th>Narration</th>
                        <th>Ref</th>
                        <th className="num">Amount</th>
                        <th className="num">Balance</th>
                      </tr>
                    </thead>
                    <tbody>
                      {combined.lines.slice(0, 50).map((l, i) => (
                        <tr key={i}>
                          <td className="small">{date(l.date)}</td>
                          <td className="small" style={{ whiteSpace: 'normal', maxWidth: 420 }}>
                            {l.description}
                          </td>
                          <td className="small">{l.reference ?? ''}</td>
                          <td className="num" style={{ color: l.amount > 0 ? 'var(--good)' : undefined }}>
                            {money2(l.amount)}
                          </td>
                          <td className="num">{l.balance == null ? '' : money2(l.balance)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {combined.lines.length > 50 && <div className="muted small">…and {combined.lines.length - 50} more.</div>}
                <div className="muted small">Check a few lines against the statement before importing (dates, money in vs out). If something is off, send that bank's file format to support.</div>
              </>
            )}
            <div className="row" style={{ gap: 8 }}>
              <button className="btn primary" disabled={busy || !target || !combined.lines.length} onClick={upload}>
                {busy ? 'Importing and booking…' : `Import ${combined.lines.length} line(s) and hand them to the bookkeeper`}
              </button>
              <button className="btn ghost" onClick={() => setFiles([])}>
                Cancel
              </button>
            </div>
          </div>
        )}
      </section>

      <section className="panel" style={{ padding: 14 }}>
        <div className="spread" style={{ flexWrap: 'wrap', gap: 8 }}>
          <div>
            <b>Live bank feeds</b>
            <div className="muted small">The bank clerk pulls new transactions every day (and when you press Sync).</div>
          </div>
          <button className="btn sm primary" onClick={() => setConnect(true)}>
            Connect a feed
          </button>
        </div>
        {!feeds.data ? (
          <Spinner />
        ) : !feeds.data.feeds.length ? (
          <div className="muted small" style={{ marginTop: 8 }}>
            No feed connected. RazorpayX current accounts connect with an API key. For ICICI, HDFC, Axis or another bank's own API, the bank must first approve API access for your current account; until then, upload statements above.
            Razorpay payment-gateway payouts are fetched through your Razorpay integration (Settings → Integrations) and booked net of fee and GST.
          </div>
        ) : (
          <table className="data" style={{ marginTop: 8 }}>
            <thead>
              <tr>
                <th>Feed</th>
                <th>Into</th>
                <th>Status</th>
                <th>Last sync</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {(feeds.data.feeds as Json[]).map((f) => (
                <tr key={f.id}>
                  <td>
                    {f.providerLabel} {f.accountRef}
                    {f.label && <div className="muted small">{f.label}</div>}
                  </td>
                  <td className="small">{f.account}</td>
                  <td>
                    <span className={`chip ${f.status === 'active' ? 'good' : f.status === 'error' ? 'bad' : ''}`}>{f.status}</span>
                    {f.lastError && <div className="small" style={{ color: 'var(--bad)' }}>{f.lastError}</div>}
                  </td>
                  <td className="small">{ago(f.lastSyncedAt)}</td>
                  <td>
                    <div className="row" style={{ gap: 4, flexWrap: 'nowrap' }}>
                      <button className="btn sm" disabled={busy || f.status === 'paused'} onClick={() => sync(f.id)}>
                        Sync now
                      </button>
                      <button
                        className="btn sm ghost"
                        onClick={async () => {
                          await patch(`/api/v1/books/feeds/${f.id}`, { status: f.status === 'paused' ? 'active' : 'paused' }).catch((e) => toast((e as Error).message, true));
                          refresh();
                        }}
                      >
                        {f.status === 'paused' ? 'Resume' : 'Pause'}
                      </button>
                      <button
                        className="btn sm ghost"
                        onClick={async () => {
                          if (!window.confirm('Remove this feed? Lines already imported stay.')) return;
                          await del(`/api/v1/books/feeds/${f.id}`).catch((e) => toast((e as Error).message, true));
                          refresh();
                        }}
                      >
                        Remove
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      {connect && <ConnectFeed banks={bankList.filter((b) => b.kind === 'bank')} onClose={() => setConnect(false)} onDone={refresh} />}
    </div>
  );
}

interface StatementFile {
  file: File;
  password?: string;
  card?: boolean;
  lines?: StatementLine[];
  locked?: boolean;
  error?: string;
}

function PdfPassword({ wrong, onUnlock }: { wrong: boolean; onUnlock: (pw: string) => Promise<void> }) {
  const [pw, setPw] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="row"
      style={{ gap: 6 }}
      onSubmit={async (e) => {
        e.preventDefault();
        if (!pw) return;
        setBusy(true);
        await onUnlock(pw);
        setBusy(false);
      }}
    >
      <span className="small" style={{ color: wrong ? 'var(--bad)' : undefined }}>
        {wrong ? 'Wrong password:' : '🔒 Password-protected:'}
      </span>
      <input type="password" value={pw} onChange={(e) => setPw(e.target.value)} placeholder="Statement password" autoComplete="off" style={{ maxWidth: 180 }} />
      <button className="btn sm" disabled={busy || !pw}>
        {busy ? 'Opening…' : 'Open'}
      </button>
    </form>
  );
}

function ConnectFeed({ banks, onClose, onDone }: { banks: Json[]; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [f, setF] = useState({ bankAccountId: banks[0]?.id ?? '', accountRef: '', keyId: '', keySecret: '', label: '', syncFrom: new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10) });
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      const r = await post<Json>('/api/v1/books/feeds', { ...f, provider: 'razorpayx', label: f.label || null });
      toast(`Connected${r.balance != null ? ` — balance ${money2(r.balance)}` : ''}. Press Sync to bring in transactions.`);
      onDone();
      onClose();
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title="Connect RazorpayX"
      onClose={onClose}
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy || !f.bankAccountId || !f.accountRef || !f.keyId || !f.keySecret} onClick={save}>
            {busy ? 'Checking the keys…' : 'Connect'}
          </button>
        </>
      }
    >
      <div className="modal-body stack">
        <div className="muted small">
          In the RazorpayX dashboard: Account &amp; Settings → Developer controls → API keys (generate a key). The account number is your RazorpayX current account number (or the customer identifier for RazorpayX Lite). The keys are checked
          with RazorpayX, stored encrypted and never shown again.
        </div>
        <label className="field">
          Book into
          <select value={f.bankAccountId} onChange={(e) => setF({ ...f, bankAccountId: e.target.value })}>
            {banks.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          RazorpayX account number
          <input value={f.accountRef} onChange={(e) => setF({ ...f, accountRef: e.target.value.trim() })} placeholder="2323230000000000" />
        </label>
        <label className="field">
          Key id
          <input value={f.keyId} onChange={(e) => setF({ ...f, keyId: e.target.value })} placeholder="rzp_live_…" autoComplete="off" />
        </label>
        <label className="field">
          Key secret
          <input type="password" value={f.keySecret} onChange={(e) => setF({ ...f, keySecret: e.target.value })} autoComplete="new-password" />
        </label>
        <label className="field">
          Fetch transactions from
          <input type="date" value={f.syncFrom} onChange={(e) => setF({ ...f, syncFrom: e.target.value })} />
        </label>
        <label className="field">
          Label (optional)
          <input value={f.label} maxLength={120} onChange={(e) => setF({ ...f, label: e.target.value })} />
        </label>
      </div>
    </Modal>
  );
}

/* ───────────────────────── activity ───────────────────────── */

function Activity() {
  const { data } = useQuery({ queryKey: ['books', 'desk', 'runs'], queryFn: () => get<Json[]>('/api/v1/books/desk/runs') });
  if (!data) return <Spinner />;
  if (!data.length) return <Empty title="No runs yet">Each time an agent works, it is listed here with what it did.</Empty>;
  const names: Record<string, string> = { bank_clerk: 'Bank clerk', bookkeeper: 'Bookkeeper', compliance: 'Compliance clerk', controller: 'Controller' };
  return (
    <div className="table-wrap">
      <table className="data">
        <thead>
          <tr>
            <th>When</th>
            <th>Agent</th>
            <th>Why</th>
            <th>What it did</th>
          </tr>
        </thead>
        <tbody>
          {data.map((r) => (
            <tr key={r.id}>
              <td className="small" style={{ whiteSpace: 'nowrap' }}>
                {new Date(r.started_at).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}
              </td>
              <td>
                {AGENT_ICON[r.agent]} {names[r.agent] ?? r.agent}
                {r.period && <div className="muted small">{monthName(r.period)}</div>}
              </td>
              <td className="small">{r.trigger === 'schedule' ? 'Daily round' : r.trigger === 'import' ? 'Statement upload' : r.trigger === 'feed' ? 'Feed sync' : 'You asked'}</td>
              <td className="small" style={{ maxWidth: 620, whiteSpace: 'pre-wrap', color: r.error ? 'var(--bad)' : undefined }}>
                {r.error ?? r.summary ?? (r.finished_at ? '' : 'Working…')}
                {r.model && <div className="muted small">AI: {r.model}</div>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
