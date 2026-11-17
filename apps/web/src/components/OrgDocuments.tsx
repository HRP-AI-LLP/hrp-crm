/**
 * Organisation → Documents: the copies of the organisation's registrations (PAN, TAN, GST, incorporation,
 * Udyam, Startup India…) and of each partner's or director's papers (PAN, Aadhaar, DIN…), with their
 * numbers, dates and expiry. Visible to the profile's managers only.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { del, get, post, put, upload } from '../lib/api';
import { date as fmtDate } from '../lib/format';
import { Empty, Modal, Spinner, useToast } from './ui';

type Json = Record<string, any>;

/** Shown as a checklist for every organisation / person even before anything is uploaded. */
const COMPANY_CORE = ['pan', 'tan', 'gst', 'incorporation', 'udyam', 'startup_india'];
const PERSON_CORE = ['pan', 'aadhaar', 'uan', 'pf'];
const PARTNER_CORE = ['pan', 'aadhaar', 'din'];
const MAX = 25 * 1024 * 1024;

export function OrgDocuments({ d }: { d: Json }) {
  const q = useQuery({ queryKey: ['organisation', 'documents'], queryFn: () => get<Json>('/api/v1/organisation/documents'), retry: false });
  const people = useQuery({ queryKey: ['organisation', 'people'], queryFn: () => get<Json>('/api/v1/organisation/people'), retry: false });
  const [edit, setEdit] = useState<{ doc?: Json; personId: string | null; userId?: string | null; kind?: string } | null>(null);
  if (q.isLoading || people.isLoading) return <Spinner />;
  if (q.error) return <Empty title="Only managers see this">Registration documents are visible to admins and the profile's managers.</Empty>;
  const docs = (q.data!.documents ?? []) as Json[];
  const persons = (people.data?.persons ?? []) as Json[];
  const kinds = (personal: boolean) => (personal ? q.data!.personKinds : q.data!.companyKinds) as Json[];
  const team = ((d.users ?? []) as Json[]).filter((u) => !persons.some((p) => p.user_id === u.id));
  return (
    <div className="stack">
      <p className="muted small" style={{ margin: 0 }}>
        Copies of the organisation's registrations and of each partner's, director's and team member's papers, with their numbers and validity. Images, PDFs and Office files up to 25 MB. Only admins and the profile's managers can see them.
      </p>
      <Group
        title={d.profile?.legalName || 'The organisation'}
        personId={null}
        core={COMPANY_CORE}
        kinds={kinds(false)}
        docs={docs.filter((x) => !x.personId && !x.userId)}
        onEdit={(doc, kind) => setEdit({ doc, kind, personId: null })}
      />
      {persons.map((p) => (
        <Group key={p.id} title={`${p.name}${p.designation ? ` · ${p.designation}` : ' · partner / director'}`} personId={p.id} core={PARTNER_CORE} kinds={kinds(true)} docs={docs.filter((x) => x.personId === p.id)} onEdit={(doc, kind) => setEdit({ doc, kind, personId: p.id })} />
      ))}
      {team.length > 0 && <h3 style={{ margin: '8px 0 0' }}>Team members</h3>}
      {team.map((u) => (
        <Group key={u.id} title={u.name} personId={null} core={PERSON_CORE} kinds={kinds(true)} docs={docs.filter((x) => x.userId === u.id)} onEdit={(doc, kind) => setEdit({ doc, kind, personId: null, userId: u.id })} />
      ))}
      {!persons.length && <span className="muted small">Add partners and directors under “Partners & directors” to keep their documents here too.</span>}
      {edit && <DocModal {...edit} kinds={kinds(!!(edit.personId || edit.userId))} profile={edit.personId ? persons.find((p) => p.id === edit.personId) : edit.userId ? {} : d.profile} onClose={() => setEdit(null)} />}
    </div>
  );
}

