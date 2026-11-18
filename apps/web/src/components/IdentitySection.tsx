/**
 * PAN, Aadhaar, UAN and PF number of a person being onboarded (a partner / director or a team member),
 * with a copy of each. Used inside the forms that add or edit the person: the numbers and copies are
 * saved right after the person is (created and) saved, with persistIdentity().
 *
 * Aadhaar is stored encrypted and shown as its last four digits; "Show" reveals it (and is audited).
 */
import { useQuery } from '@tanstack/react-query';
import { ViewSignButton } from './DocumentViewer';
import { useEffect, useRef, useState } from 'react';
import { get, post, put, upload } from '../lib/api';
import { useToast } from './ui';

type Json = Record<string, any>;
export type IdentitySubject = 'partner' | 'user';

export interface IdentityValues {
  pan: string;
  aadhaar: string; // typed: replaces the stored one; '' with clearAadhaar: removes it
  clearAadhaar: boolean;
  uan: string;
  pfNumber: string;
  files: Partial<Record<IdKind, File>>;
}
export type IdKind = 'pan' | 'aadhaar' | 'uan' | 'pf';
const KINDS: [IdKind, string][] = [
  ['pan', 'PAN card'],
  ['aadhaar', 'Aadhaar'],
  ['uan', 'UAN card / EPFO letter'],
  ['pf', 'PF nomination (Form 2 / 11)'],
];
const MAX = 25 * 1024 * 1024;

export const blankIdentity = (): IdentityValues => ({ pan: '', aadhaar: '', clearAadhaar: false, uan: '', pfNumber: '', files: {} });

export function useIdentity(subject: IdentitySubject, id: string | null | undefined) {
  return useQuery({ queryKey: ['identity', subject, id], queryFn: () => get<Json>(`/api/v1/identity/${subject}/${id}`), enabled: !!id, retry: false });
}

/** Saves the numbers, then each chosen copy (making the document entry if there is none yet). */
export async function persistIdentity(subject: IdentitySubject, id: string, v: IdentityValues, opts: { includePan: boolean }) {
  const body: Json = { uan: v.uan.replace(/\s/g, ''), pfNumber: v.pfNumber };
  if (opts.includePan) body.pan = v.pan;
  if (v.aadhaar.trim()) body.aadhaar = v.aadhaar;
  else if (v.clearAadhaar) body.aadhaar = '';
  const saved = await put<Json>(`/api/v1/identity/${subject}/${id}`, body);
  for (const [kind] of KINDS) {
    const f = v.files[kind];
    if (!f) continue;
    if (f.size > MAX) throw new Error(`${f.name}: files can be at most 25 MB`);
    let doc = (saved.documents as Json[]).find((d) => d.kind === kind);
    if (!doc) {
      const number = kind === 'pan' ? saved.pan : kind === 'aadhaar' ? v.aadhaar.replace(/\s/g, '') || null : kind === 'uan' ? saved.uan : saved.pfNumber;
      doc = await post<Json>('/api/v1/organisation/documents', { [subject === 'user' ? 'userId' : 'personId']: id, kind, number: number || null });
    }
    await upload(`/api/v1/organisation/documents/${doc.id}/file?name=${encodeURIComponent(f.name)}`, f);
  }
  return saved;
}

