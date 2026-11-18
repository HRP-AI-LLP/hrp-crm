import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { del, get, upload } from '../lib/api';
import { relative } from '../lib/format';
import { DocumentViewer, ViewSignButton } from './DocumentViewer';
import { Empty, Spinner, useToast } from './ui';

export interface FileItem {
  id: string;
  name: string;
  contentType: string;
  size: number;
  kind: string;
  description: string | null;
  uploaderName: string | null;
  createdAt: string;
  inline: boolean;
  url: string;
  downloadUrl: string;
}

export const fileSize = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
const KIND_LABEL: Record<string, string> = { attachment: 'File', photo: 'Photo', proof: 'Proof', signature: 'Signature', document: 'Document' };
const ACCEPT = 'image/*,application/pdf,.docx,.xlsx,.pptx,.csv,.txt,.zip,video/mp4';

/** Uploads one file to a record; resolves with the stored file (with signed links). */
export async function uploadFile(object: string, id: string, file: File, kind?: string, description?: string) {
  const qs = new URLSearchParams({ object, id, name: file.name || 'photo.jpg' });
  if (kind) qs.set('kind', kind);
  if (description) qs.set('description', description);
  return upload<FileItem>(`/api/v1/files?${qs}`, file);
}

export function useFiles(object: string, id: string) {
  return useQuery({ queryKey: ['files', object, id], queryFn: () => get<{ items: FileItem[]; enabled: boolean }>(`/api/v1/files?object=${object}&id=${id}`), staleTime: 60_000 });
}

/** Attachments of a record: drop or pick files, image thumbnails, open / download / remove. */
export function FilesPanel({ object, id, canEdit, kind, title }: { object: string; id: string; canEdit: boolean; kind?: string; title?: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(0);
  const [over, setOver] = useState(false);
  const { data, isLoading } = useFiles(object, id);
  const [viewing, setViewing] = useState<string | null>(null);

  const send = async (files: FileList | File[]) => {
    const list = [...files];
    if (!list.length) return;
    setBusy(list.length);
    let ok = 0;
    for (const f of list) {
      try {
        if (f.size > 25 * 1024 * 1024) throw new Error(`${f.name} is larger than 25 MB`);
        await uploadFile(object, id, f, kind);
        ok++;
      } catch (e) {
        toast((e as Error).message, true);
      } finally {
        setBusy((b) => b - 1);
      }
    }
    if (ok) toast(ok === 1 ? 'File added' : `${ok} files added`);
    qc.invalidateQueries({ queryKey: ['files', object, id] });
  };

  if (isLoading) return <div className="panel-body"><Spinner /></div>;
  const items = (data?.items ?? []).filter((f) => !kind || f.kind === kind);
  const enabled = data?.enabled !== false;

  return (
    <div className="panel-body stack">
      {canEdit && enabled && (
        <div
          className={`dropzone${over ? ' over' : ''}`}
          onDragOver={(e) => {
            e.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setOver(false);
            void send(e.dataTransfer.files);
          }}
        >
          <div>
            <b>{busy ? `Uploading ${busy}…` : title ?? 'Drop files here'}</b>
            <div className="muted small">Photos, PDF, Office documents or CSV · up to 25 MB each</div>
          </div>
          <div className="row">
            <button className="btn sm" disabled={!!busy} onClick={() => input.current?.click()}>
              Choose files
            </button>
            <label className="btn sm mobile-cam">
              Take photo
              <input type="file" accept="image/*" capture="environment" hidden onChange={(e) => e.target.files && send(e.target.files)} />
            </label>
          </div>
          <input ref={input} type="file" multiple accept={ACCEPT} hidden onChange={(e) => e.target.files && send(e.target.files).then(() => (e.target.value = ''))} />
        </div>
      )}
      {!enabled && <p className="notice small" style={{ margin: 0 }}>File storage is not switched on for this workspace yet.</p>}
      {items.length ? (
        <ul className="file-grid">
          {items.map((f) => (
            <li key={f.id} className="file-card">
              <button type="button" className="file-thumb" aria-label={`View ${f.name}`} onClick={() => setViewing(f.id)}>
                {f.contentType.startsWith('image/') && f.contentType !== 'image/heic' ? <img src={f.url} alt="" loading="lazy" /> : <span className="file-ext">{(f.name.split('.').pop() ?? 'file').slice(0, 4).toUpperCase()}</span>}
              </button>
              <div className="file-meta">
                <a href={f.downloadUrl} className="file-name" title={f.name}>
                  {f.name}
                </a>
                <div className="muted small">
                  {KIND_LABEL[f.kind] ?? f.kind} · {fileSize(f.size)} · {relative(f.createdAt)}
                  {f.uploaderName ? ` · ${f.uploaderName}` : ''}
                </div>
                {f.description && <div className="small">{f.description}</div>}
                <div className="file-actions">
                  <button type="button" className="btn sm" onClick={() => setViewing(f.id)}>
                    View
                  </button>
                  {canEdit && (f.contentType === 'application/pdf' || f.contentType === 'image/png' || f.contentType === 'image/jpeg') && (
                    <ViewSignButton fileId={f.id} name={f.name} label="Sign / DSC" />
                  )}
                </div>
              </div>
              {canEdit && (
                <button
                  className="btn ghost sm"
                  aria-label={`Remove ${f.name}`}
                  onClick={async () => {
                    if (!window.confirm(`Remove “${f.name}”?`)) return;
                    try {
                      await del(`/api/v1/files/${f.id}`);
                      qc.invalidateQueries({ queryKey: ['files', object, id] });
                    } catch (e) {
                      toast((e as Error).message, true);
                    }
                  }}
                >
                  ✕
                </button>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <Empty title="No files yet">{canEdit ? 'Drawings, site photos, signed documents and proofs live here.' : 'Nothing has been attached.'}</Empty>
      )}
      {viewing && <DocumentViewer fileId={viewing} onClose={() => setViewing(null)} />}
    </div>
  );
}
