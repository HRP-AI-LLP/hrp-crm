/**
 * Mail intake: GeM bids (from alert mails, with the eligibility check and the bid pack), bills and
 * invoices that arrived by mail (read and made into draft bills), and the mailboxes that are read.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { Link, NavLink, useNavigate, useParams } from 'react-router-dom';
import { Empty, Modal, Spinner, useToast } from '../components/ui';
import { del, download, get, patch, post, put } from '../lib/api';
import { readDocument } from '../lib/doc-read';
import { date, dateTime, money2 } from '../lib/format';
import { useUsers } from '../lib/hooks';

type Json = Record<string, any>;

function useAct(keys: unknown[][]) {
  const qc = useQueryClient();
  const toast = useToast();
  return async <T,>(fn: () => Promise<T>, ok?: string | ((r: T) => string)): Promise<T | null> => {
    try {
      const r = await fn();
      if (ok) toast(typeof ok === 'function' ? ok(r) : ok);
      for (const k of keys) qc.invalidateQueries({ queryKey: k });
      return r;
    } catch (e) {
      toast((e as Error).message, true);
      return null;
    }
  };
}

const SECTIONS: [string, string][] = [
  ['gem', 'GeM bids'],
  ['documents', 'Bills & invoices'],
  ['mailboxes', 'Mailboxes'],
];

export function IntakePage() {
  const { section = 'gem' } = useParams();
  return (
    <div>
      <div className="page-head">
        <div>
          <h1>{SECTIONS.find((s) => s[0] === section)?.[1] ?? 'Mail intake'}</h1>
          <p className="muted small" style={{ margin: 0 }}>
            Read from your mailboxes: GeM alerts become bids to follow; mailed bills and invoices become draft bills. Other mail is never stored.
          </p>
        </div>
      </div>
      <nav className="viewbar" aria-label="Mail intake" style={{ marginBottom: 12 }}>
        {SECTIONS.map(([k, l]) => (
          <NavLink key={k} to={`/intake/${k}`} className={({ isActive }) => `btn sm${isActive ? ' primary' : ' ghost'}`}>
            {l}
          </NavLink>
        ))}
      </nav>
      {section === 'gem' && <GemBids />}
      {section === 'documents' && <Documents />}
      {section === 'mailboxes' && <Mailboxes />}
    </div>
  );
}

/* ───────────────────────── GeM bids ───────────────────────── */

const BID_STATUS: [string, string, string][] = [
  ['new', 'New', 'info'],
  ['reviewing', 'Reviewing', 'warn'],
  ['preparing', 'Preparing', 'warn'],
  ['submitted', 'Submitted', 'info'],
  ['technically_qualified', 'Technically qualified', 'good'],
  ['won', 'Won', 'good'],
  ['lost', 'Lost', 'bad'],
  ['skipped', 'Skipped', ''],
  ['cancelled', 'Cancelled', ''],
];
const statusChip = (s: string) => {
  const x = BID_STATUS.find((b) => b[0] === s);
  return <span className={`chip ${x?.[2] ?? ''}`}>{x?.[1] ?? s}</span>;
};
const left = (end: string | null) => {
  if (!end) return '—';
  const ms = Date.parse(end) - Date.now();
  if (ms <= 0) return 'Closed';
  const d = Math.floor(ms / 86_400_000);
  const h = Math.floor((ms % 86_400_000) / 3_600_000);
  return d ? `${d}d ${h}h left` : `${h}h left`;
};