export function IdentitySection({ subject, id, value, onChange, showPan = true }: { subject: IdentitySubject; id: string | null; value: IdentityValues; onChange: (v: IdentityValues) => void; showPan?: boolean }) {
  const toast = useToast();
  const q = useIdentity(subject, id);
  const cur = q.data;
  const [changing, setChanging] = useState(false);
  const [shown, setShown] = useState<string | null>(null);
  const set = (k: keyof IdentityValues, val: unknown) => onChange({ ...value, [k]: val });
  // fill the form once what is stored has loaded (unless something was typed already)
  const filled = useRef(false);
  useEffect(() => {
    if (!cur || filled.current) return;
    filled.current = true;
    if (!value.uan && !value.pfNumber && !value.aadhaar) onChange({ ...value, pan: value.pan || cur.pan || '', uan: cur.uan ?? '', pfNumber: cur.pfNumber ?? '' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cur]);
  const docOf = (kind: IdKind) => ((cur?.documents ?? []) as Json[]).find((d) => d.kind === kind);
  if (id && q.error) return <p className="muted small">ID and statutory details are visible to admins who manage users and to the organisation profile's managers.</p>;
  return (
    <fieldset className="panel wide" style={{ padding: 12, margin: 0, width: '100%', minWidth: 0, boxSizing: 'border-box', gridColumn: '1 / -1' }}>
      <legend className="small" style={{ fontWeight: 600, padding: '0 6px' }}>
        ID and statutory details
      </legend>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 10 }}>
        {showPan && (
          <label className="field">
            PAN
            <input className="mono" maxLength={10} value={value.pan} onChange={(e) => set('pan', e.target.value.toUpperCase())} placeholder="ABCDE1234F" />
          </label>
        )}
        <div className="field">
          Aadhaar
          {cur?.hasAadhaar && !changing ? (
            <span className="row small" style={{ gap: 8, minHeight: 34 }}>
              <span className="mono" style={{ whiteSpace: 'nowrap' }}>{shown ?? cur.aadhaar}</span>
              <button
                type="button"
                className="btn ghost sm"
                onClick={async () => {
                  try {
                    setShown(shown ? null : (await post<Json>(`/api/v1/identity/${subject}/${id}/reveal-aadhaar`, {})).aadhaar);
                  } catch (e) {
                    toast((e as Error).message, true);
                  }
                }}
              >
                {shown ? 'Hide' : 'Show'}
              </button>
              <button type="button" className="btn ghost sm" onClick={() => setChanging(true)}>
                Change
              </button>
            </span>
          ) : (
            <input className="mono" inputMode="numeric" maxLength={14} value={value.aadhaar} onChange={(e) => onChange({ ...value, aadhaar: e.target.value.replace(/[^\d ]/g, ''), clearAadhaar: false })} placeholder="1234 5678 9012" />
          )}
          {cur?.hasAadhaar && changing && (
            <label className="row small" style={{ gap: 4 }}>
              <input type="checkbox" checked={value.clearAadhaar} onChange={(e) => onChange({ ...value, clearAadhaar: e.target.checked, aadhaar: '' })} />
              Remove the stored number
            </label>
          )}
        </div>
        <label className="field">
          UAN (EPFO)
          <input className="mono" inputMode="numeric" maxLength={14} value={value.uan} onChange={(e) => set('uan', e.target.value.replace(/[^\d ]/g, ''))} placeholder="12 digits" />
        </label>
        <label className="field">
          PF member number
          <input className="mono" value={value.pfNumber} onChange={(e) => set('pfNumber', e.target.value.toUpperCase())} placeholder="MH/BAN/0012345/000/0001234" />
        </label>
      </div>
      <div className="stack" style={{ gap: 6, marginTop: 10 }}>
        <span className="small" style={{ fontWeight: 600 }}>
          Copies
        </span>
        {KINDS.map(([kind, label]) => {
          const d = docOf(kind);
          return (
            <div key={kind} className="row small" style={{ gap: 8, flexWrap: 'wrap' }}>
              <span style={{ width: 180 }}>{label}</span>
              {d?.file ? (
                <ViewSignButton fileId={d.file.id} name={d.file.name} label={`View ${d.file.name}`} className="link-btn" />
              ) : (
                <span className="muted">No copy yet</span>
              )}
              <input
                type="file"
                aria-label={`${d?.file ? 'Replace' : 'Upload'} ${label}`}
                accept="image/*,application/pdf"
                style={{ maxWidth: 230 }}
                onChange={(e) => set('files', { ...value.files, [kind]: e.target.files?.[0] ?? undefined })}
              />
            </div>
          );
        })}
        <span className="muted small">Images or PDF, up to 25 MB each. Saved with the person; also listed under Organisation → Documents.</span>
      </div>
    </fieldset>
  );
}

/** Starting values from what is stored. */
export function identityFrom(cur: Json | undefined, pan = ''): IdentityValues {
  return { ...blankIdentity(), pan: cur?.pan || pan, uan: cur?.uan ?? '', pfNumber: cur?.pfNumber ?? '' };
}
