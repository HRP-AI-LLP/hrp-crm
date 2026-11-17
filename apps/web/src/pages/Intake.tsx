/**
 * Mail intake: GeM bids (from alert mails, with the eligibility check and the bid pack), bills and
 * invoices that arrived by mail (read and made into draft bills), and the mailboxes that are read.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { Link, NavLink, useNavigate, useParams } from 'react-router-dom';
import { Empty, Modal, Spinner, useToast } from '../components/ui';
import { del, download, get, post, put } from '../lib/api';
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
      </div>
      {rows.length ? (
        <table className="data" data-export-title="GeM bids">
          <thead>
            <tr>
              <th>Bid</th>
              <th>What</th>
              <th>Buyer</th>
              <th>Closes</th>
              <th>Status</th>
              <th className="num">Corrigenda</th>
              <th>Owner</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((b) => (
              <tr key={b.id} className="click" onClick={() => setOpen(b.id)}>
                <td style={{ whiteSpace: 'nowrap' }}>{b.bid_number}</td>
                <td>{b.title ?? b.category ?? <span className="muted">Upload the bid document to read it</span>}</td>
                <td className="small">{[b.organisation, b.department].filter(Boolean).join(' · ') || '—'}</td>
                <td style={{ whiteSpace: 'nowrap' }}>
                  {b.end_at ? dateTime(b.end_at) : '—'}
                  <div className="small muted">{left(b.end_at)}</div>
                </td>
                <td>{statusChip(b.status)}</td>
                <td className="num">{b.corrigenda ? <span className="chip warn">{b.corrigenda}</span> : '—'}</td>
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

        <div className="panel" style={{ padding: 12 }}>
          <div className="spread" style={{ flexWrap: 'wrap', gap: 8 }}>
            <div>
              <b>Bid document</b>
              <div className="small muted">
                {data.documentUrl ? 'Read: eligibility and the documents it asks for are below.' : 'Download the bid document (PDF) from GeM and add it here: its eligibility and document list are read for you.'}
              </div>
            </div>
            <div className="row" style={{ gap: 6 }}>
              {data.documentUrl && (
                <a className="btn sm" href={data.documentUrl} target="_blank" rel="noreferrer">
                  Open
                </a>
              )}
              <label className="btn sm primary" style={{ cursor: 'pointer' }}>
                {reading ? 'Reading…' : data.documentUrl ? 'Replace' : 'Add bid document'}
                <input type="file" accept="application/pdf" hidden disabled={reading} onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
              </label>
            </div>
          </div>
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
                  {i.status === 'done' && i.link_object === 'bill' ? (
                    <Link to={`/o/bill/${i.link_id}`} onClick={(e) => e.stopPropagation()}>
                      Bill made
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
  const toast = useToast();
  const nav = useNavigate();
  const [fileId, setFileId] = useState<string>(item.attachments?.[0]?.fileId ?? '');
  const [busy, setBusy] = useState(false);
  const [f, setF] = useState({ vendorName: '', number: '', date: '', taxable: '', taxRate: '' });
  const read = data?.data?.reads?.[fileId] as Json | undefined;
  useEffect(() => {
    if (!read?.data) return;
    setF({ vendorName: read.party?.name ?? item.from_name ?? '', number: read.data.number ?? '', date: read.data.date ?? '', taxable: read.data.taxable != null ? String(read.data.taxable) : '', taxRate: '' });
  }, [read, item.from_name]);
  if (!data) return null;
  const att = (data.attachments as Json[]).find((a) => a.fileId === fileId);
  const readIt = async () => {
    if (!att) return;
    setBusy(true);
    try {
      const res = await fetch(att.url);
      const blob = await res.blob();
      const parts = await readDocument(new File([blob], att.name, { type: att.contentType }));
      const pages = parts.flatMap((p) => p.pages ?? []);
      await act(() => post(`/api/v1/intake/items/${item.id}/read`, { fileId, pages }), 'Read');
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  };
  const d = read?.data;
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
        {att?.contentType === 'application/pdf' && !read && (
          <button className="btn primary" disabled={busy} onClick={readIt}>
            {busy ? 'Reading…' : 'Read this invoice'}
          </button>
        )}
        {read?.scanned && <p className="small muted">{read.warnings?.[0]}</p>}
        {(d || att?.contentType?.startsWith('image/')) && data.status !== 'done' && (
          <>
            {d && (
              <div className="small">
                Read: {d.number ? `invoice ${d.number}` : 'no number'} {d.date ? `of ${date(d.date)}` : ''} · taxable {d.taxable != null ? money2(d.taxable) : '—'} · GST {money2((d.cgst ?? 0) + (d.sgst ?? 0) + (d.igst ?? 0))} · total {d.total != null ? money2(d.total) : '—'}
                {read?.party?.gstin && ` · supplier GSTIN ${read.party.gstin}`}
                {read?.ours === false && <span className="chip warn" style={{ marginLeft: 6 }}>your GSTIN is not on it</span>}
                {read?.confidence != null && <span className="muted"> · {Math.round(read.confidence * 100)}% sure</span>}
              </div>
            )}
            <div className="grid2">
              <label className="field">
                Supplier
                <input value={f.vendorName} onChange={(e) => setF({ ...f, vendorName: e.target.value })} placeholder="Found by GSTIN when on file" />
              </label>
              <label className="field">
                Supplier's invoice no.
                <input value={f.number} onChange={(e) => setF({ ...f, number: e.target.value })} />
              </label>
              <label className="field">
                Invoice date
                <input type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} />
              </label>
              <label className="field">
                Taxable value (₹, if not read line by line)
                <input inputMode="decimal" value={f.taxable} onChange={(e) => setF({ ...f, taxable: e.target.value })} />
              </label>
            </div>
            <div className="row" style={{ gap: 6 }}>
              <button
                className="btn primary"
                onClick={async () => {
                  const r = await act(
                    () =>
                      post<Json>(`/api/v1/intake/items/${item.id}/bill`, {
                        fileId,
                        vendorName: f.vendorName.trim() || null,
                        number: f.number.trim() || null,
                        date: f.date || null,
                        ...(f.taxable && (!d?.lines?.length || Number(f.taxable) !== d?.taxable) ? { taxable: Number(f.taxable) } : {}),
                      }),
                    'Draft bill made; check and post it',
                  );
                  if (r) nav(`/o/bill/${r.billId}`);
                }}
              >
                Make a draft bill
              </button>
              <button className="btn" onClick={async () => (await act(() => post(`/api/v1/intake/items/${item.id}/status`, { status: 'ignored' }), 'Ignored')) !== null && onClose()}>
                Not a bill — ignore
              </button>
            </div>
          </>
        )}
        {data.status === 'done' && data.link_object === 'bill' && (
          <p>
            <Link to={`/o/bill/${data.link_id}`}>Open the bill made from this mail</Link>
          </p>
        )}
        {data.status === 'new' && (!att || data.kind === 'payment' || data.kind === 'statement') && (
          <div className="row" style={{ gap: 6 }}>
            <button className="btn primary" onClick={async () => (await act(() => post(`/api/v1/intake/items/${item.id}/status`, { status: 'done' }), 'Marked done')) !== null && onClose()}>
              Done (recorded)
            </button>
            <button className="btn" onClick={async () => (await act(() => post(`/api/v1/intake/items/${item.id}/status`, { status: 'ignored' }), 'Ignored')) !== null && onClose()}>
              Not the business’s — ignore
            </button>
            {data.kind === 'payment' && (
              <Link className="btn ghost" to="/books#desk">
                Match it on the accounts desk
              </Link>
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
          Add the mailbox that receives GeM alerts and supplier bills — e.g. harsha.rani@hrpai.in on GoDaddy (Titan): server imap.titan.email, port 993, the mailbox password.
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
            <option value="godaddy_workspace">GoDaddy Workspace Email (older)</option>
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