function Group({ title, personId, core, kinds, docs, onEdit }: { title: string; personId: string | null; core: string[]; kinds: Json[]; docs: Json[]; onEdit: (doc?: Json, kind?: string) => void }) {
  const missing = core.filter((k) => !docs.some((x) => x.kind === k));
  const name = (k: string) => kinds.find((x) => x.key === k)?.name ?? k;
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>{title}</h2>
        <button className="btn sm" onClick={() => onEdit(undefined, undefined)}>
          + Add a document
        </button>
      </div>
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>Document</th>
              <th>Number</th>
              <th>Issued</th>
              <th>Valid until</th>
              <th>Copy</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {docs.map((x) => (
              <DocRow key={x.id} doc={x} onEdit={() => onEdit(x)} />
            ))}
            {missing.map((k) => (
              <tr key={`m-${k}`} style={{ opacity: 0.7 }}>
                <td>{name(k)}</td>
                <td className="muted small" colSpan={4}>
                  Not added yet
                </td>
                <td style={{ textAlign: 'right' }}>
                  <button className="btn ghost sm" onClick={() => onEdit(undefined, k)}>
                    Add
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function DocRow({ doc, onEdit }: { doc: Json; onEdit: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const refresh = () => qc.invalidateQueries({ queryKey: ['organisation', 'documents'] });
  const send = async (f: File) => {
    if (f.size > MAX) return toast('Files can be at most 25 MB', true);
    setBusy(true);
    try {
      await upload(`/api/v1/organisation/documents/${doc.id}/file?name=${encodeURIComponent(f.name)}`, f);
      refresh();
      toast('Uploaded');
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <tr>
      <td style={{ whiteSpace: 'normal' }}>
        <b>{doc.kind === 'other' ? doc.label : doc.kindName}</b>
        {doc.kind !== 'other' && doc.label && <div className="muted small">{doc.label}</div>}
        {doc.notes && <div className="muted small">{doc.notes}</div>}
      </td>
      <td className="mono">{doc.number ?? '—'}</td>
      <td>{doc.issuedOn ? fmtDate(doc.issuedOn) : '—'}</td>
      <td>
        {doc.validUntil ? fmtDate(doc.validUntil) : '—'}
        {doc.status === 'expired' && <span className="chip bad" style={{ marginLeft: 6 }}>Expired</span>}
        {doc.status === 'expiring' && <span className="chip warn" style={{ marginLeft: 6 }}>Renew soon</span>}
      </td>
      <td>
        {doc.file ? (
          <span className="row small" style={{ gap: 6 }}>
            <a href={doc.file.url} target="_blank" rel="noreferrer">
              View
            </a>
            <a href={doc.file.downloadUrl}>Download</a>
          </span>
        ) : (
          <span className="muted small">No copy</span>
        )}
      </td>
      <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
        <input ref={input} type="file" hidden accept="image/*,application/pdf,.doc,.docx,.xls,.xlsx" onChange={(e) => e.target.files?.[0] && send(e.target.files[0])} />
        <button className="btn ghost sm" disabled={busy} onClick={() => input.current?.click()}>
          {busy ? 'Uploading…' : doc.file ? 'Replace copy' : 'Upload copy'}
        </button>
        <button className="btn ghost sm" onClick={onEdit}>
          Edit
        </button>
        <button
          className="btn ghost sm"
          onClick={async () => {
            if (!confirm(`Delete ${doc.kindName}${doc.file ? ' and its copy' : ''}?`)) return;
            await del(`/api/v1/organisation/documents/${doc.id}`).catch((e) => toast((e as Error).message, true));
            refresh();
          }}
        >
          Delete
        </button>
      </td>
    </tr>
  );
}

/** Profile fields that already hold a document's number, to start from. */
const FROM_PROFILE: Record<string, string> = { pan: 'pan', tan: 'tan', gst: 'gstin', incorporation: 'registrationNo', udyam: 'udyam', startup_india: 'dpiitNumber', section_80iac: 'section80IacCertNo', din: 'din' };
const FROM_PROFILE_DATE: Record<string, string> = { incorporation: 'incorporatedOn', startup_india: 'dpiitRecognisedOn' };

function DocModal({ doc, kind, personId, userId, kinds, profile, onClose }: { doc?: Json; kind?: string; personId: string | null; userId?: string | null; kinds: Json[]; profile?: Json; onClose: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const start = doc?.kind ?? kind ?? kinds[0]?.key ?? 'other';
  const prefill = (k: string) => (doc ? doc.number ?? '' : (profile?.[FROM_PROFILE[k] ?? ''] as string) ?? '');
  const [f, setF] = useState({
    kind: start,
    label: doc?.label ?? '',
    number: prefill(start),
    issuedOn: doc?.issuedOn ?? (doc ? '' : ((profile?.[FROM_PROFILE_DATE[start] ?? ''] as string) ?? '').slice(0, 10)),
    validUntil: doc?.validUntil ?? '',
    notes: doc?.notes ?? '',
  });
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (file && file.size > MAX) return toast('Files can be at most 25 MB', true);
    setBusy(true);
    try {
      const body = { ...f, number: f.number || null, label: f.label || null, notes: f.notes || null };
      const saved = doc ? await put<Json>(`/api/v1/organisation/documents/${doc.id}`, body) : await post<Json>('/api/v1/organisation/documents', { ...body, personId, userId: userId ?? null });
      if (file) await upload(`/api/v1/organisation/documents/${saved.id}/file?name=${encodeURIComponent(file.name)}`, file);
      qc.invalidateQueries({ queryKey: ['organisation', 'documents'] });
      toast('Saved');
      onClose();
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={doc ? `Edit ${doc.kindName}` : 'Add a document'}
      onClose={onClose}
      footer={
        <button className="btn primary" disabled={busy || (f.kind === 'other' && !f.label.trim())} onClick={save}>
          {busy ? 'Saving…' : 'Save'}
        </button>
      }
    >
      <div className="modal-body stack">
        <label className="field">
          Document
          <select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value, number: f.number || prefill(e.target.value) })}>
            {kinds.map((k) => (
              <option key={k.key} value={k.key}>
                {k.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          {f.kind === 'other' ? 'Name of the document' : 'Description (optional)'}
          <input value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} placeholder={f.kind === 'other' ? 'e.g. FSSAI licence' : ''} />
        </label>
        <label className="field">
          Number
          <input className="mono" value={f.number} onChange={(e) => setF({ ...f, number: e.target.value })} placeholder={f.kind === 'aadhaar' ? 'XXXXXXXX1234 (you may mask the first 8)' : ''} />
        </label>
        <div className="row" style={{ gap: 10 }}>
          <label className="field" style={{ flex: 1 }}>
            Issued on
            <input type="date" value={f.issuedOn} onChange={(e) => setF({ ...f, issuedOn: e.target.value })} />
          </label>
          <label className="field" style={{ flex: 1 }}>
            Valid until (if it expires)
            <input type="date" value={f.validUntil} onChange={(e) => setF({ ...f, validUntil: e.target.value })} />
          </label>
        </div>
        <label className="field">
          Notes
          <input value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} />
        </label>
        <label className="field">
          {doc?.file ? 'Replace the copy (optional)' : 'Copy (image or PDF, optional now)'}
          <input type="file" accept="image/*,application/pdf,.doc,.docx,.xls,.xlsx" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        </label>
      </div>
    </Modal>
  );
}

/**
 * Under a registration number on the Organisation profile (PAN, GSTIN, TAN…): the certificate's copy, to
 * view, upload or replace there and then. The same document as in the Documents tab.
 */
export function DocSlot({ kind, number, label = 'certificate' }: { kind: string; number?: string | null; label?: string }) {
  const toast = useToast();
  const qc = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const q = useQuery({ queryKey: ['organisation', 'documents'], queryFn: () => get<Json>('/api/v1/organisation/documents'), retry: false, staleTime: 30_000 });
  if (q.error || !q.data) return null;
  const doc = ((q.data.documents ?? []) as Json[]).find((d) => !d.personId && !d.userId && d.kind === kind);
  const send = async (f: File) => {
    if (f.size > MAX) return toast('Files can be at most 25 MB', true);
    setBusy(true);
    try {
      let id = doc?.id as string | undefined;
      if (!id) {
        // the number as typed on the profile goes with it (left out if it is not complete yet)
        const made = await post<Json>('/api/v1/organisation/documents', { kind, number: number?.trim() || null }).catch(() => post<Json>('/api/v1/organisation/documents', { kind, number: null }));
        id = made.id;
      }
      await upload(`/api/v1/organisation/documents/${id}/file?name=${encodeURIComponent(f.name)}`, f);
      qc.invalidateQueries({ queryKey: ['organisation', 'documents'] });
      toast('Uploaded');
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <span className="row small" style={{ gap: 8, marginTop: 4 }}>
      <input ref={input} type="file" hidden accept="image/*,application/pdf" onChange={(e) => e.target.files?.[0] && send(e.target.files[0])} />
      {doc?.file ? (
        <>
          <a href={doc.file.url} target="_blank" rel="noreferrer">
            📎 View {label}
          </a>
          <button type="button" className="btn ghost sm" disabled={busy} onClick={() => input.current?.click()}>
            {busy ? 'Uploading…' : 'Replace'}
          </button>
          {doc.status === 'expired' && <span className="chip bad">Expired</span>}
          {doc.status === 'expiring' && <span className="chip warn">Renew soon</span>}
        </>
      ) : (
        <button type="button" className="btn ghost sm" disabled={busy} onClick={() => input.current?.click()}>
          {busy ? 'Uploading…' : `📎 Upload ${label}`}
        </button>
      )}
    </span>
  );
}