function GemBids() {
  const [view, setView] = useState<'open' | 'all'>('open');
  const [status, setStatus] = useState('');
  const { data } = useQuery({ queryKey: ['intake', 'gem', view, status], queryFn: () => get<Json[]>(`/api/v1/intake/gem?${view === 'open' ? 'open=1' : ''}${status ? `&status=${status}` : ''}`) });
  const act = useAct([['intake']]);
  const [open, setOpen] = useState<string | null>(() => new URLSearchParams(window.location.search).get('bid'));
  const [adding, setAdding] = useState(false);
  const [q, setQ] = useState('');
  const rows = useMemo(() => (data ?? []).filter((b) => !q || `${b.bid_number} ${b.title ?? ''} ${b.organisation ?? ''} ${b.category ?? ''}`.toLowerCase().includes(q.toLowerCase())), [data, q]);
  return (
    <div className="stack">
      <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
        <div className="row" role="group">
          <button className={`btn sm${view === 'open' ? ' primary' : ' ghost'}`} onClick={() => setView('open')}>
            Open to bid
          </button>
          <button className={`btn sm${view === 'all' ? ' primary' : ' ghost'}`} onClick={() => setView('all')}>
            All
          </button>
        </div>
        {view === 'all' && (
          <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status" style={{ width: 'auto' }}>
            <option value="">Any status</option>
            {BID_STATUS.map(([k, l]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </select>
        )}
        <input placeholder="Search bids" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 260 }} />
        <button className="btn sm" onClick={() => setAdding(true)}>
          + Add a bid by number
        </button>
        <a className="btn sm ghost" href="https://bidplus.gem.gov.in/all-bids" target="_blank" rel="noreferrer noopener">
          GeM all bids ↗
        </a>
        <WatchKeywords />
        <DefaultOwner />
      </div>
      {rows.length ? (
        <table className="data" data-export-title="GeM bids">
          <thead>
            <tr>
              <th>Bid</th>
              <th>What</th>
              <th>Ministry / buyer</th>
              <th className="num">Bid value</th>
              <th className="num">EMD</th>
              <th>Exemptions</th>
              <th>Opened</th>
              <th>Closes</th>
              <th>Status</th>
              <th>Owner</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((b) => (
              <tr key={b.id} className="click" onClick={() => setOpen(b.id)}>
                <td style={{ whiteSpace: 'nowrap' }}>
                  {b.bid_number}
                  {b.corrigenda ? (
                    <div>
                      <span className="chip warn" title="Corrigenda issued">
                        {b.corrigenda} corr.
                      </span>
                    </div>
                  ) : null}
                </td>
                <td>
                  {b.title ?? b.category ?? <span className="muted">{b.fetch_error ? 'Could not read it from GeM yet' : 'Reading it from GeM…'}</span>}
                  {(b.matched_keywords ?? []).map((k: string) => (
                    <span key={k} className="pill info" style={{ marginLeft: 6 }} title="Matches a keyword you watch">
                      ★ {k}
                    </span>
                  ))}
                  <div className="small muted">
                    {[b.quantity ? `Qty ${b.quantity}` : null, (b.files ?? []).filter((f: Json) => f.fileId).length ? `${(b.files ?? []).filter((f: Json) => f.fileId).length} document(s)` : null]
                      .filter(Boolean)
                      .join(' · ')}
                  </div>
                </td>
                <td className="small">
                  {b.ministry ?? '—'}
                  <div className="muted">{[b.organisation, b.department].filter(Boolean).join(' · ')}</div>
                </td>
                <td className="num">{b.bid_value ? money2(b.bid_value) : '—'}</td>
                <td className="num">{b.emd_amount ? money2(b.emd_amount) : b.emd_amount === 0 ? 'None' : '—'}</td>
                <td className="small">
                  {b.mse_exempt == null && b.startup_exempt == null ? (
                    '—'
                  ) : (
                    <>
                      <span className={`chip ${b.mse_exempt ? 'good' : ''}`}>MSE {b.mse_exempt ? '✓' : '✗'}</span> <span className={`chip ${b.startup_exempt ? 'good' : ''}`}>Startup {b.startup_exempt ? '✓' : '✗'}</span>
                    </>
                  )}
                </td>
                <td className="small" style={{ whiteSpace: 'nowrap' }}>
                  {b.start_at ? dateTime(b.start_at) : b.bid_date ? date(b.bid_date) : '—'}
                </td>
                <td style={{ whiteSpace: 'nowrap' }}>
                  {b.end_at ? dateTime(b.end_at) : '—'}
                  <div className="small muted">{left(b.end_at)}</div>
                </td>
                <td>{statusChip(b.status)}</td>
                <td className="small">{b.owner_name ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <Empty title={view === 'open' ? 'No open bids' : 'No bids yet'}>
          GeM bids appear here from the alert mails GeM sends (“New bid(s) published on GeM portal”, corrigenda, results) once a mailbox is added under <Link to="/intake/mailboxes">Mailboxes</Link>.
        </Empty>
      )}
      {open && <BidModal id={open} onClose={() => setOpen(null)} />}
      {adding && (
        <AddBid
          onClose={() => setAdding(false)}
          onSave={async (b) => {
            const r = await act(() => post<{ id: string }>('/api/v1/intake/gem', b), 'Bid added');
            if (r) {
              setAdding(false);
              setOpen(r.id);
            }
          }}
        />
      )}
    </div>
  );
}

/** Who new GeM bids belong to (the admin chooses; otherwise the workspace owner). */
/** The words the business watches GeM for: new bids that mention one are starred and announced. */
function WatchKeywords() {
  const { data } = useQuery({ queryKey: ['intake', 'gem-settings'], queryFn: () => get<Json>('/api/v1/intake/gem-settings') });
  const { data: users } = useUsers();
  const act = useAct([['intake']]);
  const [open, setOpen] = useState(false);
  const [words, setWords] = useState('');
  const [who, setWho] = useState<string[]>([]);
  if (!data) return null;
  const n = (data.keywords ?? []).length;
  return (
    <>
      <button
        className="btn sm"
        title="Bids that mention these words are starred, and you are told"
        onClick={() => {
          setWords((data.keywords ?? []).join('\n'));
          setWho(data.alertUserIds ?? []);
          setOpen(true);
        }}
      >
        ★ Watch keywords{n ? ` (${n})` : ''}
      </button>
      {open && (
        <Modal
          title="Keywords to watch on GeM"
          onClose={() => setOpen(false)}
          footer={
            data.canEdit ? (
              <button
                className="btn primary"
                onClick={async () => {
                  const r = await act(
                    () => put<Json>('/api/v1/intake/gem-settings', { defaultOwnerId: data.defaultOwnerId ?? null, applyToUnowned: false, keywords: words.split(/[\n,]+/).map((w) => w.trim()).filter(Boolean), alertUserIds: who }),
                    'Saved; open bids were matched again',
                  );
                  if (r) setOpen(false);
                }}
              >
                Save
              </button>
            ) : undefined
          }
        >
          <div className="modal-body" style={{ display: 'block' }}>
            <p className="small muted" style={{ marginTop: 0 }}>
              One per line (or separated by commas): products, services or buyers, e.g. <i>CCTV</i>, <i>data entry</i>, <i>software development</i>, <i>Food Corporation</i>. A new bid whose title, category or buyer mentions one is starred, and its owner and the people below get a notification.
            </p>
            <textarea rows={7} value={words} disabled={!data.canEdit} onChange={(e) => setWords(e.target.value)} placeholder={'CCTV\ndata entry\nAI'} />
            <div className="small" style={{ fontWeight: 600, margin: '12px 0 6px' }}>Also tell</div>
            <div className="row" style={{ flexWrap: 'wrap', gap: 12 }}>
              {(users?.items ?? []).map((u) => (
                <label key={u.id} className="row small" style={{ gap: 6 }}>
                  <input type="checkbox" disabled={!data.canEdit} checked={who.includes(u.id)} onChange={(e) => setWho(e.target.checked ? [...who, u.id] : who.filter((x) => x !== u.id))} />
                  {u.full_name}
                </label>
              ))}
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}

function DefaultOwner() {
  const { data } = useQuery({ queryKey: ['intake', 'gem-settings'], queryFn: () => get<Json>('/api/v1/intake/gem-settings') });
  const { data: users } = useUsers();
  const act = useAct([['intake']]);
  if (!data) return null;
  const name = (id: string | null) => (users?.items ?? []).find((u) => u.id === id)?.full_name ?? '—';
  if (!data.canEdit) return <span className="small muted">New bids go to {name(data.effectiveOwnerId)}</span>;
  return (
    <label className="row small" style={{ gap: 6, marginLeft: 'auto' }}>
      New bids go to
      <select
        value={data.defaultOwnerId ?? ''}
        style={{ width: 'auto' }}
        onChange={(e) => act(() => put<Json>('/api/v1/intake/gem-settings', { defaultOwnerId: e.target.value || null, applyToUnowned: true }), (r) => `Saved${r.applied ? `; ${r.applied} bid(s) without an owner given to them` : ''}`)}
      >
        <option value="">The workspace owner</option>
        {(users?.items ?? []).map((u) => (
          <option key={u.id} value={u.id}>
            {u.full_name}
          </option>
        ))}
      </select>
    </label>
  );
}

function AddBid({ onClose, onSave }: { onClose: () => void; onSave: (b: Json) => void }) {
  const [n, setN] = useState('');
  const [title, setTitle] = useState('');
  return (
    <Modal
      title="Add a GeM bid"
      onClose={onClose}
      footer={
        <button className="btn primary" disabled={!/^GEM\/\d{4}\/[A-Z]\/\d{4,}$/i.test(n.trim())} onClick={() => onSave({ bidNumber: n.trim().toUpperCase(), title: title.trim() || null })}>
          Add
        </button>
      }
    >
      <div className="modal-body grid2">
        <label className="field">
          Bid number
          <input value={n} onChange={(e) => setN(e.target.value)} placeholder="GEM/2026/B/1234567" autoFocus />
        </label>
        <label className="field">
          What it is for (optional)
          <input value={title} onChange={(e) => setTitle(e.target.value)} />
        </label>
      </div>
    </Modal>
  );
}

const yesNo = (v: boolean | null) => (v == null ? null : v ? 'Yes' : 'No');

/** Everything known about the bid, from GeM's search and its bid document. */
function BidDetails({ b }: { b: Json }) {
  const rows: [string, React.ReactNode][] = [
    ['Item category', b.category],
    ['Quantity', b.quantity],
    ['Ministry', b.ministry],
    ['Department', b.department],
    ['Organisation', b.organisation],
    ['Bid date', b.bid_date ? date(b.bid_date) : null],
    ['Starts', b.start_at ? dateTime(b.start_at) : null],
    ['Closes', b.end_at ? dateTime(b.end_at) : null],
    ['Opens (technical)', b.opening_at ? dateTime(b.opening_at) : null],
    ['Type of bid', b.bid_type],
    ['EMD', b.emd_amount != null ? (Number(b.emd_amount) ? money2(b.emd_amount) : 'Not required') : null],
    ['ePBG', b.epbg_percent != null ? `${b.epbg_percent}%` : null],
    ['Min. average turnover', b.min_turnover != null ? money2(b.min_turnover) : null],
    ['Experience asked', b.experience_years != null ? `${b.experience_years} year(s)` : null],
    ['MSE relaxation', yesNo(b.mse_exempt)],
    ['Startup relaxation', yesNo(b.startup_exempt)],
    ...Object.entries((b.details ?? {}) as Record<string, string>).map(([k, v]): [string, React.ReactNode] => [
      k,
      /^https?:\/\//.test(v) ? (
        <a href={v} target="_blank" rel="noreferrer noopener">
          Open ↗
        </a>
      ) : /@/.test(v) && !/\s/.test(v) ? (
        <a href={`mailto:${v}`}>{v}</a>
      ) : (
        v
      ),
    ]),
  ];
  const shown = rows.filter(([, v]) => v != null && v !== '');
  if (!shown.length) return null;
  return (
    <div>
      <b>Bid details</b>
      <dl className="grid2 small" style={{ margin: '6px 0 0', rowGap: 4 }}>
        {shown.map(([k, v]) => (
          <div key={k} style={{ display: 'flex', gap: 8 }}>
            <dt className="muted" style={{ minWidth: 150, flex: 'none' }}>
              {k}
            </dt>
            <dd style={{ margin: 0 }}>{v}</dd>
          </div>
        ))}
      </dl>
      {(b.documents_required ?? []).length > 0 && (
        <div className="small" style={{ marginTop: 6 }}>
          <span className="muted">Documents asked from sellers: </span>
          {(b.documents_required as string[]).join(', ')}
        </div>
      )}
    </div>
  );
}

const DOC_CLS: Record<string, [string, string]> = { ready: ['good', 'On file'], missing: ['bad', 'Missing'], expired: ['bad', 'Expired'], manual: ['warn', 'Prepare'] };

function BidModal({ id, onClose }: { id: string; onClose: () => void }) {
  const key = ['intake', 'gem', 'check', id];
  const { data, error } = useQuery({ queryKey: key, queryFn: () => get<Json>(`/api/v1/intake/gem/${id}/check`) });
  const { data: users } = useUsers();
  const act = useAct([['intake']]);
  const toast = useToast();
  const nav = useNavigate();
  const [reading, setReading] = useState(false);
  const [notes, setNotes] = useState<string | null>(null);
  const [fetching, setFetching] = useState(false);
  const fetchNow = async () => {
    setFetching(true);
    await act(() => post<Json>(`/api/v1/intake/gem/${id}/fetch`), (r) => `Read from GeM: ${r.files} document(s)`);
    setFetching(false);
  };
  if (error) return null;
  if (!data) return null;
  const b = data.bid;
  const upload = async (file: File) => {
    setReading(true);
    try {
      const parts = await readDocument(file);
      const pages = parts.flatMap((p) => p.pages ?? []);
      if (!pages.join('').trim()) throw new Error('No text in this PDF; download the bid document from GeM (not a scan)');
      const buf = new Uint8Array(await file.arrayBuffer());
      let bin = '';
      for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
      const r = await post<Json>(`/api/v1/intake/gem/${id}/document`, { name: file.name, data: btoa(bin), pages });
      toast(`Read: ${r.read.documentsRequired.length} document(s) asked for${r.read.minTurnover ? `, turnover ₹${Number(r.read.minTurnover).toLocaleString('en-IN')}` : ''}`);
      await act(async () => null);
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setReading(false);
    }
  };
  const pack = async () => {
    try {
      await download(`/api/v1/intake/gem/${id}/pack`, `${b.bid_number.replace(/\//g, '-')}-documents.pdf`);
    } catch (e) {
      toast((e as Error).message, true);
    }
  };
  return (
    <Modal title={b.bid_number} onClose={onClose} wide>
      <div className="modal-body stack">
        <div className="spread" style={{ flexWrap: 'wrap', gap: 8 }}>
          <div>
            <b>{b.title ?? b.category ?? 'Bid'}</b>
            <div className="small muted">
              {[b.organisation, b.department, b.ministry].filter(Boolean).join(' · ')}
              {b.quantity ? ` · quantity ${b.quantity}` : ''}
              {b.bid_type ? ` · ${b.bid_type}` : ''}
            </div>
            <div className="small">
              {b.end_at ? <>Closes {dateTime(b.end_at)} ({left(b.end_at)})</> : 'Closing date not known yet'}
              {b.corrigenda ? <span className="chip warn" style={{ marginLeft: 6 }}>{b.corrigenda} corrigend{b.corrigenda === 1 ? 'um' : 'a'}</span> : null}
            </div>
          </div>
          <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
            <select value={b.status} onChange={(e) => act(() => put(`/api/v1/intake/gem/${id}`, { status: e.target.value }), 'Status saved')} aria-label="Status" style={{ width: 'auto' }}>
              {BID_STATUS.map(([k, l]) => (
                <option key={k} value={k}>
                  {l}
                </option>
              ))}
            </select>
            <select value={b.owner_id ?? ''} onChange={(e) => act(() => put(`/api/v1/intake/gem/${id}`, { ownerId: e.target.value || null }), 'Owner saved')} aria-label="Owner" style={{ width: 'auto' }}>
              <option value="">No owner</option>
              {(users?.items ?? []).map((u) => (
                <option key={u.id} value={u.id}>
                  {u.full_name}
                </option>
              ))}
            </select>
          </div>
        </div>

        <BidDetails b={b} />

        <div className="panel" style={{ padding: 12 }}>
          <div className="spread" style={{ flexWrap: 'wrap', gap: 8 }}>
            <div>
              <b>Bid documents</b>
              <div className="small muted">
                {b.fetch_error
                  ? `GeM could not be read: ${b.fetch_error}`
                  : b.fetched_at
                    ? `Read from GeM ${dateTime(b.fetched_at)}: the bid document and the buyer's files it links to.`
                    : 'Being read from GeM (within a few minutes of the alert).'}
              </div>
            </div>
            <div className="row" style={{ gap: 6 }}>
              <button className="btn sm primary" disabled={fetching} onClick={fetchNow}>
                {fetching ? 'Reading GeM…' : b.fetched_at ? 'Read again from GeM' : 'Read from GeM now'}
              </button>
              <label className="btn sm ghost" style={{ cursor: 'pointer' }} title="If GeM cannot be reached: download the bid PDF yourself and add it here">
                {reading ? 'Reading…' : 'Upload a PDF instead'}
                <input type="file" accept="application/pdf" hidden disabled={reading} onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
              </label>
            </div>
          </div>
          {(data.files ?? []).length > 0 ? (
            <table className="data" style={{ marginTop: 8 }}>
              <tbody>
                {(data.files as Json[]).map((f, i) => (
                  <tr key={i}>
                    <td>{f.label}</td>
                    <td className="small muted">{f.name ?? ''}{f.size ? ` · ${Math.max(1, Math.round(f.size / 1024))} KB` : ''}{f.at ? ` · ${date(f.at)}` : ''}</td>
                    <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                      {f.open ? (
                        <a className="btn sm" href={f.open} target="_blank" rel="noreferrer">
                          Open
                        </a>
                      ) : null}{' '}
                      <a className="btn sm ghost" href={f.url} target="_blank" rel="noreferrer noopener">
                        On GeM ↗
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : data.documentUrl ? (
            <div style={{ marginTop: 8 }}>
              <a className="btn sm" href={data.documentUrl} target="_blank" rel="noreferrer">
                Open the bid document
              </a>
            </div>
          ) : null}
        </div>

        {data.checks.length > 0 && (
          <table className="data" data-export-title={`${b.bid_number} — eligibility`}>
            <thead>
              <tr>
                <th>Check</th>
                <th />
                <th>Detail</th>
              </tr>
            </thead>
            <tbody>
              {data.checks.map((c: Json) => (
                <tr key={c.what}>
                  <td>{c.what}</td>
                  <td>{c.ok === true ? <span className="chip good">OK</span> : c.ok === false ? <span className="chip bad">Short</span> : <span className="chip">—</span>}</td>
                  <td className="small">{c.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <div>
          <div className="spread" style={{ flexWrap: 'wrap', gap: 8 }}>
            <b>
              Documents ({data.ready} on file{data.missing ? `, ${data.missing} missing` : ''})
            </b>
            <div className="row" style={{ gap: 6 }}>
              <Link className="btn sm ghost" to="/organisation">
                Upload documents
              </Link>
              <button className="btn sm primary" disabled={!data.ready} onClick={pack}>
                Download bid pack (PDF)
              </button>
            </div>
          </div>
          <table className="data" data-export-title={`${b.bid_number} — documents`} style={{ marginTop: 6 }}>
            <thead>
              <tr>
                <th>Asked for</th>
                <th>Answered by</th>
                <th />
                <th>Files</th>
              </tr>
            </thead>
            <tbody>
              {data.documents.map((d: Json) => (
                <tr key={`${d.asked}|${d.kinds.join()}`}>
                  <td>{d.asked}</td>
                  <td className="small">{d.answer}</td>
                  <td>
                    <span className={`chip ${DOC_CLS[d.status]?.[0] ?? ''}`}>{DOC_CLS[d.status]?.[1] ?? d.status}</span>
                  </td>
                  <td className="small">
                    {d.files.map((f: Json) => (
                      <div key={f.docId}>
                        <a href={f.url} target="_blank" rel="noreferrer">
                          {f.fileName ?? f.name}
                        </a>
                      </div>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="small muted" style={{ margin: '6px 0 0' }}>
            The pack has a contents page and every document on file in one PDF. Submit on GeM yourself: sign in, open the bid and upload the documents (separately where GeM asks).
          </p>
        </div>

        <label className="field">
          Notes
          <textarea rows={3} value={notes ?? b.notes ?? ''} onChange={(e) => setNotes(e.target.value)} onBlur={() => notes !== null && notes !== (b.notes ?? '') && act(() => put(`/api/v1/intake/gem/${id}`, { notes }), 'Notes saved')} />
        </label>

        <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
          {b.deal_id ? (
            <button className="btn sm" onClick={() => nav(`/o/deal/${b.deal_id}`)}>
              Open the deal
            </button>
          ) : (
            <button className="btn sm" onClick={() => act(() => post<Json>(`/api/v1/intake/gem/${id}/deal`), 'Deal created')}>
              Make it a deal
            </button>
          )}
          <a className="btn sm ghost" href="https://bidplus.gem.gov.in/all-bids" target="_blank" rel="noreferrer noopener" onClick={() => navigator.clipboard?.writeText(b.bid_number)} title="The bid number is copied: paste it into GeM's search">
            Find on GeM ↗ (number copied)
          </a>
        </div>

        {data.history.length > 0 && (
          <details>
            <summary className="small">Mails about this bid ({data.history.length})</summary>
            <ul className="small">
              {data.history.map((h: Json, i: number) => (
                <li key={i}>
                  {dateTime(h.received_at)} — {h.subject}
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </Modal>
  );
}

/* ───────────────────────── bills and invoices ───────────────────────── */

const KIND_LABEL: Record<string, string> = { payment: 'Payment', bill: 'Bill', invoice: 'Our invoice', statement: 'Statement', gem_new_bids: 'GeM: new bids', gem_corrigendum: 'GeM: corrigendum', gem_update: 'GeM' };

function Documents() {
  const [status, setStatus] = useState('new');
  const { data } = useQuery({ queryKey: ['intake', 'items', status], queryFn: () => get<Json[]>(`/api/v1/intake/items?kind=docs${status ? `&status=${status}` : ''}`) });
  const [open, setOpen] = useState<Json | null>(null);
  return (
    <div className="stack">
      <div className="row" role="group">
        {[
          ['new', 'To do'],
          ['done', 'Done'],
          ['ignored', 'Ignored'],
          ['', 'All'],
        ].map(([k, l]) => (
          <button key={k} className={`btn sm${status === k ? ' primary' : ' ghost'}`} onClick={() => setStatus(k!)}>
            {l}
          </button>
        ))}
      </div>
      {data?.length ? (
        <table className="data" data-export-title="Bills and invoices from mail">
          <thead>
            <tr>
              <th>Received</th>
              <th>From</th>
              <th>Subject</th>
              <th>Type</th>
              <th>Files</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {data.map((i) => (
              <tr key={i.id} className="click" onClick={() => setOpen(i)}>
                <td style={{ whiteSpace: 'nowrap' }}>{i.received_at ? dateTime(i.received_at) : '—'}</td>
                <td className="small">
                  {i.from_name ?? i.from_address}
                  <div className="muted">{i.from_name ? i.from_address : ''}</div>
                </td>
                <td>{i.subject}</td>
                <td>
                  {KIND_LABEL[i.kind] ?? i.kind}
                  {i.matched_on && <div className="small muted">names {i.matched_on}</div>}
                </td>
                <td className="small">{(i.attachments as Json[]).map((a) => a.name).join(', ')}</td>
                <td>
                  {i.status === 'done' && (i.link_object === 'bill' || i.link_object === 'invoice') ? (
                    <Link to={`/o/${i.link_object}/${i.link_id}`} onClick={(e) => e.stopPropagation()}>
                      {i.link_object === 'bill' ? 'Bill made' : 'Invoice imported'}
                    </Link>
                  ) : (
                    <span className={`chip ${i.status === 'new' ? 'warn' : ''}`}>{i.status === 'new' ? 'to do' : i.status}</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <Empty title="Nothing here">Mails with an invoice, bill, receipt or statement attached (PDF or picture) appear here once a mailbox is read.</Empty>
      )}
      {open && <ItemModal item={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

function ItemModal({ item, onClose }: { item: Json; onClose: () => void }) {
  const { data } = useQuery({ queryKey: ['intake', 'item', item.id], queryFn: () => get<Json>(`/api/v1/intake/items/${item.id}`) });
  const act = useAct([['intake']]);
  const [fileId, setFileId] = useState<string>(item.attachments?.[0]?.fileId ?? '');
  if (!data) return null;
  const att = (data.attachments as Json[]).find((a) => a.fileId === fileId);
  return (
    <Modal title={item.subject || '(no subject)'} onClose={onClose} wide>
      <div className="modal-body stack">
        <div className="small muted">
          From {item.from_name ? `${item.from_name} <${item.from_address}>` : item.from_address} · {item.received_at ? dateTime(item.received_at) : ''} · to {item.mailbox}
        </div>
        <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
          {(data.attachments as Json[]).map((a) => (
            <button key={a.fileId} className={`btn sm${a.fileId === fileId ? ' primary' : ' ghost'}`} onClick={() => setFileId(a.fileId)}>
              📎 {a.name}
            </button>
          ))}
          {att && (
            <a className="btn sm ghost" href={att.url} target="_blank" rel="noreferrer">
              Open
            </a>
          )}
        </div>
        {data.status === 'new' && data.kind !== 'statement' && (data.attachments as Json[]).length > 0 && <ApproveMail id={item.id} onDone={onClose} />}
        {data.status === 'done' && data.link_object === 'bill' && (
          <p>
            <Link to={`/o/bill/${data.link_id}`}>Open the bill made from this mail</Link>
          </p>
        )}
        {data.kind === 'statement' && <StatementPanel item={data} onDone={onClose} />}
        {data.status === 'new' && (!att || data.kind === 'statement') && (
          <div className="row" style={{ gap: 6 }}>
            <button className="btn primary" onClick={async () => (await act(() => post(`/api/v1/intake/items/${item.id}/status`, { status: 'done' }), 'Marked done')) !== null && onClose()}>
              Done (recorded)
            </button>
            <button className="btn" onClick={async () => (await act(() => post(`/api/v1/intake/items/${item.id}/status`, { status: 'ignored' }), 'Ignored')) !== null && onClose()}>
              Not the business’s — ignore
            </button>
            {data.kind === 'statement' ? (
              <Link className="btn ghost" to="/books#desk">
                Import it on the accounts desk
              </Link>
            ) : (
              data.kind === 'payment' && (
                <Link className="btn ghost" to="/books#desk">
                  Match it on the accounts desk
                </Link>
              )
            )}
          </div>
        )}
        {data.status === 'ignored' && (
          <button className="btn sm" onClick={() => act(() => post(`/api/v1/intake/items/${item.id}/status`, { status: 'new' }), 'Back in to-do')}>
            Back to to-do
          </button>
        )}
        {data.body && (
          <details>
            <summary className="small">The mail</summary>
            <pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit', fontSize: 13 }}>{data.body.slice(0, 5000)}</pre>
          </details>
        )}
      </div>
    </Modal>
  );
}

/** A statement that came by mail: opened with the account's saved password (or one typed here), imported, matched on the desk. */
function StatementPanel({ item, onDone }: { item: Json; onDone: () => void }) {
  const { data: banks } = useQuery({ queryKey: ['books', 'bank-accounts'], queryFn: () => get<Json[]>('/api/v1/books/bank-accounts'), retry: false });
  const act = useAct([['intake'], ['books']]);
  const [f, setF] = useState({ bankAccountId: item.link_object === 'bank_account' ? item.link_id : '', password: '', remember: true });
  const [busy, setBusy] = useState(false);
  const st = item.data?.statement as Json | undefined;
  const list = (banks ?? []).filter((b) => b.kind !== 'cash');
  const read = async () => {
    setBusy(true);
    const r = await act(
      () => post<Json>(`/api/v1/intake/items/${item.id}/statement`, { bankAccountId: f.bankAccountId || null, password: f.password || null, remember: f.remember }),
      (x: Json) => (x.status === 'imported' ? `${x.message}; the accounts desk is matching them` : x.message),
    );
    setBusy(false);
    if (r?.status === 'imported') onDone();
  };
  return (
    <div className="panel stack" style={{ padding: 12 }}>
      <b>Statement</b>
      {st ? (
        <p className="small" style={{ margin: 0, color: st.status === 'imported' ? undefined : 'var(--warn)' }}>
          {st.message}
          {st.at ? <span className="muted"> · {dateTime(st.at)}</span> : null}
        </p>
      ) : (
        <p className="small muted" style={{ margin: 0 }}>
          Read automatically within a few minutes when the account's statement password is saved (Books → Banking → Details).
        </p>
      )}
      {item.status !== 'done' && (
        <>
          <div className="grid2">
            <label className="field">
              Account or card
              <select value={f.bankAccountId} onChange={(e) => setF({ ...f, bankAccountId: e.target.value })}>
                <option value="">Find it from the mail</option>
                {list.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                    {b.account_last4 ? ` ••${b.account_last4}` : ''}
                    {b.has_statement_password ? ' 🔑' : ''}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              PDF password (if not saved)
              <input type="password" autoComplete="new-password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} />
              {f.password && f.bankAccountId && (
                <label className="row small" style={{ gap: 4 }}>
                  <input type="checkbox" checked={f.remember} onChange={(e) => setF({ ...f, remember: e.target.checked })} />
                  Save it on this account for next time
                </label>
              )}
            </label>
          </div>
          <div>
            <button className="btn primary" disabled={busy} onClick={read}>
              {busy ? 'Reading…' : 'Read and import the statement'}
            </button>
          </div>
        </>
      )}
      {item.status === 'done' && item.link_object === 'bank_account' && (
        <Link to="/books#desk" className="small">
          See it on the accounts desk
        </Link>
      )}
    </div>
  );
}

/** Our own invoice to a customer that came by mail (e.g. from Zoho): imported as a sales invoice under its own number. */
function OurInvoice({ id, p, onDone }: { id: string; p: Json; onDone: () => void }) {
  const qc = useQueryClient();
  const act = useAct([['intake'], ['books']]);
  const nav = useNavigate();
  const [busy, setBusy] = useState(false);
  const choose = async (item: Json, change: Json) => {
    await act(() => patch(`/api/v1/books/imports/items/${item.id}`, { choices: { ...(item.plan?.choices ?? {}), ...change } }));
    qc.invalidateQueries({ queryKey: ['intake', 'proposal', id] });
  };
  const items = (p.items ?? []) as Json[];
  if (!items.length) return <p className="small muted">This looks like your own invoice, but nothing could be read from its PDF.</p>;
  const pending = items.filter((x) => x.status === 'pending' || x.status === 'failed');
  return (
    <div className="panel stack" style={{ padding: 12 }}>
      <div>
        <b>Your own invoice to a customer</b>
        <div className="small muted">Not a bill: it is brought in as a sales invoice under its original number, with the customer, deal, project and recurring invoice it belongs to, and posted to the books.</div>
      </div>
      {items.map((x) => {
        const d = x.data ?? {};
        const pl = x.plan ?? {};
        const acc = pl.customer?.id ?? '';
        return (
          <div key={x.id} className="stack" style={{ gap: 8, borderTop: '1px solid var(--line)', paddingTop: 8 }}>
            <div className="small">
              <b>{d.number ?? 'No number'}</b> of {d.date ? date(d.date) : '—'} · {d.subject ?? d.lines?.[0]?.description ?? ''} · total <b>{money2(pl.invoice?.total ?? d.total ?? 0)}</b>
              {d.taxInclusive ? ' (incl. GST)' : ''} · {d.paid?.status === 'paid' ? 'paid' : d.paid?.status ?? ''}
              {x.status === 'approved' && <span className="chip good" style={{ marginLeft: 6 }}>Imported</span>}
              {pl.invoice?.duplicate && <span className="chip warn" style={{ marginLeft: 6 }}>Already in Synapse</span>}
            </div>
            <div className="grid2">
              <label className="field">
                Customer
                <select disabled={x.status === 'approved'} value={acc} onChange={(e) => choose(x, { customerId: e.target.value || null })}>
                  <option value="">{pl.customer?.new ? `New: ${pl.customer.name ?? '—'}` : 'Add as new'}</option>
                  {(p.choices?.accounts ?? []).map((a: Json) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>
                {pl.contact?.name && <span className="small muted">Contact: {pl.contact.name}</span>}
              </label>
              <label className="field">
                Deal
                <select disabled={x.status === 'approved'} value={pl.deal?.id ?? ''} onChange={(e) => choose(x, { dealId: e.target.value || null })}>
                  <option value="">None</option>
                  {(p.choices?.deals ?? [])
                    .filter((dl: Json) => !acc || dl.account_id === acc || dl.id === pl.deal?.id)
                    .map((dl: Json) => (
                      <option key={dl.id} value={dl.id}>
                        {dl.name}
                      </option>
                    ))}
                </select>
                {pl.recurring?.name && <span className="small muted">One of the recurring invoice “{pl.recurring.name}”</span>}
              </label>
              <label className="field">
                Project
                <select disabled={x.status === 'approved'} value={pl.project?.id ?? ''} onChange={(e) => choose(x, { projectId: e.target.value || null })}>
                  <option value="">None</option>
                  {(p.choices?.projects ?? [])
                    .filter((pr: Json) => !acc || pr.account_id === acc || pr.id === pl.project?.id)
                    .map((pr: Json) => (
                      <option key={pr.id} value={pr.id}>
                        {pr.name}
                      </option>
                    ))}
                </select>
              </label>
              <label className="field">
                Payment
                <select disabled={x.status === 'approved'} value={pl.payment?.mode ?? 'later'} onChange={(e) => choose(x, { payment: e.target.value })}>
                  {pl.payment?.bank && <option value="bank">Matched to the bank line of {date(pl.payment.bank.date)} ({money2(pl.payment.bank.amount)})</option>}
                  <option value="record">Paid: record the receipt</option>
                  <option value="later">Not paid yet</option>
                </select>
              </label>
            </div>
            {[...(x.warnings ?? []), x.error].filter(Boolean).map((w: string, i: number) => (
              <div key={i} className="small" style={{ color: 'var(--warn)' }}>
                {w}
              </div>
            ))}
          </div>
        );
      })}
      <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
        <button
          className="btn primary"
          disabled={busy || !pending.length}
          onClick={async () => {
            setBusy(true);
            const r = await act(() => post<Json>(`/api/v1/intake/items/${id}/import-invoices`), (x: Json) => (x.approved ? `${x.approved} invoice(s) imported` : 'Not imported: see the reasons'));
            setBusy(false);
            qc.invalidateQueries({ queryKey: ['intake', 'proposal', id] });
            if (r?.invoiceId && r.results.every((y: Json) => y.ok)) {
              onDone();
              nav(`/o/invoice/${r.invoiceId}`);
            }
          }}
        >
          {busy ? 'Importing…' : 'Import as our invoice'}
        </button>
        <button className="btn ghost" onClick={async () => (await act(() => post(`/api/v1/intake/items/${id}/status`, { status: 'ignored' }), 'Ignored')) !== null && onDone()}>
          Ignore
        </button>
      </div>
    </div>
  );
}

const CURRENCIES = ['INR', 'USD', 'EUR', 'GBP', 'SGD', 'AUD', 'CAD', 'AED', 'JPY', 'CHF'];
const num = (v: string) => (v.trim() === '' ? null : Number(v));

/**
 * Review and approve a mailed bill or receipt: everything read from its files (invoice and receipt
 * together), editable; on approval the bill is posted (foreign currency at the day's rate, reverse
 * charge for a supplier abroad) and the payment recorded through the card or bank that paid.
 */
function ApproveMail({ id, onDone }: { id: string; onDone: () => void }) {
  const { data: p, error, isLoading } = useQuery({ queryKey: ['intake', 'proposal', id], queryFn: () => post<Json>(`/api/v1/intake/items/${id}/proposal`), staleTime: Infinity, retry: false });
  const act = useAct([['intake'], ['books']]);
  const nav = useNavigate();
  const [f, setF] = useState<Json | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!p || f) return;
    setF({
      vendorName: p.supplier?.name ?? '',
      vendorId: p.supplier?.vendorId ?? null,
      gstin: p.supplier?.gstin ?? '',
      number: p.number ?? '',
      date: p.date ?? '',
      currency: p.currency ?? 'INR',
      exchangeRate: p.exchangeRate != null ? String(p.exchangeRate) : p.currency === 'INR' ? '1' : '',
      importOfServices: !!p.supplier?.foreign,
      reverseCharge: !!p.reverseCharge,
      itcEligible: true,
      accountId: p.suggest?.accountId ?? '',
      projectId: '',
      lines: (p.lines?.length ? p.lines : [{ description: '', hsnSac: '', quantity: 1, unitPrice: 0, taxRate: 18 }]).map((l: Json) => ({ ...l, quantity: String(l.quantity), unitPrice: String(l.unitPrice), taxRate: String(l.taxRate), hsnSac: l.hsnSac ?? '' })),
      paid: !!p.paid,
      paidThroughId: p.paid?.through?.glId ?? '',
      payDate: p.paid?.on ?? p.date ?? '',
      payAmount: p.paid?.amount != null ? String(p.paid.amount) : '',
      inrAmount: '',
      reference: p.paid?.reference ?? '',
    });
  }, [p, f]);
  if (isLoading) return <p className="small muted">Reading the files on this mail…</p>;
  if (error) return <p className="small" style={{ color: 'var(--bad)' }}>{(error as Error).message}</p>;
  if (p?.ours) return <OurInvoice id={id} p={p} onDone={onDone} />;
  if (!p || !f) return null;
  const set = (x: Json) => setF({ ...f, ...x });
  const setLine = (i: number, x: Json) => set({ lines: f.lines.map((l: Json, j: number) => (j === i ? { ...l, ...x } : l)) });
  const foreignCur = f.currency !== 'INR';
  const rate = foreignCur ? Number(f.exchangeRate) || 0 : 1;
  const sub = f.lines.reduce((a: number, l: Json) => a + (Number(l.quantity) || 0) * (Number(l.unitPrice) || 0), 0);
  const gst = f.lines.reduce((a: number, l: Json) => a + ((Number(l.quantity) || 0) * (Number(l.unitPrice) || 0) * (Number(l.taxRate) || 0)) / 100, 0);
  const cur = (n: number) => (foreignCur ? `${f.currency} ${n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : money2(n));
  const payFrom = (p.choices?.payFrom ?? []) as Json[];
  const card = payFrom.find((b) => b.gl_account_id === f.paidThroughId);
  const ok = f.vendorName.trim().length >= 2 && /^\d{4}-\d{2}-\d{2}$/.test(f.date) && (!foreignCur || rate > 0) && f.lines.every((l: Json) => l.description.trim() && Number(l.quantity) > 0) && (!f.paid || (f.paidThroughId && Number(f.payAmount) > 0 && f.payDate));
  const approve = async (postIt: boolean) => {
    setBusy(true);
    const r = await act(
      () =>
        post<Json>(`/api/v1/intake/items/${id}/approve`, {
          vendorId: f.vendorId,
          vendorName: f.vendorName.trim(),
          gstin: f.gstin?.trim() ? f.gstin.trim().toUpperCase() : null,
          number: f.number.trim() || null,
          date: f.date,
          currency: f.currency,
          exchangeRate: rate || 1,
          reverseCharge: f.reverseCharge,
          importOfServices: f.importOfServices,
          itcEligible: f.itcEligible,
          accountId: f.accountId || null,
          projectId: f.projectId || null,
          lines: f.lines.map((l: Json) => ({ description: l.description.trim(), hsnSac: l.hsnSac?.trim() || null, quantity: Number(l.quantity), unitPrice: Number(l.unitPrice) || 0, taxRate: Number(l.taxRate) || 0 })),
          post: postIt,
          payment:
            postIt && f.paid
              ? { paidThroughId: f.paidThroughId, date: f.payDate, amount: Number(f.payAmount), inrAmount: num(f.inrAmount), exchangeRate: foreignCur ? rate : null, reference: f.reference.trim() || null }
              : null,
        }),
      (x: Json) => (postIt ? `Bill posted${x.paymentId ? ' and payment recorded' : ''}${x.balanceLeft ? ` — ${cur(x.balanceLeft)} still open on the bill` : ''}` : 'Draft bill made; check and post it'),
    );
    setBusy(false);
    if (r) {
      onDone();
      nav(`/o/bill/${r.billId}`);
    }
  };
  return (
    <div className="panel stack" style={{ padding: 12 }}>
      <div className="spread" style={{ flexWrap: 'wrap', gap: 6 }}>
        <b>Review and approve</b>
        <span className="small muted">
          {p.files
            .filter((x: Json) => x.role)
            .map((x: Json) => `${x.role === 'invoice' ? 'Invoice' : 'Receipt'}: ${x.name}`)
            .join(' · ') || 'Nothing could be read from the files (a scan?): fill it in below.'}
          {p.confidence ? ` · ${Math.round(p.confidence * 100)}% sure` : ''}
        </span>
      </div>
      <div className="grid2">
        <label className="field">
          Supplier
          <input value={f.vendorName} onChange={(e) => set({ vendorName: e.target.value, vendorId: null })} />
          <span className="small muted">
            {f.vendorId ? 'Already a vendor' : 'Will be added as a vendor'}
            {p.supplier?.foreign ? ` · abroad${p.supplier.country ? ` (${p.supplier.country})` : ''}` : ''}
            {p.supplier?.taxId ? ` · tax id ${p.supplier.taxId}` : ''}
          </span>
        </label>
        <label className="field">
          Supplier GSTIN {p.supplier?.foreign && <span className="muted small">(none for a supplier abroad)</span>}
          <input value={f.gstin} onChange={(e) => set({ gstin: e.target.value })} disabled={f.importOfServices} />
        </label>
        <label className="field">
          Invoice no.
          <input value={f.number} onChange={(e) => set({ number: e.target.value })} />
        </label>
        <label className="field">
          Invoice date
          <input type="date" value={f.date} onChange={(e) => set({ date: e.target.value })} />
        </label>
        <label className="field">
          Currency
          <select value={f.currency} onChange={(e) => set({ currency: e.target.value, exchangeRate: e.target.value === 'INR' ? '1' : f.exchangeRate })}>
            {[...new Set([f.currency, ...CURRENCIES])].map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </label>
        {foreignCur ? (
          <label className="field">
            ₹ per {f.currency}
            <input inputMode="decimal" value={f.exchangeRate} onChange={(e) => set({ exchangeRate: e.target.value })} />
            <span className="small muted">{p.exchangeRate && p.currency === f.currency ? `ECB reference rate of ${date(p.rateDate || f.date)}; change it to the RBI or your bank's rate if you use that` : 'Enter the rate'}</span>
          </label>
        ) : (
          <span />
        )}
        <label className="field">
          Expense account {p.suggest && f.accountId === p.suggest.accountId && <span className="small muted">(suggested {p.suggest.why})</span>}
          <select value={f.accountId} onChange={(e) => set({ accountId: e.target.value })}>
            <option value="">Purchases (default)</option>
            {(p.choices?.accounts ?? [])
              .filter((a: Json) => a.type === 'expense' || a.subtype === 'fixed_asset')
              .map((a: Json) => (
                <option key={a.id} value={a.id}>
                  {a.code ? `${a.code} · ` : ''}
                  {a.name}
                </option>
              ))}
          </select>
        </label>
        <label className="field">
          Project
          <select value={f.projectId} onChange={(e) => set({ projectId: e.target.value })}>
            <option value="">None</option>
            {(p.choices?.projects ?? []).map((x: Json) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="row small" style={{ gap: 16, flexWrap: 'wrap' }}>
        <label className="row" style={{ gap: 4 }}>
          <input type="checkbox" checked={f.importOfServices} onChange={(e) => set({ importOfServices: e.target.checked, reverseCharge: e.target.checked ? true : f.reverseCharge, gstin: e.target.checked ? '' : f.gstin })} />
          Import of services (supplier abroad)
        </label>
        <label className="row" style={{ gap: 4 }}>
          <input type="checkbox" checked={f.reverseCharge} onChange={(e) => set({ reverseCharge: e.target.checked })} />
          Reverse charge: we pay the GST
        </label>
        <label className="row" style={{ gap: 4 }}>
          <input type="checkbox" checked={f.itcEligible} onChange={(e) => set({ itcEligible: e.target.checked })} />
          Input tax credit can be claimed
        </label>
      </div>
      <table className="data">
        <thead>
          <tr>
            <th>Item</th>
            <th>HSN/SAC</th>
            <th className="num">Qty</th>
            <th className="num">Price ({f.currency})</th>
            <th className="num">GST %</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {f.lines.map((l: Json, i: number) => (
            <tr key={i}>
              <td>
                <input value={l.description} onChange={(e) => setLine(i, { description: e.target.value })} />
              </td>
              <td style={{ width: 100 }}>
                <input value={l.hsnSac} onChange={(e) => setLine(i, { hsnSac: e.target.value })} />
              </td>
              <td style={{ width: 70 }}>
                <input inputMode="decimal" value={l.quantity} onChange={(e) => setLine(i, { quantity: e.target.value })} />
              </td>
              <td style={{ width: 120 }}>
                <input inputMode="decimal" value={l.unitPrice} onChange={(e) => setLine(i, { unitPrice: e.target.value })} />
              </td>
              <td style={{ width: 70 }}>
                <input inputMode="decimal" value={l.taxRate} onChange={(e) => setLine(i, { taxRate: e.target.value })} />
              </td>
              <td style={{ width: 30 }}>
                {f.lines.length > 1 && (
                  <button className="btn sm ghost" aria-label="Remove line" onClick={() => set({ lines: f.lines.filter((_: Json, j: number) => j !== i) })}>
                    ×
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="spread small" style={{ flexWrap: 'wrap', gap: 6 }}>
        <button className="btn sm ghost" onClick={() => set({ lines: [...f.lines, { description: '', hsnSac: '', quantity: '1', unitPrice: '0', taxRate: f.reverseCharge ? '18' : '18' }] })}>
          + Line
        </button>
        <span>
          Taxable {cur(sub)}
          {foreignCur && rate ? ` = ${money2(sub * rate)}` : ''} · GST {cur(gst)}
          {foreignCur && rate ? ` = ${money2(gst * rate)}` : ''}
          {f.reverseCharge ? ' (reverse charge: paid by us, claimed back as ITC)' : ''} · <b>Payable to supplier {cur(f.reverseCharge ? sub : sub + gst)}</b>
        </span>
      </div>

      <div className="panel" style={{ padding: 10 }}>
        <label className="row" style={{ gap: 6 }}>
          <input type="checkbox" checked={f.paid} onChange={(e) => set({ paid: e.target.checked })} />
          <b>Already paid</b>
          {p.paid?.card && (
            <span className="small muted">
              — {p.paid.card.network ?? 'card'} ••{p.paid.card.last4} on the receipt{p.paid.through ? `: ${p.paid.through.name}${p.paid.through.holder === 'personal' ? ` (personal card of ${p.paid.through.person})` : ''}` : ' — no card with these digits yet: add it under Books → Banking'}
            </span>
          )}
        </label>
        {f.paid && (
          <div className="grid2" style={{ marginTop: 8 }}>
            <label className="field">
              Paid through
              <select value={f.paidThroughId} onChange={(e) => set({ paidThroughId: e.target.value })}>
                <option value="">Choose the card or bank…</option>
                {payFrom.map((b) => (
                  <option key={b.gl_account_id} value={b.gl_account_id}>
                    {b.name}
                    {b.account_last4 ? ` ••${b.account_last4}` : ''}
                    {b.kind === 'credit_card' ? (b.holder === 'personal' ? ` (personal${b.person_name ? `: ${b.person_name}` : ''})` : ' (company card)') : ''}
                  </option>
                ))}
              </select>
              {card?.holder === 'personal' && <span className="small muted">Owed on the partner's card until you settle it to them.</span>}
            </label>
            <label className="field">
              Paid on
              <input type="date" value={f.payDate} onChange={(e) => set({ payDate: e.target.value })} />
            </label>
            <label className="field">
              Amount paid ({f.currency})
              <input inputMode="decimal" value={f.payAmount} onChange={(e) => set({ payAmount: e.target.value })} />
              {p.paid?.appliedBalance ? <span className="small muted">{cur(p.paid.appliedBalance)} came from your balance with the supplier: it stays open on the bill until you settle it.</span> : null}
            </label>
            {foreignCur ? (
              <label className="field">
                Rupees charged (from the card / bank statement)
                <input inputMode="decimal" value={f.inrAmount} onChange={(e) => set({ inrAmount: e.target.value })} placeholder={rate && Number(f.payAmount) ? `about ${money2(Number(f.payAmount) * rate)}` : ''} />
                <span className="small muted">Gives the exact rate, so the statement line matches; the difference from the bill's rate is booked as exchange gain or loss.</span>
              </label>
            ) : (
              <span />
            )}
            <label className="field">
              Reference
              <input value={f.reference} onChange={(e) => set({ reference: e.target.value })} />
            </label>
          </div>
        )}
      </div>

      <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
        <button className="btn primary" disabled={!ok || busy} onClick={() => approve(true)}>
          {busy ? 'Saving…' : f.paid ? 'Approve: post the bill and record the payment' : 'Approve: post the bill'}
        </button>
        <button className="btn" disabled={!ok || busy} onClick={() => approve(false)}>
          Make a draft bill only
        </button>
        <button className="btn ghost" onClick={async () => (await act(() => post(`/api/v1/intake/items/${id}/status`, { status: 'ignored' }), 'Ignored')) !== null && onDone()}>
          Not the business's — ignore
        </button>
      </div>
    </div>
  );
}

/* ───────────────────────── mailboxes ───────────────────────── */

function Mailboxes() {
  const { data } = useQuery({ queryKey: ['intake', 'mailboxes'], queryFn: () => get<Json>('/api/v1/intake/mailboxes') });
  const act = useAct([['intake']]);
  const [edit, setEdit] = useState<Json | null>(null);
  const [syncing, setSyncing] = useState<string | null>(null);
  if (!data) return <Spinner />;
  const sync = async (id: string) => {
    setSyncing(id);
    await act(
      () => post<Json>(`/api/v1/intake/mailboxes/${id}/sync`),
      (r: Json) => `Read ${r.seen} new mail(s): ${r.taken} taken in${r.newBids ? `, ${r.newBids} new GeM bid(s)` : ''}`,
    );
    setSyncing(null);
  };
  return (
    <div className="stack">
      <div className="row" style={{ gap: 6 }}>
        <button className="btn primary" onClick={() => setEdit({ preset: 'titan' })}>
          + Add a mailbox
        </button>
        <span className="small muted">Read every 15 minutes. Read-only: nothing is marked read, moved or deleted in your mailbox.</span>
      </div>
      {data.mailboxes.length ? (
        <table className="data" data-export-title="Mailboxes">
          <thead>
            <tr>
              <th>Mailbox</th>
              <th>Server</th>
              <th>Reads</th>
              <th>Last read</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {(data.mailboxes as Json[]).map((m) => (
              <tr key={m.id}>
                <td>
                  {m.label}
                  <div className="small muted">{m.email}</div>
                </td>
                <td className="small">{m.provider === 'imap' ? `${m.host}:${m.port}` : m.provider === 'google' ? 'Google (connected)' : 'Microsoft (connected)'}</td>
                <td className="small">
                  {[m.read_gem && 'GeM', m.read_bills && 'bills, invoices & payments'].filter(Boolean).join(', ')}
                  {m.business_only && <div className="muted">personal: only mail naming the business</div>}
                </td>
                <td className="small">
                  {m.last_sync_at ? dateTime(m.last_sync_at) : 'Not yet'}
                  {m.last_count != null && <div className="muted">{m.last_count} taken in</div>}
                </td>
                <td>
                  <span className={`chip ${m.status === 'active' ? 'good' : m.status === 'error' ? 'bad' : ''}`}>{m.status}</span>
                  {m.last_error && <div className="small" style={{ color: 'var(--bad)', maxWidth: 320 }}>{m.last_error}</div>}
                </td>
                <td className="num" style={{ whiteSpace: 'nowrap' }}>
                  <button className="btn sm" disabled={syncing === m.id} onClick={() => sync(m.id)}>
                    {syncing === m.id ? 'Reading…' : 'Read now'}
                  </button>
                  <button className="btn sm ghost" onClick={() => setEdit(m)}>
                    Edit
                  </button>
                  <button className="btn sm ghost" onClick={() => window.confirm(`Stop reading ${m.email}? What was taken in stays.`) && act(() => del(`/api/v1/intake/mailboxes/${m.id}`), 'Removed')}>
                    ✕
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <Empty title="No mailbox yet">
          Add the mailbox that receives GeM alerts and supplier bills — e.g. harsha.rani@hrpai.in on GoDaddy (Titan): server imap.secureserver.net, port 993, the mailbox password.
        </Empty>
      )}
      {edit && <MailboxModal m={edit} presets={data.presets} connections={data.connections} onClose={() => setEdit(null)} onSaved={async (id) => (setEdit(null), id && (await sync(id)))} />}
    </div>
  );
}

function MailboxModal({ m, presets, connections, onClose, onSaved }: { m: Json; presets: Record<string, Json>; connections: Json[]; onClose: () => void; onSaved: (id: string | null) => void }) {
  const act = useAct([['intake']]);
  const [preset, setPreset] = useState<string>(m.id ? (m.provider !== 'imap' ? m.provider : Object.entries(presets).find(([, p]) => p.host === m.host)?.[0] ?? 'other') : m.preset ?? 'titan');
  const [f, setF] = useState({
    label: m.label ?? '', email: m.email ?? '', host: m.host ?? presets.titan?.host ?? '', port: String(m.port ?? 993), username: m.username ?? '', password: '', folder: m.folder ?? 'INBOX',
    readGem: m.read_gem ?? true, readBills: m.read_bills ?? true, businessOnly: m.business_only ?? false, firstDays: String(m.first_days ?? 7), integrationId: m.integration_id ?? '',
  });
  const provider = preset === 'google' || preset === 'microsoft' ? preset : 'imap';
  const pickPreset = (p: string) => {
    setPreset(p);
    if (presets[p]) setF({ ...f, host: presets[p].host, port: String(presets[p].port) });
  };
  const save = async () => {
    const body = {
      label: f.label.trim() || f.email.trim(), email: f.email.trim(), provider, host: provider === 'imap' ? f.host.trim() : null, port: provider === 'imap' ? Number(f.port) : null, tls: true,
      username: f.username.trim() || null, password: f.password || null, integrationId: provider === 'imap' ? null : f.integrationId || null, folder: f.folder.trim() || 'INBOX',
      readGem: f.readGem, readBills: f.readBills, businessOnly: f.businessOnly, firstDays: Number(f.firstDays) || 7,
    };
    const r = await act(() => (m.id ? put<{ id: string }>(`/api/v1/intake/mailboxes/${m.id}`, body) : post<{ id: string }>('/api/v1/intake/mailboxes', body)), 'Mailbox saved');
    if (r) onSaved(r.id);
  };
  const conns = connections.filter((c) => c.provider === provider);
  return (
    <Modal
      title={m.id ? m.label : 'Add a mailbox'}
      onClose={onClose}
      wide
      footer={
        <button className="btn primary" disabled={!/^\S+@\S+\.\S+$/.test(f.email.trim()) || (provider === 'imap' ? !f.host || (!m.id && !f.password) : !f.integrationId)} onClick={save}>
          Save and read now
        </button>
      }
    >
      <div className="modal-body grid2">
        <label className="field wide">
          Mail service
          <select value={preset} onChange={(e) => pickPreset(e.target.value)}>
            <option value="titan">GoDaddy Professional Email (Titan)</option>
            <option value="titan_direct">Titan Mail (not from GoDaddy)</option>
            <option value="gmail">Gmail / Google Workspace (app password)</option>
            <option value="outlook_personal">Outlook.com / Hotmail (app password)</option>
            <option value="yahoo">Yahoo Mail (app password)</option>
            <option value="zoho">Zoho Mail</option>
            <option value="google">Google account connected in Settings</option>
            <option value="microsoft">Microsoft 365 account connected in Settings</option>
            <option value="other">Other (IMAP)</option>
          </select>
          {presets[preset]?.note && <span className="small muted">{presets[preset].note}</span>}
        </label>
        <label className="field">
          Email address
          <input value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} placeholder="harsha.rani@hrpai.in" autoFocus />
        </label>
        <label className="field">
          Name for it
          <input value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} placeholder="GeM and bills mailbox" />
        </label>
        {provider === 'imap' ? (
          <>
            <label className="field">
              IMAP server
              <input value={f.host} onChange={(e) => setF({ ...f, host: e.target.value })} />
            </label>
            <label className="field">
              Port (TLS)
              <input inputMode="numeric" value={f.port} onChange={(e) => setF({ ...f, port: e.target.value })} />
            </label>
            <label className="field">
              User name (if not the address)
              <input value={f.username} onChange={(e) => setF({ ...f, username: e.target.value })} />
            </label>
            <label className="field">
              Password{m.has_password ? ' (leave empty to keep)' : ''}
              <input type="password" autoComplete="new-password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} />
            </label>
          </>
        ) : (
          <label className="field wide">
            Connected account
            <select value={f.integrationId} onChange={(e) => setF({ ...f, integrationId: e.target.value })}>
              <option value="">Choose…</option>
              {conns.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.account_ref} {c.full_name ? `(${c.full_name})` : ''}
                </option>
              ))}
            </select>
            {!conns.length && (
              <span className="small muted">
                None connected: connect it in <Link to="/settings#integrations">Settings → Integrations</Link> first.
              </span>
            )}
          </label>
        )}
        <label className="field">
          Folder
          <input value={f.folder} onChange={(e) => setF({ ...f, folder: e.target.value })} />
        </label>
        <label className="field">
          First time, read back (days)
          <input inputMode="numeric" value={f.firstDays} onChange={(e) => setF({ ...f, firstDays: e.target.value })} />
        </label>
        <label className="row small" style={{ gap: 6, alignItems: 'center' }}>
          <input type="checkbox" checked={f.readGem} onChange={(e) => setF({ ...f, readGem: e.target.checked })} /> GeM alerts (bids, corrigenda, results)
        </label>
        <label className="row small" style={{ gap: 6, alignItems: 'center' }}>
          <input type="checkbox" checked={f.readBills} onChange={(e) => setF({ ...f, readBills: e.target.checked })} /> Bills, invoices and statements with a PDF or picture
        </label>
        <label className="row small wide" style={{ gap: 6, alignItems: 'flex-start' }}>
          <input type="checkbox" checked={f.businessOnly} onChange={(e) => setF({ ...f, businessOnly: e.target.checked })} />
          <span>
            <b>Personal mailbox</b> — take in only bills, invoices and payments that name the business: its GSTIN or PAN, its name, or a partner’s name (looked for in the mail, the file names and inside the PDFs). Everything else in it is never stored.
          </span>
        </label>
        <p className="small muted wide" style={{ margin: 0 }}>
          The password is stored encrypted and used only to read this mailbox. Only GeM mail and mail with an invoice attached is kept; personal mail is never stored.
        </p>
      </div>
    </Modal>
  );
}
