import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { ApiError, get, post } from '../lib/api';
import { useIntegrationStatus } from './MailboxPanel';
import { Modal, useToast } from './ui';

interface Template {
  id: string;
  name: string;
  object_key: string | null;
  category: string | null;
  subject: string;
  body: string;
  is_shared: boolean;
}

/**
 * Compose an email about a record: pick a template (merge fields are filled from the record),
 * edit, then send through the workspace email channel — or open it in the user's own mail app.
 */
export function EmailComposer({
  object,
  recordId,
  templateName,
  sendLabel = 'Send email',
  onClose,
  onSend,
}: {
  object: string;
  recordId: string;
  templateName?: string;
  sendLabel?: string;
  onClose: () => void;
  /** custom send (e.g. quotes); receives null when the user only wants to mark as sent */
  onSend?: (m: { to: string; subject: string; body: string } | null) => Promise<void>;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const { data } = useQuery({ queryKey: ['email-templates', object], queryFn: () => get<{ items: Template[] }>(`/api/v1/email-templates?object=${object}`) });
  const [templateId, setTemplateId] = useState('');
  const [to, setTo] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saveAs, setSaveAs] = useState('');
  const status = useIntegrationStatus();
  const boxes = (status.data?.mailboxes ?? []).filter((m) => m.status === 'active');
  const [from, setFrom] = useState('');

  const apply = async (id: string | null) => {
    try {
      const r = await post<{ subject: string; body: string; to: string }>('/api/v1/email-templates/render', id ? { templateId: id, object, recordId } : { subject: '', body: '', object, recordId });
      if (id) {
        setSubject(r.subject);
        setBody(r.body);
      }
      if (!to && r.to) setTo(r.to);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  // prefill the recipient, and the named template when given
  useEffect(() => {
    if (!data) return;
    const t = templateName ? data.items.find((x) => x.name === templateName) : undefined;
    if (t) {
      setTemplateId(t.id);
      void apply(t.id);
    } else void apply(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  const send = async () => {
    setBusy(true);
    setError(null);
    try {
      if (saveAs.trim()) {
        await post('/api/v1/email-templates', { name: saveAs.trim(), objectKey: object, subject, body, isShared: false }).catch(() => undefined);
        qc.invalidateQueries({ queryKey: ['email-templates'] });
      }
      if (onSend) await onSend({ to, subject, body });
      else {
        await post(`/api/v1/records/${object}/${recordId}/send-email`, { to, subject, body, templateId: templateId || null, fromMailboxId: from || null });
        toast('Email queued');
      }
      qc.invalidateQueries({ queryKey: ['timeline', object, recordId] });
      onClose();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not send');
    } finally {
      setBusy(false);
    }
  };

  const mailto = `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  const noChannel = !!error && /email channel/i.test(error);

  return (
    <Modal
      title={sendLabel}
      wide
      onClose={onClose}
      footer={
        <>
          {error && (
            <span className="field-error" style={{ marginRight: 'auto', maxWidth: 380 }}>
              {error}
            </span>
          )}
          <a className="btn" href={mailto} onClick={() => onSend && void onSend(null).then(onClose)} title="Opens your own email app with this message">
            Open in my mail app
          </a>
          <button className="btn primary" disabled={busy || noChannel || !/@/.test(to) || !subject.trim() || !body.trim()} onClick={send}>
            {busy ? 'Sending…' : sendLabel}
          </button>
        </>
      }
    >
      <div className="modal-body">
        <label className="field wide">
          Template
          <select
            value={templateId}
            onChange={(e) => {
              setTemplateId(e.target.value);
              if (e.target.value) void apply(e.target.value);
            }}
          >
            <option value="">Blank email</option>
            {data?.items.map((t) => (
              <option key={t.id} value={t.id}>
                {t.category ? `${t.category} · ` : ''}
                {t.name}
                {t.is_shared ? '' : ' (mine)'}
              </option>
            ))}
          </select>
        </label>
        {!onSend && boxes.length > 1 && (
          <label className="field wide">
            From
            <select value={from} onChange={(e) => setFrom(e.target.value)}>
              {boxes.map((m) => (
                <option key={m.id} value={m.primary ? '' : m.id}>
                  {m.account}
                  {m.primary ? ' (primary)' : ''}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="field wide">
          To
          <input type="email" value={to} onChange={(e) => setTo(e.target.value)} placeholder="name@company.in" />
        </label>
        <label className="field wide">
          Subject
          <input value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={300} />
        </label>
        <label className="field wide">
          Message
          <textarea rows={10} value={body} onChange={(e) => setBody(e.target.value)} />
        </label>
        <label className="field wide">
          Save as a new template (optional)
          <input value={saveAs} onChange={(e) => setSaveAs(e.target.value)} placeholder="Template name" maxLength={120} />
        </label>
      </div>
    </Modal>
  );
}
