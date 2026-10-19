/**
 * Settings → Privacy & DPDP: grievance officer and portal, notices, data-principal requests,
 * retention rules, breach register and the do-not-contact list.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, download, get, patch, post, put } from '../../lib/api';
import { date, dateTime, relative } from '../../lib/format';
import { useUsers } from '../../lib/hooks';
import { Markdown } from '../Markdown';
import { Empty, Modal, Spinner, useToast } from '../ui';
import { CopyField } from './IntegrationsAdmin';

type Json = Record<string, any>;

function useRun() {
  const toast = useToast();
  const qc = useQueryClient();
  return async <T,>(fn: () => Promise<T>, ok: string | null, keys: string[][] = [['privacy']]) => {
    try {
      const r = await fn();
      if (ok) toast(ok);
      for (const k of keys) await qc.invalidateQueries({ queryKey: k });
      return r;
    } catch (e) {
      toast((e as Error).message, true);
      return null;
    }
  };
}

export const KIND_LABEL: Record<string, string> = {
  access: 'Access (summary of data)',
  correction: 'Correction or update',
  erasure: 'Erasure',
  grievance: 'Grievance',
  nomination: 'Nomination',
  withdraw_consent: 'Withdraw consent',
};
const STATUS_LABEL: Record<string, string> = { received: 'Received', verifying: 'Awaiting confirmation', in_progress: 'In progress', completed: 'Completed', rejected: 'Rejected' };

const SUBTABS = [
  ['overview', 'Overview'],
  ['requests', 'Requests'],
  ['notices', 'Notices'],
  ['retention', 'Retention'],
  ['breaches', 'Breaches'],
  ['dnc', 'Do not contact'],
] as const;

export function PrivacyTab() {
  const [sub, setSub] = useState<(typeof SUBTABS)[number][0]>('overview');
  const q = useQuery({ queryKey: ['privacy'], queryFn: () => get<Json>('/api/admin/privacy') });
  if (!q.data) return <Spinner />;
  return (
    <div className="stack">
      <div className="seg" role="tablist" aria-label="Privacy">
        {SUBTABS.map(([k, l]) => (
          <button key={k} role="tab" aria-selected={sub === k} onClick={() => setSub(k)}>
            {l}
            {k === 'requests' && q.data.stats.open ? ` (${q.data.stats.open})` : ''}
          </button>
        ))}
      </div>
      {sub === 'overview' && <Overview data={q.data} go={setSub} />}
      {sub === 'requests' && <Requests />}
      {sub === 'notices' && <Notices data={q.data} />}
      {sub === 'retention' && <RetentionPanel data={q.data} />}
      {sub === 'breaches' && <Breaches />}
      {sub === 'dnc' && <DoNotContact />}
    </div>
  );
}

function Overview({ data, go }: { data: Json; go: (k: 'requests' | 'notices') => void }) {
  const run = useRun();
  const cfg = data.config;
  const [f, setF] = useState({
    portalEnabled: !!cfg.portal_enabled,
    officerName: cfg.officer_name ?? '',
    officerEmail: cfg.officer_email ?? '',
    officerPhone: cfg.officer_phone ?? '',
    officerAddress: cfg.officer_address ?? '',
    requestSlaDays: cfg.request_sla_days ?? 30,
  });
  const s = data.stats;
  const published = data.notices.some((n: Json) => n.published_at);
  const checks: [boolean, string, string][] = [
    [!!(cfg.officer_email || cfg.officer_phone), 'Grievance officer named', 'Customers must know whom to contact about their data.'],
    [published, 'Privacy notice published', 'An itemised notice in clear language, shown before you collect consent.'],
    [!!cfg.portal_enabled, 'Request portal open', 'Customers can ask for access, correction or erasure, and raise grievances, online.'],
    [Object.values(cfg.retention ?? {}).some((v) => Number(v) > 0), 'Retention rules set', 'Personal data is erased once you no longer need it.'],
    [s.overdue === 0, 'No overdue requests', `Requests are answered within ${cfg.request_sla_days} days.`],
    [s.breaches === 0, 'No open breaches', 'Every breach is reported to the Board and to affected people.'],
  ];
  const score = checks.filter(([ok]) => ok).length;
  return (
    <div className="stack">
      <div className="kpis">
        <div className="panel kpi">
          <div className="l">Readiness checklist</div>
          <div className={`v ${score === checks.length ? 'tone-good' : 'tone-warn'}`}>
            {score}/{checks.length}
          </div>
        </div>
        <button className="panel kpi as-button" onClick={() => go('requests')}>
          <div className="l">Open requests</div>
          <div className={`v ${s.overdue ? 'tone-bad' : ''}`}>{s.open}</div>
          {s.overdue > 0 && <div className="small bad-text">{s.overdue} overdue</div>}
        </button>
        <div className="panel kpi">
          <div className="l">Answered on time (90 days)</div>
          <div className="v">{s.closed90 ? `${Math.round((s.ontime90 / s.closed90) * 100)}%` : '—'}</div>
        </div>
        <div className="panel kpi">
          <div className="l">People with marketing consent</div>
          <div className="v">{s.consented}</div>
          <div className="small muted">{s.suppressed} addresses on do-not-contact</div>
        </div>
      </div>
      <ul className="checklist">
        {checks.map(([ok, title, hint]) => (
          <li key={title} className={ok ? 'ok' : ''}>
            <span aria-hidden="true">{ok ? '✓' : '!'}</span>
            <div>
              <b>{title}</b>
              <div className="muted small">{hint}</div>
            </div>
          </li>
        ))}
      </ul>
      <section className="panel panel-body stack">
        <h3 style={{ margin: 0 }}>Grievance officer and request portal</h3>
        <div className="grid2">
          <label className="field">
            Name
            <input value={f.officerName} onChange={(e) => setF({ ...f, officerName: e.target.value })} />
          </label>
          <label className="field">
            Email
            <input type="email" value={f.officerEmail} onChange={(e) => setF({ ...f, officerEmail: e.target.value })} />
          </label>
          <label className="field">
            Phone
            <input value={f.officerPhone} onChange={(e) => setF({ ...f, officerPhone: e.target.value })} />
          </label>
          <label className="field">
            Answer requests within (days)
            <input type="number" min={1} max={90} value={f.requestSlaDays} onChange={(e) => setF({ ...f, requestSlaDays: Number(e.target.value) })} />
          </label>
          <label className="field wide">
            Postal address (optional)
            <input value={f.officerAddress} onChange={(e) => setF({ ...f, officerAddress: e.target.value })} />
          </label>
          <label className="check wide">
            <input type="checkbox" checked={f.portalEnabled} onChange={(e) => setF({ ...f, portalEnabled: e.target.checked })} /> Open the public privacy page (notice and request form)
          </label>
        </div>
        {data.portalUrl && <CopyField label="Privacy page: link it from your website footer, forms and WhatsApp profile" value={data.portalUrl} />}
        <div>
          <button className="btn primary" onClick={() => run(() => put('/api/admin/privacy/config', { ...f, retention: cfg.retention }), 'Saved')}>
            Save
          </button>
        </div>
      </section>
    </div>
  );
}

// ------------------------------------------------------------------------------------ requests

function Requests() {
  const [status, setStatus] = useState<'open' | 'all'>('open');
  const [open, setOpen] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const q = useQuery({ queryKey: ['privacy', 'requests', status], queryFn: () => get<{ items: Json[] }>(`/api/admin/privacy/requests?status=${status}`) });
  return (
    <div className="stack">
      <div className="spread">
        <div className="seg">
          <button aria-pressed={status === 'open'} onClick={() => setStatus('open')}>
            Open
          </button>
          <button aria-pressed={status === 'all'} onClick={() => setStatus('all')}>
            All
          </button>
        </div>
        <button className="btn" onClick={() => setAdding(true)}>
          Log a request
        </button>
      </div>
      {!q.data ? (
        <Spinner />
      ) : !q.data.items.length ? (
        <Empty title="No requests">Requests from the privacy page, email or phone appear here with their deadline.</Empty>
      ) : (
        <table className="data">
          <thead>
            <tr>
              <th>Request</th>
              <th>From</th>
              <th>Status</th>
              <th>Due</th>
            </tr>
          </thead>
          <tbody>
            {q.data.items.map((r) => (
              <tr key={r.id} className="click" onClick={() => setOpen(r.id)}>
                <td>
                  <b>{r.number}</b>
                  <div className="muted small">{KIND_LABEL[r.kind]}</div>
                </td>
                <td>
                  {r.requester_name}
                  <div className="muted small">{r.requester_email ?? r.requester_phone}</div>
                </td>
                <td>
                  <span className={`chip ${r.status === 'completed' ? 'good' : r.status === 'rejected' ? '' : 'info'}`}>{STATUS_LABEL[r.status]}</span>
                </td>
                <td className={r.overdue ? 'bad-text' : ''}>{['completed', 'rejected'].includes(r.status) ? `Closed ${date(r.resolved_at)}` : `${date(r.due_at)} (${relative(r.due_at)})`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {open && <RequestModal id={open} onClose={() => setOpen(null)} />}
      {adding && <NewRequest onClose={() => setAdding(false)} />}
    </div>
  );
}

function NewRequest({ onClose }: { onClose: () => void }) {
  const run = useRun();
  const [f, setF] = useState({ kind: 'access', source: 'email', name: '', email: '', phone: '', details: '' });
  return (
    <Modal
      title="Log a privacy request"
      onClose={onClose}
      footer={
        <button
          className="btn primary"
          disabled={!f.name || (!f.email && !f.phone)}
          onClick={async () => {
            if (await run(() => post('/api/admin/privacy/requests', { ...f, email: f.email || null, phone: f.phone || null }), 'Request logged', [['privacy']])) onClose();
          }}
        >
          Log request
        </button>
      }
    >
      <div className="modal-body grid2">
        <label className="field">
          Type
          <select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>
            {Object.entries(KIND_LABEL).map(([k, l]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          Received by
          <select value={f.source} onChange={(e) => setF({ ...f, source: e.target.value })}>
            <option value="email">Email</option>
            <option value="phone">Phone</option>
            <option value="whatsapp">WhatsApp</option>
            <option value="manual">In person</option>
          </select>
        </label>
        <label className="field wide">
          Name
          <input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        </label>
        <label className="field">
          Email
          <input value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
        </label>
        <label className="field">
          Phone
          <input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} />
        </label>
        <label className="field wide">
          What they asked for
          <textarea rows={3} value={f.details} onChange={(e) => setF({ ...f, details: e.target.value })} />
        </label>
      </div>
    </Modal>
  );
}

function RequestModal({ id, onClose }: { id: string; onClose: () => void }) {
  const run = useRun();
  const users = useUsers();
  const q = useQuery({ queryKey: ['privacy', 'request', id], queryFn: () => get<Json>(`/api/admin/privacy/requests/${id}`) });
  const [note, setNote] = useState('');
  const [resolution, setResolution] = useState('');
  const [confirmErase, setConfirmErase] = useState(false);
  const r = q.data;
  const keys = [['privacy']];
  if (!r) return null;
  const closed = ['completed', 'rejected'].includes(r.status);
  const act = (body: Json, ok: string) => run(() => patch(`/api/admin/privacy/requests/${id}`, body), ok, keys);
  return (
    <Modal wide title={`${r.number} · ${KIND_LABEL[r.kind]}`} onClose={onClose}>
      <div className="modal-body stack">
        <div className="grid2">
          <div>
            <div className="muted small">From</div>
            <b>{r.requester_name}</b>
            <div>{r.requester_email}</div>
            <div>{r.requester_phone}</div>
          </div>
          <div>
            <div className="muted small">Status</div>
            <b>{STATUS_LABEL[r.status]}</b>
            <div className="small">
              Received {dateTime(r.created_at)} · due {date(r.due_at)}
            </div>
            <div className="small">{r.verified_at ? `Verified ${dateTime(r.verified_at)}` : 'Not verified yet'}</div>
          </div>
        </div>
        {r.details && <p className="pre-wrap panel panel-body">{r.details}</p>}
        {!closed && (
          <label className="field">
            Assigned to
            <select value={r.assigned_to ?? ''} onChange={(e) => act({ assignedTo: e.target.value || null }, 'Assigned')}>
              <option value="">Nobody</option>
              {users.data?.items.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.full_name}
                </option>
              ))}
            </select>
          </label>
        )}
        <section className="stack">
          <b>Person’s record</b>
          {r.subject_id ? (
            <div className="row">
              <a href={`/o/${r.subject_object}/${r.subject_id}`} target="_blank" rel="noreferrer">
                Open {r.subject_object}
              </a>
              {!closed && (
                <button className="btn sm ghost" onClick={() => act({ subject: null }, 'Unlinked')}>
                  Unlink
                </button>
              )}
            </div>
          ) : r.matches.length ? (
            <div className="stack">
              <span className="muted small">Records with the same email or phone:</span>
              {r.matches.map((m: Json) => (
                <div key={m.id} className="row">
                  <span>
                    {m.name} <span className="muted small">({m.object}, {m.email ?? m.phone})</span>
                  </span>
                  <button className="btn sm" disabled={closed} onClick={() => act({ subject: { object: m.object, id: m.id } }, 'Linked')}>
                    This is them
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <span className="muted small">No lead or contact matches this email or phone.</span>
          )}
        </section>
        {!closed && !r.verified_at && (
          <section className="stack">
            <b>Verify the requester</b>
            <span className="muted small">
              {r.status === 'verifying' ? 'We emailed them a confirmation link. You can also verify them yourself, for example by calling the number on their record.' : 'Confirm the person is who they say they are before acting.'}
            </span>
            <div className="row">
              <input placeholder="How you verified them" value={note} onChange={(e) => setNote(e.target.value)} />
              <button className="btn" disabled={note.length < 3} onClick={() => act({ markVerified: true, verificationNote: note }, 'Marked verified')}>
                Mark verified
              </button>
            </div>
          </section>
        )}
        {r.subject_id && r.verified_at && (
          <div className="row">
            <button className="btn" onClick={() => run(() => download(`/api/admin/privacy/requests/${id}/export`, `${r.number}.json`), 'Downloaded', [])}>
              Download their data (JSON)
            </button>
            <span className="muted small">Send this summary to the person for an access request.</span>
          </div>
        )}
        {closed ? (
          <section className="panel panel-body">
            <b>Resolution</b>
            <p className="pre-wrap">{r.resolution}</p>
          </section>
        ) : (
          <section className="stack">
            <b>Close the request</b>
            <textarea rows={3} placeholder="What you did. The requester receives this by email." value={resolution} onChange={(e) => setResolution(e.target.value)} />
            {r.kind === 'erasure' && (
              <label className="check">
                <input type="checkbox" checked={confirmErase} onChange={(e) => setConfirmErase(e.target.checked)} /> Erase their name, contact details, messages, notes and files now. Tax invoices stay, as GST law requires. This cannot be undone.
              </label>
            )}
            <div className="row">
              <button
                className={`btn ${r.kind === 'erasure' ? 'danger' : 'primary'}`}
                disabled={resolution.length < 5 || (r.kind === 'erasure' && !confirmErase)}
                onClick={async () => {
                  const out = await run(() => post<Json>(`/api/admin/privacy/requests/${id}/complete`, { outcome: 'completed', resolution, erase: confirmErase }), 'Request completed', keys);
                  if (out) onClose();
                }}
              >
                {r.kind === 'erasure' ? 'Erase and complete' : 'Complete'}
              </button>
              <button
                className="btn"
                disabled={resolution.length < 5}
                onClick={async () => {
                  if (await run(() => post(`/api/admin/privacy/requests/${id}/complete`, { outcome: 'rejected', resolution }), 'Request rejected', keys)) onClose();
                }}
              >
                Reject with reason
              </button>
            </div>
          </section>
        )}
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------------------------------- notices

function Notices({ data }: { data: Json }) {
  const run = useRun();
  const [edit, setEdit] = useState<{ title: string; body: string; language: string; purposes: { key: string; label: string; required: boolean }[] } | null>(null);
  const [view, setView] = useState<Json | null>(null);
  const start = async () => {
    const latest = data.notices[0];
    if (latest) {
      const full = await get<Json>(`/api/admin/privacy/notices/${latest.id}`);
      setEdit({ title: full.title, body: full.body, language: full.language, purposes: full.purposes });
    } else {
      const t = await get<{ body: string }>('/api/admin/privacy/notice-template');
      setEdit({ title: 'Privacy notice', body: t.body, language: 'en', purposes: [{ key: 'marketing', label: 'Offers and updates on WhatsApp, email and SMS', required: false }] });
    }
  };
  return (
    <div className="stack">
      <div className="spread">
        <p className="muted small" style={{ margin: 0 }}>
          Published notices are never edited: every change becomes a new version, and each consent records the version the person saw.
        </p>
        <button className="btn primary" onClick={start}>
          {data.notices.length ? 'New version' : 'Write a notice'}
        </button>
      </div>
      {data.notices.length ? (
        <table className="data">
          <tbody>
            {data.notices.map((n: Json) => (
              <tr key={n.id}>
                <td>
                  <b>
                    v{n.version} · {n.title}
                  </b>
                  <div className="muted small">{n.language}</div>
                </td>
                <td>{n.published_at ? <span className="chip good">Published {date(n.published_at)}</span> : <span className="chip">Draft</span>}</td>
                <td className="row" style={{ justifyContent: 'flex-end' }}>
                  <button className="btn sm" onClick={async () => setView(await get<Json>(`/api/admin/privacy/notices/${n.id}`))}>
                    View
                  </button>
                  {!n.published_at && (
                    <button className="btn sm primary" onClick={() => run(() => post(`/api/admin/privacy/notices/${n.id}/publish`), 'Published')}>
                      Publish
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <Empty title="No notice yet">Start from our template: it lists your purposes, people’s rights, the grievance officer and the Data Protection Board.</Empty>
      )}
      {view && (
        <Modal wide title={`v${view.version} · ${view.title}`} onClose={() => setView(null)}>
          <div className="modal-body one">
            <Markdown source={view.body} />
          </div>
        </Modal>
      )}
      {edit && (
        <Modal
          wide
          title="Privacy notice"
          onClose={() => setEdit(null)}
          footer={
            <>
              <button className="btn" onClick={async () => (await run(() => post('/api/admin/privacy/notices', { ...edit, publish: false }), 'Draft saved')) && setEdit(null)}>
                Save draft
              </button>
              <button className="btn primary" onClick={async () => (await run(() => post('/api/admin/privacy/notices', { ...edit, publish: true }), 'Published')) && setEdit(null)}>
                Publish
              </button>
            </>
          }
        >
          <div className="modal-body grid2">
            <label className="field">
              Title
              <input value={edit.title} onChange={(e) => setEdit({ ...edit, title: e.target.value })} />
            </label>
            <label className="field">
              Language
              <select value={edit.language} onChange={(e) => setEdit({ ...edit, language: e.target.value })}>
                {[['en', 'English'], ['hi', 'Hindi'], ['mr', 'Marathi'], ['gu', 'Gujarati'], ['ta', 'Tamil'], ['te', 'Telugu'], ['kn', 'Kannada'], ['bn', 'Bengali'], ['ml', 'Malayalam'], ['pa', 'Punjabi']].map(([k, l]) => (
                  <option key={k} value={k}>
                    {l}
                  </option>
                ))}
              </select>
            </label>
            <label className="field wide">
              Notice (headings with #, lists with -, **bold**)
              <textarea rows={16} className="mono small" value={edit.body} onChange={(e) => setEdit({ ...edit, body: e.target.value })} />
            </label>
            <div className="wide">
              <b>Preview</b>
              <div className="panel panel-body notice-preview">
                <Markdown source={edit.body} />
              </div>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ----------------------------------------------------------------------------------- retention

const RULES: [string, string, string][] = [
  ['leadsUnconvertedMonths', 'Leads that never converted', 'months with no activity'],
  ['recycleBinDays', 'Deleted leads and contacts', 'days after deletion'],
  ['messagesMonths', 'Message text (WhatsApp, email, SMS)', 'months after sending'],
  ['recordingsMonths', 'Call recordings', 'months after the call'],
  ['lostDealsMonths', 'Notes on lost deals', 'months after closing'],
];

function RetentionPanel({ data }: { data: Json }) {
  const run = useRun();
  const cfg = data.config;
  const [r, setR] = useState<Record<string, number>>(cfg.retention);
  const [preview, setPreview] = useState<Json | null>(null);
  const save = () =>
    run(
      () =>
        put('/api/admin/privacy/config', {
          portalEnabled: !!cfg.portal_enabled,
          officerName: cfg.officer_name,
          officerEmail: cfg.officer_email ?? '',
          officerPhone: cfg.officer_phone,
          officerAddress: cfg.officer_address,
          requestSlaDays: cfg.request_sla_days,
          retention: r,
        }),
      'Retention rules saved',
    );
  return (
    <div className="stack">
      <p className="muted small" style={{ margin: 0 }}>
        Personal data should be erased once you no longer need it. These rules run every night. 0 keeps data until you delete it. Tax invoices and payments are never touched.
      </p>
      <table className="data">
        <tbody>
          {RULES.map(([k, label, unit]) => (
            <tr key={k}>
              <td>{label}</td>
              <td className="row">
                Erase after <input type="number" min={0} style={{ width: 80 }} value={r[k] ?? 0} onChange={(e) => setR({ ...r, [k]: Number(e.target.value) })} /> {unit}
              </td>
              <td className="muted small">{preview && preview[{ leadsUnconvertedMonths: 'leads', recycleBinDays: 'deleted', messagesMonths: 'messages', recordingsMonths: 'recordings', lostDealsMonths: 'lostDeals' }[k]!] !== undefined ? `${preview[{ leadsUnconvertedMonths: 'leads', recycleBinDays: 'deleted', messagesMonths: 'messages', recordingsMonths: 'recordings', lostDealsMonths: 'lostDeals' }[k]!]} affected today` : ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="row">
        <button className="btn primary" onClick={save}>
          Save
        </button>
        <button
          className="btn"
          onClick={async () => {
            await save();
            setPreview(await run(() => post<Json>('/api/admin/privacy/retention/preview'), null, []));
          }}
        >
          Preview what would be erased
        </button>
        {cfg.retention_last_run && <span className="muted small">Last run {relative(cfg.retention_last_run)}</span>}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------------------------ breaches

function Breaches() {
  const run = useRun();
  const q = useQuery({ queryKey: ['privacy', 'breaches'], queryFn: () => get<{ items: Json[] }>('/api/admin/privacy/breaches') });
  const [f, setF] = useState<{ title: string; severity: string; affectedCount: string; dataCategories: string; description: string } | null>(null);
  const stamp = (id: string, field: string, ok: string, status?: string) => run(() => patch(`/api/admin/privacy/breaches/${id}`, { [field]: new Date().toISOString(), ...(status ? { status } : {}) }), ok, [['privacy']]);
  return (
    <div className="stack">
      <div className="spread">
        <p className="muted small" style={{ margin: 0 }}>
          Record every personal-data breach. Inform the Data Protection Board and each affected person without delay, and send the Board a detailed report within 72 hours of becoming aware.
        </p>
        <button className="btn" onClick={() => setF({ title: '', severity: 'medium', affectedCount: '', dataCategories: '', description: '' })}>
          Record a breach
        </button>
      </div>
      {!q.data ? (
        <Spinner />
      ) : !q.data.items.length ? (
        <Empty title="No breaches recorded" />
      ) : (
        q.data.items.map((b) => {
          const hours = (Date.now() - new Date(b.detected_at).getTime()) / 3.6e6;
          return (
            <section key={b.id} className="panel panel-body stack">
              <div className="spread">
                <div>
                  <b>{b.title}</b>
                  <div className="muted small">
                    Detected {dateTime(b.detected_at)} · {b.severity} · {b.affected_count ?? '?'} people · {(b.data_categories ?? []).join(', ')}
                  </div>
                </div>
                <span className={`chip ${b.status === 'closed' ? 'good' : b.status === 'open' ? 'bad' : 'warn'}`}>{b.status}</span>
              </div>
              {b.status !== 'closed' && !b.board_report_at && hours < 72 && <div className="small warn-text">Detailed report to the Board due in {Math.max(0, Math.round(72 - hours))} hours</div>}
              {b.status !== 'closed' && !b.board_report_at && hours >= 72 && <div className="small bad-text">The 72-hour report to the Board is overdue</div>}
              <ul className="timeline-steps small">
                <li className={b.contained_at ? 'done' : ''}>Contained {b.contained_at ? dateTime(b.contained_at) : <button className="btn sm" onClick={() => stamp(b.id, 'containedAt', 'Marked contained', 'contained')}>Mark now</button>}</li>
                <li className={b.board_intimated_at ? 'done' : ''}>Board intimated {b.board_intimated_at ? dateTime(b.board_intimated_at) : <button className="btn sm" onClick={() => stamp(b.id, 'boardIntimatedAt', 'Recorded')}>Mark now</button>}</li>
                <li className={b.principals_notified_at ? 'done' : ''}>Affected people informed {b.principals_notified_at ? dateTime(b.principals_notified_at) : <button className="btn sm" onClick={() => stamp(b.id, 'principalsNotifiedAt', 'Recorded')}>Mark now</button>}</li>
                <li className={b.board_report_at ? 'done' : ''}>Detailed report to the Board {b.board_report_at ? dateTime(b.board_report_at) : <button className="btn sm" onClick={() => stamp(b.id, 'boardReportAt', 'Recorded', 'reported')}>Mark now</button>}</li>
              </ul>
              {b.status !== 'closed' && (
                <div>
                  <button className="btn sm" onClick={() => run(() => patch(`/api/admin/privacy/breaches/${b.id}`, { status: 'closed' }), 'Closed', [['privacy']])}>
                    Close
                  </button>
                </div>
              )}
            </section>
          );
        })
      )}
      {f && (
        <Modal
          title="Record a breach"
          onClose={() => setF(null)}
          footer={
            <button
              className="btn primary"
              disabled={f.title.length < 3}
              onClick={async () => {
                const ok = await run(
                  () => post('/api/admin/privacy/breaches', { title: f.title, severity: f.severity, affectedCount: f.affectedCount ? Number(f.affectedCount) : null, dataCategories: f.dataCategories.split(',').map((s) => s.trim()).filter(Boolean), description: f.description || null }),
                  'Breach recorded',
                  [['privacy']],
                );
                if (ok) setF(null);
              }}
            >
              Record
            </button>
          }
        >
          <div className="modal-body grid2">
            <label className="field wide">
              What happened
              <input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder="e.g. Sales laptop with customer list stolen" />
            </label>
            <label className="field">
              Severity
              <select value={f.severity} onChange={(e) => setF({ ...f, severity: e.target.value })}>
                {['low', 'medium', 'high', 'critical'].map((s) => (
                  <option key={s}>{s}</option>
                ))}
              </select>
            </label>
            <label className="field">
              People affected (approx.)
              <input type="number" min={0} value={f.affectedCount} onChange={(e) => setF({ ...f, affectedCount: e.target.value })} />
            </label>
            <label className="field wide">
              Data involved (comma separated)
              <input value={f.dataCategories} onChange={(e) => setF({ ...f, dataCategories: e.target.value })} placeholder="names, phone numbers, addresses" />
            </label>
            <label className="field wide">
              Details
              <textarea rows={4} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
            </label>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ------------------------------------------------------------------------------- do not contact

function DoNotContact() {
  const run = useRun();
  const [q, setQ] = useState('');
  const [add, setAdd] = useState({ channel: 'all', address: '', note: '' });
  const list = useQuery({ queryKey: ['privacy', 'dnc', q], queryFn: () => get<{ items: Json[] }>(`/api/admin/privacy/suppressions?q=${encodeURIComponent(q)}`) });
  return (
    <div className="stack">
      <p className="muted small" style={{ margin: 0 }}>
        Opt-outs from WhatsApp STOP replies, unsubscribe links and consent withdrawals land here automatically. Campaigns and automations skip these addresses. Erased people are kept as an anonymous fingerprint so they are never contacted again.
      </p>
      <div className="row">
        <input placeholder="Search a phone or email" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="row">
        <select value={add.channel} onChange={(e) => setAdd({ ...add, channel: e.target.value })} style={{ width: 'auto' }}>
          {['all', 'whatsapp', 'email', 'sms', 'calls'].map((c) => (
            <option key={c}>{c}</option>
          ))}
        </select>
        <input placeholder="Phone or email" value={add.address} onChange={(e) => setAdd({ ...add, address: e.target.value })} />
        <input placeholder="Note" value={add.note} onChange={(e) => setAdd({ ...add, note: e.target.value })} />
        <button className="btn" disabled={add.address.length < 3} onClick={async () => (await run(() => post('/api/admin/privacy/suppressions', add), 'Added', [['privacy']])) && setAdd({ ...add, address: '', note: '' })}>
          Block
        </button>
      </div>
      <table className="data">
        <tbody>
          {list.data?.items.map((s, i) => (
            <tr key={i}>
              <td className="mono small">{s.address}</td>
              <td>{s.channel}</td>
              <td>
                <span className="chip">{s.reason.replace('_', ' ')}</span>
                {s.note && <div className="muted small">{s.note}</div>}
              </td>
              <td className="muted small">{relative(s.created_at)}</td>
              <td>
                {['manual', 'bounce', 'complaint'].includes(s.reason) && (
                  <button className="btn sm ghost" onClick={() => run(() => api('/api/admin/privacy/suppressions', { method: 'DELETE', body: { channel: s.channel, address: s.address } }), 'Removed', [['privacy']])}>
                    Remove
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// --------------------------------------------------------------------- consent panel on a record

export function ConsentPanel({ object, id }: { object: 'lead' | 'contact'; id: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['consent', object, id], queryFn: () => get<Json>(`/api/v1/consent/${object}/${id}`) });
  const [showLog, setShowLog] = useState(false);
  if (!q.data) return null;
  const set = async (purpose: string, granted: boolean) => {
    try {
      const r = await post<Json>(`/api/v1/consent/${object}/${id}`, { purpose, granted });
      qc.setQueryData(['consent', object, id], r);
      toast(granted ? 'Consent recorded' : 'Consent withdrawn');
    } catch (e) {
      toast((e as Error).message, true);
    }
  };
  const st = q.data.state as Json;
  const blocked = new Map<string, string>((q.data.suppressed as Json[]).map((s) => [s.channel, s.reason]));
  const rows: [string, string][] = [
    ['whatsapp', 'WhatsApp offers'],
    ['email', 'Email offers'],
    ['sms', 'SMS offers'],
    ['calls', 'Sales calls'],
  ];
  return (
    <section className="panel side-card">
      <div className="panel-head">
        <h2>Consent</h2>
        <button className="btn sm ghost" onClick={() => setShowLog(!showLog)}>
          {showLog ? 'Hide history' : 'History'}
        </button>
      </div>
      <div className="panel-body stack" style={{ gap: 8 }}>
        {rows.map(([k, l]) => {
          const own = st[k];
          const on = blocked.has(k) || blocked.has('all') ? false : own ? own.granted : !!st.marketing?.granted;
          const reason = blocked.get(k) ?? blocked.get('all');
          return (
            <div key={k} className="spread small">
              <span>
                {l}
                {reason && <span className="chip bad" style={{ marginLeft: 6 }}>{reason === 'erasure' ? 'erased' : reason.replace('_', ' ')}</span>}
              </span>
              <label className="switch" title={reason === 'erasure' ? 'This address belongs to an erased person' : undefined}>
                <input type="checkbox" aria-label={l} checked={on} disabled={reason === 'erasure' || reason === 'manual'} onChange={(e) => set(k, e.target.checked)} />
              </label>
            </div>
          );
        })}
        {showLog && (
          <ul className="consent-log small">
            {(q.data.events as Json[]).map((e) => (
              <li key={e.id}>
                <b>{e.granted ? 'Gave' : 'Withdrew'}</b> {e.purpose} · {e.source.replace('_', ' ')}
                {e.notice_version ? ` · notice v${e.notice_version}` : ''}
                <div className="muted">
                  {dateTime(e.created_at)}
                  {e.actor ? ` by ${e.actor}` : ''}
                </div>
              </li>
            ))}
            {!q.data.events.length && <li className="muted">No consent recorded yet.</li>}
          </ul>
        )}
      </div>
    </section>
  );
}
