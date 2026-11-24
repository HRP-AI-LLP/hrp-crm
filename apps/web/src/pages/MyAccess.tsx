/**
 * "My access" — the screen a finance professional (CA, accountant, …) sees for their own access. It
 * shows what they can currently do, and lets them request more: pick the modules and levels they need,
 * add a note, and submit. The request goes to an admin for approval; once approved the access is
 * granted automatically.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { AccessChips, AccessEditor, emptyAccess, type Access } from '../components/ProfessionalsTab';
import { get, post } from '../lib/api';
import { date as fmtDate } from '../lib/format';
import { Empty, Spinner, useToast } from '../components/ui';

type Json = Record<string, any>;

export function MyAccessPage() {
  const toast = useToast();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['professionals', 'me'], queryFn: () => get<Json>('/api/v1/professionals/me') });
  const [want, setWant] = useState<Access>(emptyAccess());
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  if (q.isLoading || !q.data) return <Spinner />;
  const data = q.data;
  const pro = data.professional;

  if (!pro) {
    return (
      <>
        <div className="page-head">
          <h1>My access</h1>
        </div>
        <section className="panel">
          <div className="panel-body">
            <Empty title="Nothing to show here">This screen is for the accountants and CAs a business invites. Your account isn't one of them.</Empty>
          </div>
        </section>
      </>
    );
  }

  const pending = (data.requests as Json[]).find((r) => r.status === 'pending');
  const submit = async () => {
    if (!Object.keys(want.modules).length && !note.trim()) {
      toast('Choose what access you need, or describe it', true);
      return;
    }
    setBusy(true);
    try {
      await post('/api/v1/professionals/me/requests', { modules: want.modules, canFile: want.canFile, note: note.trim() || undefined });
      toast('Request sent for approval');
      setWant(emptyAccess());
      setNote('');
      qc.invalidateQueries({ queryKey: ['professionals', 'me'] });
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>My access</h1>
          <p>
            You are set up as {pro.kindLabel.toLowerCase()}
            {pro.firm ? ` at ${pro.firm}` : ''}. Here is what you can do, and how to ask for more.
          </p>
        </div>
      </div>

      <section className="panel">
        <div className="panel-body stack">
          <h3 style={{ margin: 0 }}>What you can do now</h3>
          <div>
            <AccessChips access={pro.access} meta={data} />
          </div>
        </div>
      </section>

      <section className="panel">
        <div className="panel-body stack">
          <h3 style={{ margin: 0 }}>Request more access</h3>
          {pending ? (
            <div className="notice">
              You have a request waiting for approval (sent {fmtDate(pending.createdAt)}). You'll see the new access here once an admin approves it.
            </div>
          ) : (
            <>
              <p className="muted small" style={{ margin: 0 }}>
                Pick the modules and the level you need. Read only lets you view; Download &amp; reports also lets you export; Can edit lets you change records. An admin approves before it takes effect.
              </p>
              <AccessEditor meta={data} value={want} onChange={setWant} />
              <label className="field">
                Anything else you need (optional)
                <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} placeholder="e.g. access to a specific report, or a feature not listed above" />
              </label>
              <div>
                <button className="btn primary" disabled={busy} onClick={submit}>
                  Send request
                </button>
              </div>
            </>
          )}
        </div>
      </section>

      <SignRequests />

      {(data.requests as Json[]).length > 0 && (
        <section className="panel">
          <div className="panel-body stack">
            <h3 style={{ margin: 0 }}>Your requests</h3>
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Asked</th>
                    <th>Requested</th>
                    <th>Note</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {(data.requests as Json[]).map((r) => (
                    <tr key={r.id}>
                      <td className="small">{fmtDate(r.createdAt)}</td>
                      <td style={{ whiteSpace: 'normal', maxWidth: 320 }}>
                        <AccessChips access={r.requested} meta={data} />
                      </td>
                      <td className="small" style={{ whiteSpace: 'normal' }}>
                        {r.note || '—'}
                      </td>
                      <td>
                        <span className={`chip ${r.status === 'approved' ? '' : r.status === 'denied' ? 'warn' : ''}`}>{r.status}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      )}
    </>
  );
}

const fileToB64 = (file: File) =>
  new Promise<string>((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).replace(/^data:[^,]*,/, ''));
    r.onerror = rej;
    r.readAsDataURL(file);
  });

const SIGN_STATUS: Record<string, [string, string]> = { pending: ['', 'Waiting for signature'], signed: ['good', 'Signed'], rejected: ['warn', 'Declined'] };

/** A professional uploads a document to be digitally signed, and downloads it once signed. */
function SignRequests() {
  const toast = useToast();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['sign-requests', 'me'], queryFn: () => get<{ items: Json[] }>('/api/v1/professionals/me/sign-requests') });
  const [name, setName] = useState('');
  const [note, setNote] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!file) return toast('Choose a PDF to upload', true);
    if (file.type && file.type !== 'application/pdf') return toast('Only PDF files can be signed', true);
    setBusy(true);
    try {
      const pdf = await fileToB64(file);
      await post('/api/v1/professionals/me/sign-requests', { name: name.trim() || file.name.replace(/\.pdf$/i, ''), note: note.trim() || undefined, pdf });
      toast('Sent for signature');
      setName('');
      setNote('');
      setFile(null);
      qc.invalidateQueries({ queryKey: ['sign-requests', 'me'] });
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  };
  const items = q.data?.items ?? [];
  return (
    <section className="panel">
      <div className="panel-body stack">
        <h3 style={{ margin: 0 }}>Get a document digitally signed</h3>
        <p className="muted small" style={{ margin: 0 }}>
          Upload a PDF (a form, declaration or certificate) that needs the company's digital signature. An admin signs it with the company DSC and the signed copy appears here to download.
        </p>
        <div className="form-grid">
          <label className="field">
            Document name
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Form 15CB" />
          </label>
          <label className="field">
            PDF file
            <input type="file" accept="application/pdf" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          </label>
          <label className="field" style={{ gridColumn: '1 / -1' }}>
            Note (optional)
            <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} placeholder="Anything the signer should know" />
          </label>
        </div>
        <div>
          <button className="btn primary" disabled={busy || !file} onClick={submit}>
            Send for signature
          </button>
        </div>
        {items.length > 0 && (
          <div className="table-wrap">
            <table className="data" data-export="off">
              <thead>
                <tr>
                  <th>Document</th>
                  <th>Sent</th>
                  <th>Status</th>
                  <th>Signed copy</th>
                </tr>
              </thead>
              <tbody>
                {items.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <b>{r.name}</b>
                      {r.note && <div className="muted small">{r.note}</div>}
                      {r.status === 'rejected' && r.decisionNote && <div className="muted small">Reason: {r.decisionNote}</div>}
                    </td>
                    <td className="small">{fmtDate(r.createdAt)}</td>
                    <td>
                      <span className={`chip ${SIGN_STATUS[r.status]?.[0] ?? ''}`}>{SIGN_STATUS[r.status]?.[1] ?? r.status}</span>
                    </td>
                    <td>
                      {r.signedUrl ? (
                        <a className="btn sm" href={r.signedUrl} target="_blank" rel="noreferrer">
                          Download signed
                        </a>
                      ) : (
                        <span className="muted small">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}

export default MyAccessPage;
