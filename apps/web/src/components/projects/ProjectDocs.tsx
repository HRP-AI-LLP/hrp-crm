/**
 * Client documents: whatever the client shares to explain the work — BRD, requirement notes,
 * screenshots of their current system, sample data and formats, process documents, the contract,
 * meeting notes. Drop any number; the AI reads each, summarises it and sorts it, and the AI delivery
 * agents and the coding agent work from them.
 */
import { useQuery } from '@tanstack/react-query';
import { useMemo, useRef, useState } from 'react';
import { del, get, patch, post, upload } from '../../lib/api';
import { date } from '../../lib/format';
import { Empty, Modal, Spinner, useToast } from '../ui';

type Json = Record<string, any>;
const today = () => new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
const size = (b: number) => (b > 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
const MAX = 25 * 1024 * 1024;
const icon = (t: string) => (t.startsWith('image/') ? '🖼' : t.startsWith('audio/') ? '🎤' : t.startsWith('video/') ? '🎬' : /pdf/.test(t) ? '📕' : /sheet|excel|csv/.test(t) ? '📊' : /presentation|powerpoint/.test(t) ? '📽' : /word/.test(t) ? '📘' : /zip/.test(t) ? '🗜' : '📄');
const STATUS: Record<string, [string, string]> = { pending: ['Reading…', 'info'], read: ['Read', 'good'], unreadable: ['Kept, not read', ''], failed: ['Could not read', 'bad'] };

export function ProjectDocs({ projectId }: { projectId: string }) {
  const toast = useToast();
  const { data, refetch } = useQuery({
    queryKey: ['client-docs', projectId],
    queryFn: () => get<{ items: Json[]; categories: { key: string; label: string }[]; canEdit: boolean }>(`/api/v1/projects/${projectId}/client-docs`),
    // while something is being read, look again
    refetchInterval: (q) => ((q.state.data?.items ?? []).some((d) => d.read_status === 'pending') ? 5000 : false),
  });
  const [cat, setCat] = useState('');
  const [q, setQ] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [form, setForm] = useState({ category: 'auto', sharedBy: '', sharedOn: today(), notes: '' });
  const [progress, setProgress] = useState('');
  const [open, setOpen] = useState<Json | null>(null);
  const [drag, setDrag] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const label = useMemo(() => Object.fromEntries((data?.categories ?? []).map((c) => [c.key, c.label])), [data]);
  const items = useMemo(() => {
    const t = q.trim().toLowerCase();
    return (data?.items ?? []).filter((d) => (!cat || d.category === cat) && (!t || `${d.title} ${d.file_name} ${d.summary ?? ''} ${d.shared_by ?? ''} ${d.notes ?? ''}`.toLowerCase().includes(t)));
  }, [data, cat, q]);
  if (!data) return <Spinner />;
  const counts = data.items.reduce<Record<string, number>>((m, d) => ((m[d.category] = (m[d.category] ?? 0) + 1), m), {});

  const send = async () => {
    let ok = 0;
    const bad: string[] = [];
    for (const [i, f] of files.entries()) {
      setProgress(`Uploading ${i + 1} of ${files.length}: ${f.name}`);
      if (f.size > MAX) {
        bad.push(`${f.name} (over 25 MB)`);
        continue;
      }
      try {
        const qs = new URLSearchParams({ name: f.name, category: form.category, ...(form.sharedBy.trim() ? { sharedBy: form.sharedBy.trim() } : {}), ...(form.sharedOn ? { sharedOn: form.sharedOn } : {}), ...(form.notes.trim() ? { notes: form.notes.trim() } : {}) });
        await upload(`/api/v1/projects/${projectId}/client-docs?${qs}`, f);
        ok++;
      } catch (e) {
        bad.push(`${f.name} (${(e as Error).message})`);
      }
    }
    setProgress('');
    setFiles([]);
    if (ok) toast(`${ok} document${ok === 1 ? '' : 's'} added — the AI is reading ${ok === 1 ? 'it' : 'them'}`);
    if (bad.length) toast(`Not added: ${bad.join('; ')}`, true);
    refetch();
  };
  const pick = (list: FileList | null) => list && setFiles((f) => [...f, ...Array.from(list)]);

  return (
    <div className="stack">
      <p className="small muted" style={{ margin: 0 }}>
        Everything the client shares to explain what they want: BRD, requirement notes, screenshots of their current system, sample data and report formats, processes, API documents, the contract, meeting notes. The AI reads each one (PDF, Word, Excel,
        PowerPoint, text, photos and screenshots, voice notes — Hindi or English), summarises it and sorts it. AI delivery and the coding agent work from these.
      </p>
      {data.canEdit && (
        <section
          className="panel stack"
          style={{ padding: 12, outline: drag ? '2px dashed var(--accent)' : undefined }}
          onDragOver={(e) => (e.preventDefault(), setDrag(true))}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDrag(false);
            pick(e.dataTransfer.files);
          }}
        >
          <div className="row" style={{ gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
            <button className="btn primary" onClick={() => input.current?.click()} disabled={!!progress}>
              Add documents
            </button>
            <span className="small muted">or drop files here — any number, up to 25 MB each</span>
            <input ref={input} type="file" multiple hidden onChange={(e) => (pick(e.target.files), (e.target.value = ''))} />
          </div>
          {files.length > 0 && (
            <>
              <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
                {files.map((f, i) => (
                  <li key={`${f.name}-${i}`}>
                    {icon(f.type)} {f.name} <span className="muted">· {size(f.size)}</span>{' '}
                    <button className="link-btn small" onClick={() => setFiles(files.filter((_, j) => j !== i))}>
                      remove
                    </button>
                  </li>
                ))}
              </ul>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 10 }}>
                <label className="field">
                  What it is
                  <select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>
                    <option value="auto">Let the AI sort it</option>
                    {data.categories.map((c) => (
                      <option key={c.key} value={c.key}>
                        {c.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  Shared by
                  <input value={form.sharedBy} placeholder="e.g. Deepak Verma (client)" onChange={(e) => setForm({ ...form, sharedBy: e.target.value })} />
                </label>
                <label className="field">
                  Shared on
                  <input type="date" value={form.sharedOn} onChange={(e) => setForm({ ...form, sharedOn: e.target.value })} />
                </label>
                <label className="field">
                  Note (optional)
                  <input value={form.notes} placeholder="e.g. after the 20 Nov call" onChange={(e) => setForm({ ...form, notes: e.target.value })} />
                </label>
              </div>
              <div className="row" style={{ gap: 8 }}>
                <button className="btn primary" disabled={!!progress} onClick={send}>
                  {progress || `Upload ${files.length} file${files.length === 1 ? '' : 's'}`}
                </button>
                <button className="btn ghost" disabled={!!progress} onClick={() => setFiles([])}>
                  Clear
                </button>
              </div>
            </>
          )}
        </section>
      )}
      <div className="row" style={{ gap: 6, flexWrap: 'wrap', justifyContent: 'space-between' }}>
        <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
          <button className={`chip-btn ${cat === '' ? 'on' : ''}`} onClick={() => setCat('')}>
            All {data.items.length}
          </button>
          {data.categories
            .filter((c) => counts[c.key])
            .map((c) => (
              <button key={c.key} className={`chip-btn ${cat === c.key ? 'on' : ''}`} onClick={() => setCat(c.key)}>
                {c.label} {counts[c.key]}
              </button>
            ))}
        </div>
        <input placeholder="Search documents" value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 240 }} />
      </div>
      {!items.length ? (
        <Empty title={data.items.length ? 'Nothing matches' : 'No client documents yet'}>{data.items.length ? 'Try another category or search.' : 'Add the BRD, requirement notes, screenshots or sample data the client shared.'}</Empty>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 10 }}>
          {items.map((d) => {
            const [st, tone] = STATUS[d.read_status] ?? ['', ''];
            return (
              <button key={d.id} type="button" className="panel" style={{ padding: 10, textAlign: 'left', cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: 6 }} onClick={() => setOpen(d)}>
                {d.content_type?.startsWith('image/') && !/heic/.test(d.content_type) ? (
                  <img src={d.url} alt="" loading="lazy" style={{ width: '100%', height: 140, objectFit: 'cover', borderRadius: 6, background: 'var(--bg-2, #f4f5f7)' }} />
                ) : (
                  <div style={{ height: 56, fontSize: 34, display: 'flex', alignItems: 'center' }}>{icon(d.content_type ?? '')}</div>
                )}
                <b style={{ lineHeight: 1.3 }}>{d.title}</b>
                <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                  <span className="chip">{label[d.category] ?? d.category}</span>
                  <span className={`chip ${tone}`}>{st}</span>
                </div>
                {d.summary && <div className="small muted" style={{ display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden', whiteSpace: 'pre-wrap' }}>{d.summary}</div>}
                <div className="small muted">
                  {[d.shared_by, d.shared_on ? date(d.shared_on) : null, size(Number(d.size ?? 0))].filter(Boolean).join(' · ')}
                </div>
              </button>
            );
          })}
        </div>
      )}
      {open && <DocModal d={open} projectId={projectId} categories={data.categories} canEdit={data.canEdit} onClose={() => setOpen(null)} onChanged={() => (setOpen(null), refetch())} />}
    </div>
  );
}

function DocModal({ d, projectId, categories, canEdit, onClose, onChanged }: { d: Json; projectId: string; categories: { key: string; label: string }[]; canEdit: boolean; onClose: () => void; onChanged: () => void }) {
  const toast = useToast();
  const [f, setF] = useState({ title: d.title, category: d.category, sharedBy: d.shared_by ?? '', sharedOn: d.shared_on ? String(d.shared_on).slice(0, 10) : '', notes: d.notes ?? '' });
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>, msg: string) => {
    setBusy(true);
    try {
      await fn();
      toast(msg);
      onChanged();
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  };
  const t = String(d.content_type ?? '');
  return (
    <Modal
      title={d.title}
      onClose={onClose}
      wide
      footer={
        <>
          <a className="btn ghost" href={d.downloadUrl}>
            Download
          </a>
          {canEdit && (
            <>
              <button className="btn ghost" disabled={busy} onClick={() => confirm(`Remove “${d.title}” from the project?`) && run(() => del(`/api/v1/projects/${projectId}/client-docs/${d.id}`), 'Removed')}>
                Remove
              </button>
              <button className="btn" disabled={busy} onClick={() => run(() => post(`/api/v1/projects/${projectId}/client-docs/${d.id}/read`), 'The AI is reading it again')}>
                Read again
              </button>
              <button
                className="btn primary"
                disabled={busy || !f.title.trim()}
                onClick={() => run(() => patch(`/api/v1/projects/${projectId}/client-docs/${d.id}`, { title: f.title.trim(), category: f.category, sharedBy: f.sharedBy.trim() || null, sharedOn: f.sharedOn || null, notes: f.notes.trim() || null }), 'Saved')}
              >
                Save
              </button>
            </>
          )}
        </>
      }
    >
      <div className="modal-body stack">
        <div style={{ maxHeight: '50vh', overflow: 'auto', borderRadius: 6 }}>
          {t.startsWith('image/') && !/heic/.test(t) ? (
            <a href={d.url} target="_blank" rel="noreferrer">
              <img src={d.url} alt={d.title} style={{ maxWidth: '100%', borderRadius: 6 }} />
            </a>
          ) : /pdf/.test(t) ? (
            <iframe title={d.title} src={d.url} style={{ width: '100%', height: '48vh', border: 0 }} />
          ) : t.startsWith('audio/') ? (
            <audio controls src={d.url} style={{ width: '100%' }} />
          ) : t.startsWith('video/') ? (
            <video controls src={d.url} style={{ maxWidth: '100%', maxHeight: '46vh' }} />
          ) : (
            <a href={d.downloadUrl}>
              {icon(t)} {d.file_name} · {size(Number(d.size ?? 0))}
            </a>
          )}
        </div>
        <section>
          <h4 style={{ margin: '0 0 4px' }}>What the AI read in it</h4>
          {d.read_status === 'pending' ? (
            <p className="small muted">Reading…</p>
          ) : d.summary ? (
            <div style={{ whiteSpace: 'pre-wrap' }}>{d.summary}</div>
          ) : (
            <p className="small muted">{d.read_error ?? 'Nothing read yet.'}</p>
          )}
        </section>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 10 }}>
          <label className="field">
            Title
            <input disabled={!canEdit} value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} />
          </label>
          <label className="field">
            What it is
            <select disabled={!canEdit} value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>
              {categories.map((c) => (
                <option key={c.key} value={c.key}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            Shared by
            <input disabled={!canEdit} value={f.sharedBy} onChange={(e) => setF({ ...f, sharedBy: e.target.value })} />
          </label>
          <label className="field">
            Shared on
            <input disabled={!canEdit} type="date" value={f.sharedOn} onChange={(e) => setF({ ...f, sharedOn: e.target.value })} />
          </label>
        </div>
        <label className="field">
          Note
          <textarea disabled={!canEdit} rows={2} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} />
        </label>
        <div className="small muted">
          {d.file_name} · {size(Number(d.size ?? 0))} · added by {d.uploaded_by ?? '—'} on {date(d.created_at)}
          {d.auto_category ? ' · the AI will sort it after reading' : ''}
        </div>
      </div>
    </Modal>
  );
}
