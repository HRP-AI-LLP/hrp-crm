/**
 * Billing & GST → GST portal: the GSTIN's connection (OTP session), filing calendar, ledgers and
 * notices, returns (prepare → save → status → proceed → summary → offset → file with EVC / DSC),
 * GSTR-2B into reconciliation and challans — through the WhiteBooks GSP. Also the invoice panel
 * for the IRN (e-invoice) and the e-way bill.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { del, get, patch, post } from '../../lib/api';
import { date, dateTime, money2 } from '../../lib/format';
import { Empty, Modal, Spinner, useToast } from '../ui';

type Json = Record<string, any>;
const ymNow = () => new Date().toISOString().slice(0, 7);
const ymPrev = () => {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - 1);
  return d.toISOString().slice(0, 7);
};
const toPeriod = (ym: string) => `${ym.slice(5, 7)}${ym.slice(0, 4)}`;
const periodLabel = (p: string) => new Date(Date.UTC(Number(p.slice(2)), Number(p.slice(0, 2)) - 1, 1)).toLocaleDateString('en-IN', { month: 'short', year: 'numeric', timeZone: 'UTC' });
const fyStart = () => {
  const d = new Date();
  return d.getUTCMonth() >= 3 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
};

const STATUS: Record<string, [string, string]> = {
  prepared: ['Prepared', ''],
  saving: ['Processing on the portal', 'info'],
  saved: ['Saved on the portal', 'info'],
  error: ['Portal error', 'bad'],
  submitted: ['Ready to file', 'info'],
  offset: ['Liability offset', 'info'],
  filed: ['Filed', 'good'],
  due: ['Due', ''],
  overdue: ['Overdue', 'bad'],
};
const RETURN_TYPES: [string, string, string][] = [
  ['GSTR1', 'GSTR-1 (outward supplies)', 'synapse'],
  ['GSTR3B', 'GSTR-3B (summary return and payment)', 'synapse'],
  ['ITC04', 'ITC-04 (goods sent to job workers)', 'synapse'],
  ['GSTR2X', 'GSTR-2X (accept TDS / TCS credits)', 'portal'],
  ['GSTR9', 'GSTR-9 (annual return)', 'portal'],
  ['GSTR7', 'GSTR-7 (TDS deducted — for deductors)', 'upload'],
  ['GSTR1A', 'GSTR-1A (amendments)', 'upload'],
  ['GSTR9C', 'GSTR-9C (reconciliation statement)', 'upload'],
  ['GSTR6', 'GSTR-6 (input service distributor)', 'upload'],
  ['GSTR8', 'GSTR-8 (e-commerce operator TCS)', 'upload'],
  ['CMP08', 'CMP-08 (composition)', 'upload'],
];

function useAct(keys: unknown[][]) {
  const qc = useQueryClient();
  const toast = useToast();
  return async <T,>(fn: () => Promise<T>, ok: string): Promise<T | null> => {
    try {
      const r = await fn();
      toast(ok);
      for (const k of keys) qc.invalidateQueries({ queryKey: k });
      return r;
    } catch (e) {
      toast((e as Error).message, true);
      for (const k of keys) qc.invalidateQueries({ queryKey: k });
      return null;
    }
  };
}

function JsonBox({ value, height = 260 }: { value: unknown; height?: number }) {
  return (
    <pre className="small" style={{ maxHeight: height, overflow: 'auto', background: 'var(--surface-2, #f6f7f9)', padding: 10, borderRadius: 8, margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}
function saveJson(value: unknown, name: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
  a.download = name;
  a.click();
}

/* ───────────────────────── page ───────────────────────── */

