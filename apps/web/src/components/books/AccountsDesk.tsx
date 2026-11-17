/**
 * Books → Accounts desk: the agents that keep the books (bank clerk, bookkeeper, compliance clerk,
 * controller), the review queue where people approve, change or reject what they propose, what they
 * found, the month-end close, and where bank transactions come from (statements and live feeds).
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { del, get, patch, post, put } from '../../lib/api';
import { date, money2 } from '../../lib/format';
import { combineStatements, PdfPasswordError, readStatementFile, type StatementLine } from '../../lib/statement';
import { Empty, Modal, Spinner, useToast } from '../ui';

type Json = Record<string, any>;
type View = 'queue' | 'findings' | 'close' | 'sources' | 'activity';

const AUTONOMY: [string, string, string][] = [
  ['auto_sure', 'Book the sure ones, ask about the rest', 'Your bank rules, exact matches to invoices, bills and entries, and payees always booked the same way are posted by the agents. Everything else waits for you.'],
  ['suggest', 'Suggest only', 'Nothing is posted until a person approves it.'],
  ['auto_all', 'Book everything above the threshold', 'The agents post every suggestion at or above the confidence threshold; you review afterwards (everything can be undone in Banking).'],
];
const SOURCE: Record<string, string> = { rule: 'Your rule', ledger: 'Posted entry', invoice: 'Open invoice', bill: 'Open bill', gateway: 'Razorpay settlement', history: 'Booked like this before', keyword: 'Narration', ai: 'AI', person: 'You' };
const KIND: Record<string, string> = { match: 'Match', receipt: 'Receipt', vendor_payment: 'Vendor payment', categorize: 'Categorise', exclude: 'Exclude', settlement: 'Settlement' };
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
            ['activity', 'Activity'],
          ] as [View, string][]
        ).map(([k, l]) => (
          <button key={k} role="tab" aria-selected={view === k} onClick={() => setView(k)}>
            {l}
          </button>
        ))}
      </div>
      {view === 'queue' && <Queue />}
      {view === 'findings' && <Findings go={go} />}
      {view === 'close' && <Close last={data.lastClose} go={go} />}
      {view === 'sources' && <Sources />}
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
        <input placeholder="Search narration…" value={q} onChange={(e) => setQ(e.target.value)} style={{ marginLeft: 'auto', maxWidth: 240 }} />
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
                {status === 'pending' && <th style={{ width: 28 }} />}
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
                        {KIND[p.kind] ?? p.kind}
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
  const initialKind = ['receipt', 'vendor_payment', 'categorize'].includes(p.kind) ? p.kind : 'categorize';
  const [kind, setKind] = useState<string>(initialKind);
  const [f, setF] = useState<Json>({
    accountId: p.kind === 'categorize' ? (p.payload.accountId ?? '') : '',
    partyId: p.kind === 'categorize' ? (p.payload.partyId ?? '') : '',
    invoiceId: p.payload.invoiceId ?? '',
    billId: p.payload.billId ?? '',
    tdsAmount: p.payload.tdsAmount ?? 0,
    narration: '',
  });
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
            ? { kind, invoiceId: f.invoiceId || null, tdsAmount: Number(f.tdsAmount) || 0 }
            : kind === 'vendor_payment'
              ? { kind, billId: f.billId || null }
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
          {(inflow ? ['receipt', 'categorize', 'exclude'] : ['vendor_payment', 'categorize', 'exclude']).map((k) => (
            <button key={k} aria-pressed={kind === k} onClick={() => setKind(k)}>
              {k === 'receipt' ? 'Customer receipt' : k === 'vendor_payment' ? 'Bill payment' : k === 'categorize' ? 'Book to an account' : 'Not a business transaction'}
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
        {kind === 'receipt' && (
          <>
            <label className="field">
              Invoice
              <select value={f.invoiceId} onChange={(e) => setF({ ...f, invoiceId: e.target.value })}>
                <option value="">Choose the invoice</option>
                {(docs.data?.invoices ?? []).map((i: Json) => (
                  <option key={i.id} value={i.id}>
                    {i.number} · {i.party} · balance {money2(i.balance)}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              TDS deducted by the customer (if any)
              <input type="number" min={0} step="0.01" value={f.tdsAmount} onChange={(e) => setF({ ...f, tdsAmount: e.target.value })} />
            </label>
          </>
        )}
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
        {kind === 'exclude' && <div className="muted small">The line stays in the statement but is left out of the books (e.g. a failed payment and its reversal).</div>}
      </div>
    </Modal>
  );
}

/* ───────────────────────── findings ───────────────────────── */

function Findings({ go }: { go?: (tab: string) => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [status, setStatus] = useState<'open' | 'done' | 'dismissed'>('open');
  const { data } = useQuery({ queryKey: ['books', 'desk', 'findings', status], queryFn: () => get<Json[]>(`/api/v1/books/desk/findings?status=${status}`) });
  const [running, setRunning] = useState(false);
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
                </div>
                <div className="row" style={{ gap: 4, flexWrap: 'nowrap' }}>
                  {f.link &&
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
    </div>
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

  const read = async (file: File, password?: string): Promise<StatementFile> => {
    try {
      const lines = await readStatementFile(file, { password });
      return lines.length ? { file, lines } : { file, error: 'No transactions found (no header row with Date, Narration and Debit / Credit or Amount)' };
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
