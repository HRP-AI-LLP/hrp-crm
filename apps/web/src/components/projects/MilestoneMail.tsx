/**
 * A milestone's approval mail thread: search every mailbox (mail intake, your own Gmail / Outlook),
 * any date, keep the whole thread here — each email as an .eml file and on the project's timeline,
 * each attachment as a file — and pick the customer's approval from it.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { download, get, post } from '../../lib/api';
import { date } from '../../lib/format';
import { Modal, Spinner, useToast } from '../ui';

type Json = Record<string, any>;
const size = (n: number) => (n > 1_048_576 ? `${(n / 1_048_576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

export function MilestoneMailList({ projectId, milestoneId }: { projectId: string; milestoneId: string }) {
  const { data } = useQuery({ queryKey: ['milestone-mail', milestoneId], queryFn: () => get<Json[]>(`/api/v1/projects/${projectId}/milestones/${milestoneId}/mail`) });
  if (!data?.length) return null;
  const mails = data.filter((x) => x.kind === 'email');
  const files = data.filter((x) => x.kind === 'attachment');
  return (
    <div className="field wide">
      Mail thread kept here ({mails.length} email{mails.length === 1 ? '' : 's'}, {files.length} attachment{files.length === 1 ? '' : 's'})
      <div className="stack" style={{ gap: 4 }}>
        {mails.map((m) => (
          <div key={m.id} className="small">
            <span className={`chip ${m.direction === 'in' ? 'good' : ''}`}>{m.direction === 'in' ? 'customer' : 'us'}</span> <b>{m.subject ?? '(no subject)'}</b>
            <span className="muted">
              {' '}
              · {m.from ?? ''} · {date(m.occurred_at)}
            </span>{' '}
            {m.file_id && (
              <button type="button" className="link-btn small" title="The email as a file (opens in Outlook / Thunderbird / Apple Mail)" onClick={() => void download(`/api/v1/files/${m.file_id}/content`, m.file_name ?? 'email.eml')}>
                .eml
              </button>
            )}
            {files
              .filter((f) => f.activity_id === m.activity_id)
              .map((f) => (
                <div key={f.id} style={{ marginLeft: 18 }}>
                  📎{' '}
                  <button type="button" className="link-btn small" onClick={() => void download(`/api/v1/files/${f.file_id}/content`, f.file_name ?? 'attachment')}>
                    {f.file_name}
                  </button>{' '}
                  <span className="muted">{f.size_bytes ? size(Number(f.size_bytes)) : ''}</span>
                </div>
              ))}
          </div>
        ))}
      </div>
    </div>
  );
}

export function MailThreadSearch({ projectId, milestoneId, initial, onClose, onApproval }: { projectId: string; milestoneId: string; initial: string; onClose: () => void; onApproval: (x: { id: string; subject: string; date: string | null }) => void }) {
  const [q, setQ] = useState(initial);
  const [term, setTerm] = useState(initial.trim().length >= 3 ? initial.trim() : '');
  const [kept, setKept] = useState<Json | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const toast = useToast();
  const qc = useQueryClient();
  const { data, isFetching, error } = useQuery({
    queryKey: ['mail-search', projectId, term],
    queryFn: () => get<Json>(`/api/v1/projects/${projectId}/mail-search?q=${encodeURIComponent(term)}`),
    enabled: term.length >= 3,
    retry: false,
  });
  const keep = async (t: Json) => {
    setBusy(t.key);
    try {
      const r = await post<Json>(`/api/v1/projects/${projectId}/milestones/${milestoneId}/mail-thread`, { source: t.source, key: t.key });
      setKept({ ...r, subject: t.subject });
      qc.invalidateQueries({ queryKey: ['milestone-mail', milestoneId] });
      qc.invalidateQueries({ queryKey: ['approval-emails', projectId] });
      toast(`${r.saved} email${r.saved === 1 ? '' : 's'} and ${r.files} attachment${r.files === 1 ? '' : 's'} kept on the milestone`);
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy(null);
    }
  };
  return (
    <Modal title="Find the approval mail thread" wide onClose={onClose}>
      <div className="modal-body stack">
        {kept ? (
          <>
            <p className="small">
              <b>{kept.subject}</b>: {kept.saved} email{kept.saved === 1 ? '' : 's'} kept{kept.alreadyHere ? ` (${kept.alreadyHere} were here already)` : ''}, {kept.files} attachment{kept.files === 1 ? '' : 's'} saved
              {kept.skippedFiles?.length ? ` · not kept (file type not allowed): ${kept.skippedFiles.join(', ')}` : ''}. Which one is the customer's approval?
            </p>
            {(kept.messages as Json[]).map((m) => (
              <div key={m.activityId} className="panel spread" style={{ padding: 8, gap: 8 }}>
                <div className="small" style={{ minWidth: 0 }}>
                  <b>{m.subject || '(no subject)'}</b> {m.looksLikeApproval && <span className="chip good">looks like approval</span>}
                  <div className="muted">
                    {m.direction === 'in' ? 'From the customer' : 'Sent by us'} · {m.from ?? ''} · {date(m.date)}
                    {m.attachments ? ` · ${m.attachments} attachment${m.attachments === 1 ? '' : 's'}` : ''}
                  </div>
                </div>
                <button className="btn sm primary" onClick={() => (onApproval({ id: m.activityId, subject: m.subject, date: m.date }), onClose())}>
                  Use as approval
                </button>
              </div>
            ))}
            {!kept.messages.length && <p className="small muted">Every email of this thread was already on the milestone.</p>}
          </>
        ) : (
          <>
            <div className="row" style={{ gap: 6 }}>
              <input autoFocus placeholder="Subject or words in the email, e.g. Acknowledgement of Completion" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && setTerm(q.trim())} />
              <button className="btn sm" disabled={q.trim().length < 3} onClick={() => setTerm(q.trim())}>
                Search
              </button>
            </div>
            <p className="small muted" style={{ margin: 0 }}>
              Searches every mailbox you can read here — the mail-intake mailboxes (Settings → Mail intake) and your own connected Gmail / Outlook — inbox and sent mail, any date.
            </p>
            {isFetching && <Spinner />}
            {error && <p className="small" style={{ color: 'var(--bad)' }}>{(error as Error).message}</p>}
            {data && !data.sources.length && <p className="notice small">No mailbox to search yet: add one in Settings → Mail intake (e.g. harsha.rani@hrpai.in over IMAP), or connect your Gmail / Outlook under My account.</p>}
            {(data?.errors as Json[] | undefined)?.map((e) => (
              <p key={e.source} className="small" style={{ color: 'var(--bad)', margin: 0 }}>
                {e.source}: {e.error}
              </p>
            ))}
            {data && data.sources.length > 0 && !data.threads.length && !isFetching && <p className="small muted">No thread matches “{term}”.</p>}
            {(data?.threads as Json[] | undefined)?.map((t) => (
              <div key={`${t.source}|${t.key}`} className="panel spread" style={{ padding: 10, gap: 8 }}>
                <div className="small" style={{ minWidth: 0 }}>
                  <b>{t.subject}</b>
                  <div className="muted">
                    {t.count} message{t.count === 1 ? '' : 's'} found · last {date(t.last)}
                    {t.from ? ` · ${t.from}` : ''} · in {t.sourceLabel}
                  </div>
                </div>
                <button className="btn sm primary" disabled={!!busy} onClick={() => keep(t)}>
                  {busy === t.key ? 'Downloading…' : 'Keep the whole thread here'}
                </button>
              </div>
            ))}
          </>
        )}
      </div>
    </Modal>
  );
}