export function GstPortal() {
  const { data, isLoading } = useQuery({ queryKey: ['gst', 'connections'], queryFn: () => get<{ gsp: Json; connections: Json[] }>('/api/v1/gst/connections') });
  const [sel, setSel] = useState<string | null>(null);
  const [tab, setTab] = useState<'overview' | 'returns' | 'portal' | 'settings' | 'log'>('overview');
  const [adding, setAdding] = useState(false);
  if (isLoading || !data) return <div className="panel-body"><Spinner /></div>;
  const conn = data.connections.find((c) => c.id === sel) ?? data.connections[0];
  return (
    <div className="panel-body stack">
      {!data.gsp.configured && (
        <div className="panel" style={{ padding: 12, borderLeft: '4px solid var(--bad)' }}>
          <b>The GST Suvidha Provider is not set up on this server.</b> Put <code>WHITEBOOKS_CLIENT_ID</code>, <code>WHITEBOOKS_CLIENT_SECRET</code> and <code>WHITEBOOKS_EMAIL</code> in the repo-root <code>.env</code> (or the Worker's secrets) and restart. Until then you can prepare returns and download the portal JSON.
        </div>
      )}
      {data.gsp.configured && data.gsp.sandbox && <div className="muted small">Using WhiteBooks' <b>sandbox</b>: nothing reaches the real GST portal. The sandbox OTP is 575757.</div>}
      {!conn || adding ? (
        <section className="panel">
          <div className="panel-head"><h2>Add your GST registration</h2></div>
          <RegistrationForm onDone={(id) => { setAdding(false); setSel(id); }} onCancel={conn ? () => setAdding(false) : undefined} />
        </section>
      ) : (
        <>
          <div className="row" style={{ flexWrap: 'wrap', gap: 10, alignItems: 'center' }}>
            {data.connections.length > 1 ? (
              <select value={conn.id} onChange={(e) => setSel(e.target.value)}>
                {data.connections.map((c) => (
                  <option key={c.id} value={c.id}>{c.gstin} {c.legalName ? `· ${c.legalName}` : ''}</option>
                ))}
              </select>
            ) : (
              <b>{conn.gstin} {conn.legalName ? `· ${conn.legalName}` : ''}</b>
            )}
            <button className="btn sm ghost" onClick={() => setAdding(true)}>+ Another GSTIN</button>
          </div>
          <SessionBar conn={conn} configured={!!data.gsp.configured} sandbox={!!data.gsp.sandbox} />
          <div className="tabs" role="tablist" style={{ margin: 0 }}>
            {(
              [
                ['overview', 'Overview & due dates'],
                ['returns', 'Returns'],
                ['portal', 'Ledgers, notices & payments'],
                ['settings', 'Registration'],
                ['log', 'Activity'],
              ] as const
            ).map(([k, l]) => (
              <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}>{l}</button>
            ))}
          </div>
          {tab === 'overview' && <Overview conn={conn} />}
          {tab === 'returns' && <Returns conn={conn} />}
          {tab === 'portal' && <PortalViews conn={conn} />}
          {tab === 'settings' && <RegistrationForm conn={conn} onDone={() => undefined} />}
          {tab === 'log' && <ActivityLog conn={conn} />}
        </>
      )}
    </div>
  );
}

/* ───────────────────────── session ───────────────────────── */

function SessionBar({ conn, configured, sandbox }: { conn: Json; configured: boolean; sandbox: boolean }) {
  const act = useAct([['gst']]);
  const [otp, setOtp] = useState('');
  const live = conn.status === 'active';
  const chip = live ? ['Connected', 'good'] : conn.status === 'otp_sent' ? ['OTP sent', 'warn'] : conn.status === 'expired' ? ['Session ended', 'warn'] : ['Not connected', ''];
  return (
    <div className="panel" style={{ padding: 12 }}>
      <div className="row" style={{ flexWrap: 'wrap', gap: 10, alignItems: 'center' }}>
        <span>GST portal: <span className={`chip ${chip[1]}`}>{chip[0]}</span></span>
        {live && conn.sessionExpiresAt && <span className="muted small">until {dateTime(conn.sessionExpiresAt)} (renewed automatically while you work)</span>}
        {!conn.gstUsername && <span className="muted small">Enter the GST portal username under Registration first.</span>}
        {conn.status === 'otp_sent' ? (
          <>
            <input placeholder="OTP" inputMode="numeric" value={otp} onChange={(e) => setOtp(e.target.value.replace(/\D/g, '').slice(0, 8))} style={{ width: 110 }} />
            <button className="btn sm primary" disabled={otp.length < 4} onClick={async () => (await act(() => post(`/api/v1/gst/connections/${conn.id}/verify`, { otp }), 'Connected to the GST portal')) && setOtp('')}>
              Verify
            </button>
            <button className="btn sm ghost" onClick={() => act(() => post(`/api/v1/gst/connections/${conn.id}/otp`), 'A new OTP was sent')}>Resend</button>
            {sandbox && <span className="muted small">Sandbox OTP: 575757</span>}
          </>
        ) : (
          !live && (
            <button className="btn sm primary" disabled={!configured || !conn.gstUsername} onClick={() => act(() => post(`/api/v1/gst/connections/${conn.id}/otp`), 'OTP sent to the mobile and email registered on the GST portal')}>
              Connect (send OTP)
            </button>
          )
        )}
        {live && <button className="btn sm ghost" onClick={() => act(() => post(`/api/v1/gst/connections/${conn.id}/disconnect`), 'Disconnected')}>Disconnect</button>}
      </div>
      {!live && (
        <div className="muted small" style={{ marginTop: 6 }}>
          Before the first connection, allow API access on gst.gov.in: <i>My Profile → Manage API Access → Yes</i>, choose the duration (up to 30 days), and select WhiteBooks as the GSP if asked.
        </div>
      )}
      {conn.lastError && <div className="small" style={{ color: 'var(--bad)', marginTop: 6 }}>Last error: {conn.lastError}</div>}
    </div>
  );
}

/* ───────────────────────── overview ───────────────────────── */

function Overview({ conn }: { conn: Json }) {
  const act = useAct([['gst']]);
  const { data } = useQuery({ queryKey: ['gst', 'overview', conn.id], queryFn: () => get<Json>(`/api/v1/gst/connections/${conn.id}/overview`) });
  const [show, setShow] = useState<'pending' | 'all'>('pending');
  const [open, setOpen] = useState<Json | null>(null);
  if (!data) return <Spinner />;
  const live = conn.status === 'active';
  const bal = data.ledgerBalance?.data;
  const cash = bal?.cash_bal ?? {};
  const itc = bal?.itc_bal ?? {};
  const view = (kind: string, params: Json, ok: string) => act(() => post(`/api/v1/gst/connections/${conn.id}/views/${kind}`, params), ok);
  const rows = show === 'pending' ? data.pending : data.calendar;
  const ninetyAgo = new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10);
  return (
    <div className="stack">
      <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
        <button className="btn sm" disabled={!live} onClick={() => act(() => post(`/api/v1/gst/connections/${conn.id}/sync-returns`, { fyStart: fyStart() }), 'Return status updated from the portal')}>Update filed returns from the portal</button>
        <button className="btn sm" disabled={!live} onClick={() => view('ledger_balance', { retperiod: toPeriod(ymNow()) }, 'Balances updated')}>Update cash & ITC balance</button>
        <button className="btn sm" disabled={!live} onClick={() => view('notices', { date: `${fyStart() - 1}-04-01` }, 'Notices updated')}>Check notices</button>
        <button className="btn sm" disabled={!live} onClick={() => view('challans', { fromdate: ninetyAgo, todate: new Date().toISOString().slice(0, 10) }, 'Challans updated')}>Challans (90 days)</button>
      </div>
      <div className="kpis" style={{ margin: 0 }}>
        <div className="panel kpi">
          <div className="l">Cash ledger {data.ledgerBalance && <span className="muted small">· {dateTime(data.ledgerBalance.fetched_at)}</span>}</div>
          <div className="v">{bal ? money2(Number(cash.igst_tot_bal ?? 0) + Number(cash.cgst_tot_bal ?? 0) + Number(cash.sgst_tot_bal ?? 0) + Number(cash.cess_tot_bal ?? 0)) : '—'}</div>
          {bal && <div className="muted small">IGST {money2(cash.igst_tot_bal ?? 0)} · CGST {money2(cash.cgst_tot_bal ?? 0)} · SGST {money2(cash.sgst_tot_bal ?? 0)}</div>}
        </div>
        <div className="panel kpi">
          <div className="l">ITC (credit ledger)</div>
          <div className="v">{bal ? money2(Number(itc.igst_bal ?? 0) + Number(itc.cgst_bal ?? 0) + Number(itc.sgst_bal ?? 0) + Number(itc.cess_bal ?? 0)) : '—'}</div>
          {bal && <div className="muted small">IGST {money2(itc.igst_bal ?? 0)} · CGST {money2(itc.cgst_bal ?? 0)} · SGST {money2(itc.sgst_bal ?? 0)}</div>}
        </div>
        <div className="panel kpi">
          <div className="l">Returns to file now</div>
          <div className="v" style={{ color: data.pending.some((p: Json) => p.status === 'overdue') ? 'var(--bad)' : undefined }}>{data.pending.length}</div>
          <div className="muted small">
            {data.pending.filter((p: Json) => p.status === 'overdue').length} overdue
            {data.overdueEarlier > 0 && ` · ${data.overdueEarlier} earlier this year not marked filed (update from the portal)`}
          </div>
        </div>
      </div>
      {data.notices?.data && (
        <details className="panel" style={{ padding: 12 }}>
          <summary>Notices and orders on the portal <span className="muted small">· {dateTime(data.notices.fetched_at)}</span></summary>
          <JsonBox value={data.notices.data} />
        </details>
      )}
      <section className="panel">
        <div className="panel-head">
          <h2>Filing calendar · FY {data.fy}</h2>
          <div className="row">
            <button className={`btn sm ${show === 'pending' ? 'primary' : ''}`} onClick={() => setShow('pending')}>Due soon</button>
            <button className={`btn sm ${show === 'all' ? 'primary' : ''}`} onClick={() => setShow('all')}>All</button>
          </div>
        </div>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr><th>Return</th><th>Period</th><th>Due</th><th>Status</th><th>ARN</th><th /></tr>
            </thead>
            <tbody>
              {rows.map((r: Json) => (
                <tr key={`${r.returnType}${r.period}`}>
                  <td>{r.label}</td>
                  <td>{r.periodLabel}</td>
                  <td>{date(r.dueDate)}</td>
                  <td><span className={`chip ${STATUS[r.status]?.[1] ?? ''}`}>{STATUS[r.status]?.[0] ?? r.status}</span>{r.source === 'portal' && <span className="muted small"> (portal)</span>}</td>
                  <td className="small">{r.arn ?? ''}</td>
                  <td>
                    {r.status !== 'filed' && (
                      <button className="btn sm" onClick={() => setOpen(r)}>{r.filingId ? 'Continue' : 'Prepare'}</button>
                    )}
                  </td>
                </tr>
              ))}
              {!rows.length && (
                <tr><td colSpan={6} className="muted" style={{ textAlign: 'center', padding: 20 }}>Nothing to file right now.</td></tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="muted small" style={{ padding: '8px 16px' }}>Due dates are the regular ones; check gst.gov.in for extensions. Change monthly / quarterly filing under Registration.</div>
      </section>
      {open && (open.filingId ? <FilingWizard id={open.filingId} conn={conn} onClose={() => setOpen(null)} /> : <NewReturn conn={conn} preset={{ returnType: open.returnType, period: open.period }} onClose={() => setOpen(null)} />)}
    </div>
  );
}

/* ───────────────────────── returns ───────────────────────── */

function Returns({ conn }: { conn: Json }) {
  const { data } = useQuery({ queryKey: ['gst', 'filings', conn.id], queryFn: () => get<Json[]>(`/api/v1/gst/connections/${conn.id}/filings`) });
  const [open, setOpen] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Returns</h2>
        <button className="btn sm primary" onClick={() => setCreating(true)}>Prepare a return</button>
      </div>
      {!data ? (
        <Spinner />
      ) : !data.length ? (
        <Empty title="No returns prepared yet">GSTR-1, GSTR-3B and ITC-04 are built from your invoices, bills and job work. Others start from the portal's figures or from portal JSON.</Empty>
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>Return</th><th>Period</th><th>Status</th><th>From</th><th>ARN</th><th>Updated</th></tr></thead>
            <tbody>
              {data.map((f) => (
                <tr key={f.id} className="clickable" onClick={() => setOpen(f.id)} style={{ cursor: 'pointer' }}>
                  <td>{f.label}</td>
                  <td>{periodLabel(f.period)}</td>
                  <td><span className={`chip ${STATUS[f.status]?.[1] ?? ''}`}>{STATUS[f.status]?.[0] ?? f.status}</span></td>
                  <td className="small">{f.source === 'synapse' ? 'Synapse' : f.source === 'portal' ? 'Portal' : 'Uploaded JSON'}</td>
                  <td className="small">{f.arn ?? ''}</td>
                  <td className="small">{dateTime(f.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {creating && <NewReturn conn={conn} onClose={() => setCreating(false)} onCreated={(id) => { setCreating(false); setOpen(id); }} />}
      {open && <FilingWizard id={open} conn={conn} onClose={() => setOpen(null)} />}
    </section>
  );
}

function NewReturn({ conn, preset, onClose, onCreated }: { conn: Json; preset?: { returnType: string; period: string }; onClose: () => void; onCreated?: (id: string) => void }) {
  const act = useAct([['gst']]);
  const [f, setF] = useState({
    returnType: preset?.returnType ?? 'GSTR1',
    month: preset ? `${preset.period.slice(2)}-${preset.period.slice(0, 2)}` : ymPrev(),
    from: `${fyStart() - 1}-04-01`,
    to: `${fyStart()}-03-31`,
    json: '' as string,
  });
  const [created, setCreated] = useState<string | null>(null);
  const kind = RETURN_TYPES.find(([k]) => k === f.returnType)?.[2] ?? 'upload';
  const period = toPeriod(f.month);
  const go = async () => {
    let r: Json | null = null;
    if (kind === 'synapse') r = await act(() => post<Json>(`/api/v1/gst/connections/${conn.id}/filings`, { returnType: f.returnType, period, ...(f.returnType === 'ITC04' ? { from: f.from, to: f.to } : {}) }), 'Prepared');
    else if (kind === 'portal') r = await act(() => post<Json>(`/api/v1/gst/connections/${conn.id}/filings/from-portal`, { returnType: f.returnType, period }), 'Prepared from the portal');
    else {
      let payload: unknown;
      try {
        payload = JSON.parse(f.json);
      } catch {
        window.alert('That is not valid JSON');
        return;
      }
      r = await act(() => post<Json>(`/api/v1/gst/connections/${conn.id}/filings`, { returnType: f.returnType, period, payload }), 'Prepared from your JSON');
    }
    if (r?.id) {
      if (onCreated) onCreated(r.id);
      else setCreated(r.id);
    }
  };
  if (created) return <FilingWizard id={created} conn={conn} onClose={onClose} />;
  return (
    <Modal title="Prepare a return" onClose={onClose} footer={<button className="btn primary" onClick={go}>Prepare</button>}>
      <div className="modal-body grid2">
        <label className="field wide">
          Return
          <select value={f.returnType} onChange={(e) => setF({ ...f, returnType: e.target.value })}>
            {RETURN_TYPES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
        </label>
        <label className="field">
          {['GSTR9', 'GSTR9C', 'ITC04'].includes(f.returnType) ? 'Last month of the period' : conn.filingFrequency === 'quarterly' ? 'Last month of the quarter' : 'Month'}
          <input type="month" value={f.month} onChange={(e) => setF({ ...f, month: e.target.value })} />
        </label>
        {f.returnType === 'ITC04' && (
          <>
            <label className="field">From<input type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} /></label>
            <label className="field">To<input type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} /></label>
          </>
        )}
        <div className="wide muted small">
          {kind === 'synapse' && 'Built from issued invoices and credit notes, posted bills and expenses, and job work in Synapse. You can check and download the JSON before anything goes to the portal.'}
          {kind === 'portal' && (f.returnType === 'GSTR9' ? "Starts from the portal's auto-calculated GSTR-9 (from your GSTR-1 and 3B). Needs a live portal session." : 'Fetches the TDS / TCS credits deductors reported for you (e.g. a government buyer\'s GST TDS) and accepts them all, so they reach your cash ledger. Needs a live portal session.')}
          {kind === 'upload' && "Paste the portal-format JSON (from the GST offline tool or your accountant's software). It must be for this GSTIN."}
        </div>
        {kind === 'upload' && (
          <label className="field wide">
            Portal JSON
            <textarea rows={8} value={f.json} onChange={(e) => setF({ ...f, json: e.target.value })} placeholder='{"gstin": "…", "fp": "…", …}' />
            <input type="file" accept=".json,application/json" onChange={async (e) => { const file = e.target.files?.[0]; if (file) setF({ ...f, json: await file.text() }); }} />
          </label>
        )}
      </div>
    </Modal>
  );
}

const STEPS = ['prepared', 'saving', 'saved', 'submitted', 'offset', 'filed'];

function FilingWizard({ id, conn, onClose }: { id: string; conn: Json; onClose: () => void }) {
  const act = useAct([['gst']]);
  const { data: f } = useQuery({ queryKey: ['gst', 'filing', id], queryFn: () => get<Json>(`/api/v1/gst/filings/${id}`) });
  const [offset, setOffset] = useState<Json | null>(null);
  const [offsetText, setOffsetText] = useState('');
  const [file, setFile] = useState({ mode: 'evc', pan: conn.signatoryPan ?? '', otp: '', declaration: false });
  if (!f) return <Modal title="Return" onClose={onClose}><div className="modal-body"><Spinner /></div></Modal>;
  const live = conn.status === 'active';
  const st = f.status as string;
  const call = (path: string, ok: string, body?: unknown) => act(() => post<Json>(`/api/v1/gst/filings/${id}/${path}`, body), ok);
  const at = (s: string) => STEPS.indexOf(st) >= STEPS.indexOf(s);
  const canFile = f.summary && ((f.canOffset && st === 'offset') || (!f.canOffset && (f.needsProceed ? st === 'submitted' : ['saved', 'submitted'].includes(st))));
  return (
    <Modal title={`${f.label} · ${periodLabel(f.period)}`} onClose={onClose} wide>
      <div className="modal-body stack">
        <div className="row" style={{ flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
          <span className={`chip ${STATUS[st]?.[1] ?? ''}`}>{STATUS[st]?.[0] ?? st}</span>
          {f.refId && <span className="muted small">Reference {f.refId}{f.portalStatus ? ` · ${f.portalStatus}` : ''}</span>}
          {f.arn && <b>ARN {f.arn}</b>}
          {f.filedAt && <span className="muted small">filed {dateTime(f.filedAt)} by {f.filingMode?.toUpperCase()}</span>}
        </div>
        {!live && st !== 'filed' && <div className="small" style={{ color: 'var(--bad)' }}>Connect to the GST portal (OTP) to send this return.</div>}

        <details open={st === 'prepared'}>
          <summary><b>1. What will be sent</b> <span className="muted small">({f.source === 'synapse' ? 'from Synapse records' : f.source === 'portal' ? "from the portal's figures" : 'uploaded JSON'})</span></summary>
          <div className="stack" style={{ marginTop: 8 }}>
            <JsonBox value={f.payload} />
            <div className="row">
              <button className="btn sm" onClick={() => saveJson(f.payload, `${conn.gstin}-${f.returnType}-${f.period}.json`)}>Download JSON (for the offline tool)</button>
            </div>
          </div>
        </details>

        <div className="stack">
          <b>2. Save to the portal</b>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <button className="btn sm primary" disabled={!live || !['prepared', 'error', 'saved'].includes(st)} onClick={() => call('save', 'Sent; the portal is processing it')}>
              {st === 'prepared' ? 'Save to the portal' : 'Save again'}
            </button>
            <button className="btn sm" disabled={!live || !f.refId || st === 'filed'} onClick={() => call('status', 'Status updated')}>Check status</button>
            {['GSTR1', 'GSTR1A'].includes(f.returnType) && ['saved', 'error'].includes(st) && (
              <button className="btn sm ghost" disabled={!live} onClick={() => window.confirm('Delete all the data saved on the portal for this return?') && call('reset', 'Reset on the portal')}>Reset portal data</button>
            )}
          </div>
          {f.errorReport && (
            <div>
              <div className="small" style={{ color: 'var(--bad)' }}>The portal rejected some data. Fix it in Synapse, prepare again and save.</div>
              <JsonBox value={f.errorReport} height={180} />
            </div>
          )}
        </div>

        {f.needsProceed && (
          <div className="stack">
            <b>3. Proceed to file</b>
            <div className="muted small">The portal freezes the saved data and works out the summary (and the liability for GSTR-3B).</div>
            <div className="row">
              <button className="btn sm primary" disabled={!live || st !== 'saved'} onClick={() => call('proceed', 'Proceeding; check the status in a moment')}>Proceed to file</button>
              {st === 'submitted' && f.refId && <button className="btn sm" disabled={!live} onClick={() => call('status', 'Status updated')}>Check status</button>}
            </div>
          </div>
        )}

        <div className="stack">
          <b>{f.needsProceed ? '4' : '3'}. Summary on the portal</b>
          <div className="row">
            <button className="btn sm" disabled={!live || !at('saved') || st === 'error'} onClick={() => call('summary', 'Summary fetched')}>{f.summary ? 'Fetch again' : 'Fetch summary'}</button>
          </div>
          {f.summary && (
            <details>
              <summary>Summary (this is what gets filed)</summary>
              <JsonBox value={f.summary} />
            </details>
          )}
        </div>

        {f.canOffset && (
          <div className="stack">
            <b>4. Pay the liability (offset)</b>
            <div className="muted small">Forward-charge tax is paid from ITC first (IGST credit, then CGST / SGST credit); reverse-charge tax, interest and late fee from the cash ledger. If cash falls short, create a challan under Ledgers, notices & payments and pay it first.</div>
            <div className="row" style={{ gap: 8 }}>
              <button className="btn sm" disabled={!live || !f.summary || !['saved', 'submitted', 'error'].includes(st)} onClick={async () => { const r = await call('offset/propose', 'Offset worked out'); if (r) { setOffset(r); setOffsetText(JSON.stringify(r.offset, null, 2)); } }}>
                Work out the offset
              </button>
            </div>
            {offset && (
              <>
                <table className="data small">
                  <thead><tr><th /><th className="num">IGST</th><th className="num">CGST</th><th className="num">SGST</th><th className="num">Cess</th></tr></thead>
                  <tbody>
                    {(['cashNeeded', 'cashAvailable', 'shortfall'] as const).map((k) => (
                      <tr key={k} style={k === 'shortfall' ? { color: 'var(--bad)' } : undefined}>
                        <td>{k === 'cashNeeded' ? 'To pay in cash' : k === 'cashAvailable' ? 'Cash ledger' : 'Short'}</td>
                        {['igst', 'cgst', 'sgst', 'cess'].map((h) => <td key={h} className="num">{money2(offset[k][h] ?? 0)}</td>)}
                      </tr>
                    ))}
                  </tbody>
                </table>
                <label className="field">
                  Offset (edit only if you know the portal format)
                  <textarea rows={8} value={offsetText} onChange={(e) => setOffsetText(e.target.value)} style={{ fontFamily: 'monospace', fontSize: 12 }} />
                </label>
                <div className="row">
                  <button
                    className="btn sm primary"
                    disabled={!live}
                    onClick={async () => {
                      let body: unknown;
                      try {
                        body = JSON.parse(offsetText);
                      } catch {
                        window.alert('That is not valid JSON');
                        return;
                      }
                      if (window.confirm('Pay the GSTR-3B liability from the ledgers as shown? This debits your cash and credit ledgers on the portal.')) await call('offset', 'Liability offset', body);
                    }}
                  >
                    Offset liability
                  </button>
                </div>
              </>
            )}
          </div>
        )}

        <div className="stack">
          <b>{f.canOffset || f.needsProceed ? '5' : '4'}. File</b>
          {st === 'filed' ? (
            <div>Filed{f.arn ? ` · ARN ${f.arn}` : ''}.</div>
          ) : (
            <>
              <div className="grid2">
                <label className="field">
                  Sign with
                  <select value={file.mode} onChange={(e) => setFile({ ...file, mode: e.target.value })}>
                    <option value="evc">EVC (OTP to the signatory)</option>
                    <option value="dsc">DSC (registered on the GST portal)</option>
                  </select>
                </label>
                <label className="field">
                  Authorised signatory's PAN
                  <input value={file.pan} onChange={(e) => setFile({ ...file, pan: e.target.value.toUpperCase().slice(0, 10) })} placeholder="ABCDE1234F" />
                </label>
                {file.mode === 'evc' && (
                  <label className="field">
                    EVC OTP
                    <div className="row" style={{ gap: 6 }}>
                      <input inputMode="numeric" value={file.otp} onChange={(e) => setFile({ ...file, otp: e.target.value.replace(/\D/g, '').slice(0, 6) })} style={{ width: 110 }} />
                      <button className="btn sm" disabled={!live || !canFile || !/^[A-Z]{5}\d{4}[A-Z]$/.test(file.pan)} onClick={() => call('evc-otp', 'OTP sent to the signatory', { pan: file.pan })}>Send OTP</button>
                    </div>
                  </label>
                )}
                <label className="wide row" style={{ gap: 8, alignItems: 'flex-start' }}>
                  <input type="checkbox" checked={file.declaration} onChange={(e) => setFile({ ...file, declaration: e.target.checked })} />
                  <span className="small">I hereby solemnly affirm and declare that the information given herein above is true and correct to the best of my knowledge and belief and nothing has been concealed therefrom.</span>
                </label>
              </div>
              <div className="row">
                <button
                  className="btn primary"
                  disabled={!live || !canFile || !file.declaration || (file.mode === 'evc' && file.otp.length !== 6)}
                  onClick={() => window.confirm(`File ${f.label} for ${periodLabel(f.period)}? A filed return cannot be changed.`) && call('file', 'Filed', { mode: file.mode, pan: file.pan || null, otp: file.otp || null, declaration: true })}
                >
                  File {f.label}
                </button>
              </div>
              {!canFile && <div className="muted small">Filing opens once the summary is fetched{f.needsProceed ? ' after proceeding to file' : ''}{f.canOffset ? ' and the liability is offset' : ''}.</div>}
            </>
          )}
        </div>

        {f.events?.length > 0 && (
          <details>
            <summary>Activity</summary>
            <table className="data small">
              <tbody>
                {f.events.map((e: Json, i: number) => (
                  <tr key={i}>
                    <td>{dateTime(e.created_at)}</td>
                    <td>{e.action}</td>
                    <td>{e.ok ? '✓' : '✗'}</td>
                    <td>{e.message ?? ''}</td>
                    <td>{e.by ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        )}
      </div>
    </Modal>
  );
}

/* ───────────────────────── ledgers, notices, 2B, challans ───────────────────────── */

function PortalViews({ conn }: { conn: Json }) {
  const act = useAct([['gst']]);
  const { data: views } = useQuery({ queryKey: ['gst', 'views'], queryFn: () => get<Json[]>('/api/v1/gst/views'), staleTime: Infinity });
  const [kind, setKind] = useState('ledger_balance');
  const [params, setParams] = useState<Record<string, string>>({});
  const [result, setResult] = useState<Json | null>(null);
  const [period2b, setPeriod2b] = useState(ymPrev());
  const [challan, setChallan] = useState(false);
  const live = conn.status === 'active';
  const v = views?.find((x) => x.kind === kind);
  const defaults = (p: string): string => {
    if (['retperiod', 'returnperiod', 'rtnprd'].includes(p)) return toPeriod(ymPrev());
    if (['frdt', 'fromdate', 'date'].includes(p)) return `${fyStart()}-04-01`;
    if (['todt', 'todate'].includes(p)) return new Date().toISOString().slice(0, 10);
    if (p === 'rettype') return 'R3B';
    if (p === 'rectype') return 'TDS';
    if (p === 'suptyp') return 'B2B';
    return '';
  };
  return (
    <div className="stack">
      <section className="panel">
        <div className="panel-head"><h2>Look up on the portal</h2></div>
        <div className="panel-body stack">
          <div className="row" style={{ flexWrap: 'wrap', gap: 8, alignItems: 'flex-end' }}>
            <label className="field">
              What
              <select value={kind} onChange={(e) => { setKind(e.target.value); setParams({}); setResult(null); }}>
                {(views ?? []).map((x) => <option key={x.kind} value={x.kind}>{x.label}</option>)}
              </select>
            </label>
            {v &&
              [...v.params, ...v.optional].map((p: string) => (
                <label key={p} className="field">
                  {p}
                  {v.dates.includes(p) ? (
                    <input type="date" value={params[p] ?? defaults(p)} onChange={(e) => setParams({ ...params, [p]: e.target.value })} />
                  ) : (
                    <input value={params[p] ?? defaults(p)} onChange={(e) => setParams({ ...params, [p]: e.target.value })} style={{ width: 130 }} />
                  )}
                </label>
              ))}
            <button
              className="btn primary"
              disabled={!live || !v}
              onClick={async () => {
                const all = Object.fromEntries([...v!.params, ...v!.optional].map((p: string) => [p, params[p] ?? defaults(p)]).filter(([, x]) => x !== ''));
                const r = await act(() => post<Json>(`/api/v1/gst/connections/${conn.id}/views/${kind}`, all), 'Fetched');
                if (r) setResult(r);
              }}
            >
              Fetch
            </button>
          </div>
          <div className="muted small">Periods are MMYYYY (e.g. {toPeriod(ymPrev())}). Return types: R1, R3B, R9…</div>
          {result && (
            <>
              <div className="row" style={{ gap: 8 }}>
                <b>{result.label}</b>
                <span className="muted small">{dateTime(result.fetchedAt)}</span>
                <button className="btn sm ghost" onClick={() => saveJson(result.data, `${conn.gstin}-${kind}.json`)}>Download</button>
              </div>
              <JsonBox value={result.data} height={420} />
            </>
          )}
        </div>
      </section>
      <section className="panel">
        <div className="panel-head"><h2>GSTR-2B → purchase reconciliation</h2></div>
        <div className="panel-body row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <label className="field">Month<input type="month" value={period2b} onChange={(e) => setPeriod2b(e.target.value)} /></label>
          <button className="btn" disabled={!live} onClick={() => act(() => post<Json>(`/api/v1/gst/connections/${conn.id}/gstr2b`, { period: toPeriod(period2b) }), 'GSTR-2B fetched and matched against your bills (Books → GST & TDS)')}>
            Fetch GSTR-2B and match
          </button>
          <span className="muted small">Replaces any earlier import of that month. The result is under Books → GST & TDS → GSTR-2B.</span>
        </div>
      </section>
      <section className="panel">
        <div className="panel-head">
          <h2>Pay GST (challan)</h2>
          <button className="btn sm primary" disabled={!live} onClick={() => setChallan(true)}>Create challan</button>
        </div>
        <div className="panel-body muted small">Creates a PMT-06 challan on the portal. Pay it with the CPIN by net banking, NEFT / RTGS or over the counter; the money reaches your cash ledger.</div>
      </section>
      {challan && <ChallanModal conn={conn} onClose={() => setChallan(false)} />}
    </div>
  );
}

function ChallanModal({ conn, onClose }: { conn: Json; onClose: () => void }) {
  const act = useAct([['gst']]);
  const [f, setF] = useState<Json>({ month: ymPrev(), mode: 'NEFT', email: '', mobile: '', igst: '', cgst: '', sgst: '', cess: '', interest: '', fee: '' });
  const [done, setDone] = useState<Json | null>(null);
  const amt = (x: string) => Number(x || 0);
  const total = ['igst', 'cgst', 'sgst', 'cess', 'interest', 'fee'].reduce((s, k) => s + amt(f[k]), 0);
  return (
    <Modal
      title="Create GST challan"
      onClose={onClose}
      footer={
        !done && (
          <button
            className="btn primary"
            disabled={!(total > 0) || !f.email || !/^[6-9]\d{9}$/.test(f.mobile)}
            onClick={async () => {
              const half = (x: string) => Math.round((amt(x) / 2) * 100) / 100;
              const r = await act(
                () =>
                  post<Json>(`/api/v1/gst/connections/${conn.id}/challans`, {
                    period: toPeriod(f.month),
                    mode: f.mode,
                    email: f.email,
                    mobile: f.mobile,
                    amounts: {
                      igst: { tax: amt(f.igst) },
                      cgst: { tax: amt(f.cgst), interest: half(f.interest), fee: half(f.fee) },
                      sgst: { tax: amt(f.sgst), interest: amt(f.interest) - half(f.interest), fee: amt(f.fee) - half(f.fee) },
                      cess: { tax: amt(f.cess) },
                    },
                  }),
                'Challan created',
              );
              if (r) setDone(r);
            }}
          >
            Create · {money2(total)}
          </button>
        )
      }
    >
      {done ? (
        <div className="modal-body stack">
          <div>CPIN <b>{done.cpin ?? '—'}</b> for {money2(done.total)}{done.expiresOn ? `, valid until ${done.expiresOn}` : ''}.</div>
          <div className="muted small">Pay it before it expires; the payment then shows in the cash ledger.</div>
        </div>
      ) : (
        <div className="modal-body grid2">
          <label className="field">For the month<input type="month" value={f.month} onChange={(e) => setF({ ...f, month: e.target.value })} /></label>
          <label className="field">
            Pay by
            <select value={f.mode} onChange={(e) => setF({ ...f, mode: e.target.value })}>
              <option value="EPY">Net banking / card (e-payment)</option>
              <option value="NEFT">NEFT / RTGS</option>
              <option value="OTC">Over the counter</option>
              <option value="UPI">UPI</option>
            </select>
          </label>
          {(['igst', 'cgst', 'sgst', 'cess'] as const).map((k) => (
            <label key={k} className="field">{k.toUpperCase()} (tax)<input type="number" min={0} value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} /></label>
          ))}
          <label className="field">Interest (CGST + SGST)<input type="number" min={0} value={f.interest} onChange={(e) => setF({ ...f, interest: e.target.value })} /></label>
          <label className="field">Late fee (CGST + SGST)<input type="number" min={0} value={f.fee} onChange={(e) => setF({ ...f, fee: e.target.value })} /></label>
          <label className="field">Email<input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></label>
          <label className="field">Mobile<input inputMode="numeric" value={f.mobile} onChange={(e) => setF({ ...f, mobile: e.target.value.replace(/\D/g, '').slice(0, 10) })} /></label>
        </div>
      )}
    </Modal>
  );
}

/* ───────────────────────── registration ───────────────────────── */

function RegistrationForm({ conn, onDone, onCancel }: { conn?: Json; onDone: (id: string) => void; onCancel?: () => void }) {
  const act = useAct([['gst']]);
  const [f, setF] = useState<Json>({
    gstin: conn?.gstin ?? '',
    legalName: conn?.legalName ?? '',
    gstUsername: conn?.gstUsername ?? '',
    signatoryPan: conn?.signatoryPan ?? '',
    filingFrequency: conn?.filingFrequency ?? 'monthly',
    einvUsername: conn?.einvUsername ?? '',
    einvPassword: '',
    ewbUsername: conn?.ewbUsername ?? '',
    ewbPassword: '',
  });
  const set = (k: string) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const lookup = async () => {
    const r = await act(() => get<Json>(`/api/v1/gst/search/${f.gstin.trim().toUpperCase()}`), 'Found on the GST portal');
    if (r?.legalName) setF({ ...f, legalName: r.legalName });
  };
  const save = async () => {
    const body: Json = { ...f, gstin: f.gstin.trim().toUpperCase() };
    if (!body.einvPassword) delete body.einvPassword;
    if (!body.ewbPassword) delete body.ewbPassword;
    const r = conn ? await act(() => patch<Json>(`/api/v1/gst/connections/${conn.id}`, body), 'Saved') : await act(() => post<Json>('/api/v1/gst/connections', body), 'GST registration added');
    if (r?.id) onDone(r.id);
  };
  return (
    <div className="panel-body stack">
      <div className="grid2">
        <label className="field">
          GSTIN
          <div className="row" style={{ gap: 6 }}>
            <input value={f.gstin} onChange={(e) => setF({ ...f, gstin: e.target.value.toUpperCase().slice(0, 15) })} placeholder="09AAACH1234M1Z5" />
            <button className="btn sm ghost" disabled={f.gstin.length !== 15} onClick={lookup}>Look up</button>
          </div>
        </label>
        <label className="field">Legal name<input value={f.legalName} onChange={set('legalName')} /></label>
        <label className="field">GST portal username<input value={f.gstUsername} onChange={set('gstUsername')} autoComplete="off" /></label>
        <label className="field">Authorised signatory's PAN (for EVC)<input value={f.signatoryPan} onChange={(e) => setF({ ...f, signatoryPan: e.target.value.toUpperCase().slice(0, 10) })} /></label>
        <label className="field">
          Files GSTR-1 / 3B
          <select value={f.filingFrequency} onChange={set('filingFrequency')}>
            <option value="monthly">Monthly</option>
            <option value="quarterly">Quarterly (QRMP)</option>
          </select>
        </label>
        <div />
        <div className="wide muted small">
          <b>E-invoice and e-way bill (optional).</b> Create API users on einvoice1.gst.gov.in and ewaybillgst.gov.in (API Registration → Through GSP → WhiteBooks) and enter them here. Passwords are stored encrypted and never shown again.
        </div>
        <label className="field">E-invoice API username<input value={f.einvUsername} onChange={set('einvUsername')} autoComplete="off" /></label>
        <label className="field">
          E-invoice API password {conn?.hasEinvPassword && <span className="muted small">(saved — leave blank to keep)</span>}
          <input type="password" value={f.einvPassword} onChange={set('einvPassword')} autoComplete="new-password" />
        </label>
        <label className="field">E-way bill API username<input value={f.ewbUsername} onChange={set('ewbUsername')} autoComplete="off" /></label>
        <label className="field">
          E-way bill API password {conn?.hasEwbPassword && <span className="muted small">(saved — leave blank to keep)</span>}
          <input type="password" value={f.ewbPassword} onChange={set('ewbPassword')} autoComplete="new-password" />
        </label>
      </div>
      <div className="row" style={{ gap: 8 }}>
        <button className="btn primary" disabled={f.gstin.length !== 15} onClick={save}>{conn ? 'Save' : 'Add registration'}</button>
        {onCancel && <button className="btn ghost" onClick={onCancel}>Cancel</button>}
        {conn && (
          <button className="btn ghost danger" style={{ marginLeft: 'auto' }} onClick={() => window.confirm(`Remove ${conn.gstin} from Synapse? Prepared returns for it are deleted too.`) && act(() => del(`/api/v1/gst/connections/${conn.id}`), 'Removed')}>
            Remove
          </button>
        )}
      </div>
    </div>
  );
}

function ActivityLog({ conn }: { conn: Json }) {
  const { data } = useQuery({ queryKey: ['gst', 'log', conn.id], queryFn: () => get<Json[]>(`/api/v1/gst/connections/${conn.id}/log`) });
  if (!data) return <Spinner />;
  return (
    <div className="table-wrap">
      <table className="data small">
        <thead><tr><th>When</th><th>What</th><th /><th>Detail</th><th>By</th></tr></thead>
        <tbody>
          {data.map((e, i) => (
            <tr key={i}>
              <td>{dateTime(e.created_at)}</td>
              <td>{e.action}</td>
              <td>{e.ok ? '✓' : <span style={{ color: 'var(--bad)' }}>✗</span>}</td>
              <td>{e.message ?? ''}</td>
              <td>{e.by ?? ''}</td>
            </tr>
          ))}
          {!data.length && <tr><td colSpan={5} className="muted">Nothing yet.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

/* ───────────────────────── invoice panel: IRN and e-way bill ───────────────────────── */

export function InvoiceGst({ invoiceId, canAct }: { invoiceId: string; canAct: boolean }) {
  const act = useAct([['gst', 'invoice', invoiceId], ['invoice', invoiceId]]);
  const { data } = useQuery({ queryKey: ['gst', 'invoice', invoiceId], queryFn: () => get<Json>(`/api/v1/gst/invoices/${invoiceId}`), retry: false });
  const [modal, setModal] = useState<null | 'ewb' | 'cancel-irn' | 'cancel-ewb' | 'vehicle'>(null);
  const [f, setF] = useState<Json>({});
  if (!data) return null;
  const irnLive = data.irn && !data.irnCancelledAt;
  const ewbLive = data.ewbNo && !data.ewbCancelledAt;
  return (
    <div className="panel" style={{ padding: 12 }}>
      <div className="row" style={{ flexWrap: 'wrap', gap: 10, alignItems: 'center' }}>
        <b>E-invoice & e-way bill</b>
        {irnLive ? <span className="chip good" title={data.irn}>IRN {String(data.irn).slice(0, 10)}… · ack {data.ackNo}</span> : data.irnCancelledAt ? <span className="chip bad">IRN cancelled</span> : <span className="chip">No IRN</span>}
        {ewbLive ? <span className="chip good">EWB {data.ewbNo}{data.ewbValidUntil ? ` · valid till ${dateTime(data.ewbValidUntil)}` : ''}</span> : data.ewbCancelledAt ? <span className="chip bad">E-way bill cancelled</span> : null}
        {!data.connected && <span className="muted small">Add this GSTIN under Billing → GST portal to generate the IRN and e-way bill here.</span>}
        {data.connected && canAct && (
          <span className="row" style={{ gap: 6, marginLeft: 'auto', flexWrap: 'wrap' }}>
            {!irnLive && <button className="btn sm primary" disabled={!data.einvoiceReady} title={data.einvoiceReady ? undefined : 'Add the e-invoice API user on the GST registration'} onClick={() => act(() => post(`/api/v1/gst/invoices/${invoiceId}/irn`), 'IRN generated')}>Generate IRN</button>}
            {!ewbLive && <button className="btn sm" disabled={!irnLive && !data.ewayBillReady} onClick={() => { setF({ distance: '0', mode: 'road', vehicleNo: '', transporterId: '', transporterName: '', docNo: '', docDate: '' }); setModal('ewb'); }}>E-way bill</button>}
            {ewbLive && <button className="btn sm" onClick={() => { setF({ vehicleNo: '', fromPlace: '', reason: 'first_time', remark: '' }); setModal('vehicle'); }}>Update vehicle</button>}
            {ewbLive && <button className="btn sm ghost danger" onClick={() => { setF({ reason: 'data_entry_mistake', remark: '' }); setModal('cancel-ewb'); }}>Cancel EWB</button>}
            {irnLive && <button className="btn sm ghost danger" onClick={() => { setF({ reason: 'data_entry_mistake', remark: '' }); setModal('cancel-irn'); }}>Cancel IRN</button>}
          </span>
        )}
      </div>
      {irnLive && data.qr && <div className="muted small" style={{ marginTop: 6 }}>The signed QR code is printed on the invoice.</div>}
      {modal === 'ewb' && (
        <Modal
          title="Generate e-way bill"
          onClose={() => setModal(null)}
          footer={
            <button
              className="btn primary"
              onClick={async () =>
                (await act(
                  () =>
                    post(`/api/v1/gst/invoices/${invoiceId}/eway-bill`, {
                      distance: Number(f.distance || 0),
                      mode: f.mode,
                      vehicleNo: f.vehicleNo || null,
                      transporterId: f.transporterId || null,
                      transporterName: f.transporterName || null,
                      docNo: f.docNo || null,
                      docDate: f.docDate || null,
                    }),
                  'E-way bill generated',
                )) && setModal(null)
              }
            >
              Generate
            </button>
          }
        >
          <div className="modal-body grid2">
            <label className="field">Distance (km; 0 = auto from PIN codes)<input type="number" min={0} value={f.distance} onChange={(e) => setF({ ...f, distance: e.target.value })} /></label>
            <label className="field">
              Mode
              <select value={f.mode} onChange={(e) => setF({ ...f, mode: e.target.value })}>
                <option value="road">Road</option><option value="rail">Rail</option><option value="air">Air</option><option value="ship">Ship</option>
              </select>
            </label>
            <label className="field">Vehicle number<input value={f.vehicleNo} onChange={(e) => setF({ ...f, vehicleNo: e.target.value.toUpperCase() })} placeholder="UP16AB1234" /></label>
            <label className="field">Transporter ID (GSTIN / TRANSIN)<input value={f.transporterId} onChange={(e) => setF({ ...f, transporterId: e.target.value.toUpperCase() })} /></label>
            <label className="field">Transporter name<input value={f.transporterName} onChange={(e) => setF({ ...f, transporterName: e.target.value })} /></label>
            <label className="field">LR / RR / AWB no.<input value={f.docNo} onChange={(e) => setF({ ...f, docNo: e.target.value })} /></label>
            <label className="field">Document date<input type="date" value={f.docDate} onChange={(e) => setF({ ...f, docDate: e.target.value })} /></label>
            <div className="wide muted small">{irnLive ? 'Generated through the IRP from the e-invoice.' : 'Generated on the e-way bill system from the invoice (goods lines with HSN codes).'}</div>
          </div>
        </Modal>
      )}
      {(modal === 'cancel-irn' || modal === 'cancel-ewb') && (
        <Modal
          title={modal === 'cancel-irn' ? 'Cancel IRN' : 'Cancel e-way bill'}
          onClose={() => setModal(null)}
          footer={
            <button className="btn danger" disabled={(f.remark ?? '').trim().length < 3} onClick={async () => (await act(() => post(`/api/v1/gst/invoices/${invoiceId}/${modal === 'cancel-irn' ? 'irn' : 'eway-bill'}/cancel`, { reason: f.reason, remark: f.remark }), 'Cancelled')) && setModal(null)}>
              Cancel it
            </button>
          }
        >
          <div className="modal-body grid2">
            <label className="field">
              Reason
              <select value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })}>
                <option value="data_entry_mistake">Data entry mistake</option><option value="duplicate">Duplicate</option><option value="order_cancelled">Order cancelled</option><option value="other">Other</option>
              </select>
            </label>
            <label className="field">Remark<input value={f.remark} onChange={(e) => setF({ ...f, remark: e.target.value })} /></label>
            <div className="wide muted small">Allowed within 24 hours of generation.{modal === 'cancel-irn' ? ' Cancel the invoice in Synapse afterwards.' : ''}</div>
          </div>
        </Modal>
      )}
      {modal === 'vehicle' && (
        <Modal title="Update vehicle (Part B)" onClose={() => setModal(null)} footer={<button className="btn primary" disabled={!f.vehicleNo || (f.remark ?? '').length < 3} onClick={async () => (await act(() => post(`/api/v1/gst/invoices/${invoiceId}/eway-bill/vehicle`, f), 'Vehicle updated')) && setModal(null)}>Update</button>}>
          <div className="modal-body grid2">
            <label className="field">Vehicle number<input value={f.vehicleNo} onChange={(e) => setF({ ...f, vehicleNo: e.target.value.toUpperCase() })} /></label>
            <label className="field">From (place)<input value={f.fromPlace} onChange={(e) => setF({ ...f, fromPlace: e.target.value })} /></label>
            <label className="field">
              Reason
              <select value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })}>
                <option value="first_time">First time</option><option value="breakdown">Breakdown</option><option value="transhipment">Transhipment</option><option value="other">Other</option>
              </select>
            </label>
            <label className="field">Remark<input value={f.remark} onChange={(e) => setF({ ...f, remark: e.target.value })} /></label>
          </div>
        </Modal>
      )}
    </div>
  );
}
