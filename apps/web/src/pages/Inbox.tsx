/**
 * Shared inbox: WhatsApp and Instagram conversations, one thread per customer.
 * The 24-hour window decides what can be sent: free text inside it, approved templates outside.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Empty, Modal, Spinner, useToast } from '../components/ui';
import { get, patch, post } from '../lib/api';
import { useAuth } from '../lib/auth';
import { dateTime, initials, relative } from '../lib/format';
import { useUsers } from '../lib/hooks';

type Json = Record<string, any>;

export function InboxPage() {
  const [params, setParams] = useSearchParams();
  const [view, setView] = useState<'mine' | 'unassigned' | 'all'>('all');
  const [status, setStatus] = useState<'open' | 'pending' | 'closed'>('open');
  const [q, setQ] = useState('');
  const selected = params.get('c');
  const list = useQuery({
    queryKey: ['inbox', view, status, q],
    queryFn: () => get<{ items: Json[]; counts: Json }>(`/api/v1/inbox?view=${view}&status=${status}${q ? `&q=${encodeURIComponent(q)}` : ''}`),
    refetchInterval: 15_000,
  });
  const items = list.data?.items ?? [];
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Inbox</h1>
          <p>WhatsApp and Instagram conversations with your customers.</p>
        </div>
      </div>
      <div className={`inbox${selected ? ' has-thread' : ''}`}>
        <aside className="panel inbox-list">
          <div className="inbox-filters">
            <div className="seg" role="tablist" aria-label="Whose">
              {(
                [
                  ['mine', `Mine${list.data?.counts?.mine ? ` (${list.data.counts.mine})` : ''}`],
                  ['unassigned', `Unassigned${list.data?.counts?.unassigned ? ` (${list.data.counts.unassigned})` : ''}`],
                  ['all', 'All'],
                ] as const
              ).map(([k, l]) => (
                <button key={k} role="tab" aria-selected={view === k} onClick={() => setView(k)}>
                  {l}
                </button>
              ))}
            </div>
            <div className="row">
              <input placeholder="Search name or number" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search conversations" />
              <select value={status} onChange={(e) => setStatus(e.target.value as typeof status)} style={{ width: 'auto' }} aria-label="Status">
                <option value="open">Open</option>
                <option value="pending">Waiting</option>
                <option value="closed">Closed</option>
              </select>
            </div>
          </div>
          {!list.data ? (
            <Spinner />
          ) : !items.length ? (
            <Empty title="No conversations">Messages customers send to your WhatsApp number appear here.</Empty>
          ) : (
            <ul className="conv-list">
              {items.map((c) => (
                <li key={c.id}>
                  <button className={`conv${selected === c.id ? ' on' : ''}${c.unread ? ' unread' : ''}`} onClick={() => setParams({ c: c.id })}>
                    <span className={`avatar ch-${c.channel}`} aria-hidden="true">
                      {initials(c.record_name ?? c.display_name ?? c.address)}
                    </span>
                    <span className="conv-main">
                      <span className="spread">
                        <b>{c.record_name ?? c.display_name ?? `+${c.address}`}</b>
                        <span className="muted small">{relative(c.last_message_at)}</span>
                      </span>
                      <span className="conv-preview small">
                        {c.last_direction === 'out' && <span className="muted">You: </span>}
                        {c.last_preview}
                      </span>
                      <span className="row small" style={{ gap: 6 }}>
                        {c.unread > 0 && <span className="badge">{c.unread}</span>}
                        {c.assignee ? <span className="muted">{c.assignee}</span> : <span className="chip warn">Unassigned</span>}
                        {!c.windowOpen && c.channel === 'whatsapp' && <span className="muted" title="Over 24 hours since their last message: templates only">⏱ template only</span>}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </aside>
        <section className="panel inbox-thread">{selected ? <Thread id={selected} onBack={() => setParams({})} /> : <Empty title="Pick a conversation" />}</section>
      </div>
    </>
  );
}

function Ticks({ m }: { m: Json }) {
  if (m.direction !== 'out') return null;
  if (m.status === 'failed') return <span className="tick bad" title={m.error ?? 'Failed'}>!</span>;
  if (m.status === 'read') return <span className="tick read" title={`Read ${dateTime(m.read_at)}`}>✓✓</span>;
  if (m.status === 'delivered') return <span className="tick" title={`Delivered ${dateTime(m.delivered_at)}`}>✓✓</span>;
  if (m.status === 'sent') return <span className="tick" title="Sent">✓</span>;
  return <span className="tick" title="Sending">⏱</span>;
}

function Thread({ id, onBack }: { id: string; onBack: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { me } = useAuth();
  const users = useUsers();
  const t = useQuery({ queryKey: ['inbox-thread', id], queryFn: () => get<Json>(`/api/v1/inbox/${id}`), refetchInterval: 10_000 });
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' });
  }, [t.data?.messages?.length]);
  useEffect(() => {
    if (t.data?.unread) post(`/api/v1/inbox/${id}/read`).then(() => qc.invalidateQueries({ queryKey: ['inbox'] })).catch(() => undefined);
  }, [id, t.data?.unread, qc]);
  if (!t.data) return <Spinner />;
  const c = t.data;
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['inbox-thread', id] });
    qc.invalidateQueries({ queryKey: ['inbox'] });
  };
  const update = async (body: Json, ok: string) => {
    try {
      await patch(`/api/v1/inbox/${id}`, body);
      toast(ok);
      refresh();
    } catch (e) {
      toast((e as Error).message, true);
    }
  };
  return (
    <div className="thread">
      <header className="thread-head">
        <button className="btn sm ghost thread-back" onClick={onBack} aria-label="Back to conversations">
          ←
        </button>
        <div style={{ minWidth: 0 }}>
          <b>{c.record_name ?? c.display_name ?? `+${c.address}`}</b>
          <div className="muted small">
            +{c.address}
            {c.related_id && (
              <>
                {' · '}
                <Link to={`/o/${c.related_object}/${c.related_id}`}>Open {c.related_object}</Link>
              </>
            )}
          </div>
        </div>
        <div className="row" style={{ marginLeft: 'auto', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          <select value={c.assigned_to ?? ''} onChange={(e) => update({ assignedTo: e.target.value || null }, 'Assigned')} aria-label="Assigned to" style={{ width: 'auto' }}>
            <option value="">Unassigned</option>
            {users.data?.items.map((u) => (
              <option key={u.id} value={u.id}>
                {u.id === me?.user.id ? 'Me' : u.full_name}
              </option>
            ))}
          </select>
          {c.status !== 'closed' ? (
            <button className="btn sm" onClick={() => update({ status: 'closed' }, 'Conversation closed')}>
              Close
            </button>
          ) : (
            <button className="btn sm" onClick={() => update({ status: 'open' }, 'Reopened')}>
              Reopen
            </button>
          )}
        </div>
      </header>
      <div className="thread-body">
        {c.messages.map((m: Json) => (
          <div key={m.id} className={`bubble ${m.direction}${m.status === 'failed' ? ' failed' : ''}`}>
            {m.media && (
              <a className="media-link" href={`/api/v1/whatsapp/media/${m.id}`} onClick={(e) => openMedia(e, m.id)}>
                📎 {m.media.filename ?? m.media.type}
              </a>
            )}
            {m.body && <div className="pre-wrap">{m.body}</div>}
            <div className="bubble-meta">
              {m.campaign_id && <span className="chip">campaign</span>}
              {m.direction === 'out' && m.sent_by_name && <span>{m.sent_by_name}</span>}
              <span>{dateTime(m.created_at)}</span>
              <Ticks m={m} />
            </div>
            {m.status === 'failed' && m.error && <div className="small bad-text">{m.error}</div>}
          </div>
        ))}
        <div ref={end} />
      </div>
      <Composer conv={c} onSent={refresh} />
    </div>
  );
}

async function openMedia(e: React.MouseEvent, id: string) {
  // media needs the session: fetch it with the token, then open the blob
  e.preventDefault();
  const { download } = await import('../lib/api');
  await download(`/api/v1/whatsapp/media/${id}`, 'attachment').catch(() => undefined);
}

export function Composer({ conv, onSent, record }: { conv: Json | null; onSent: () => void; record?: { object: string; id: string; name?: string; windowOpen?: boolean; doc?: { kind: 'quote' | 'invoice' | 'sales_order'; id: string } } }) {
  const toast = useToast();
  const [text, setText] = useState('');
  const [tplId, setTplId] = useState('');
  const [values, setValues] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [attachDoc, setAttachDoc] = useState(!!record?.doc);
  const quick = useQuery({ queryKey: ['quick-replies'], queryFn: () => get<{ items: Json[] }>('/api/v1/quick-replies'), staleTime: 60_000 });
  const tpls = useQuery({ queryKey: ['wa-templates'], queryFn: () => get<{ items: Json[] }>('/api/v1/whatsapp/templates'), staleTime: 60_000, enabled: !conv || conv.channel === 'whatsapp' });
  const windowOpen = conv ? conv.windowOpen : !!record?.windowOpen;
  const tpl = tpls.data?.items.find((t) => t.id === tplId);
  const mode: 'text' | 'template' = windowOpen && !tplId ? 'text' : 'template';
  useEffect(() => {
    if (!tpl) return;
    const v = Array.from({ length: tpl.variable_count }, (_, i) => values[i] ?? (i === 0 ? (record?.name ?? conv?.record_name ?? conv?.display_name ?? '').split(' ')[0] ?? '' : ''));
    setValues(v);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tplId]);
  const slash = text.startsWith('/') ? text.slice(1).toLowerCase() : null;
  const matches = useMemo(() => (slash === null ? [] : (quick.data?.items ?? []).filter((r) => r.shortcut.startsWith(slash)).slice(0, 6)), [slash, quick.data]);
  const send = async () => {
    setBusy(true);
    try {
      const body = { ...(mode === 'text' ? { text } : { templateId: tplId, values }), ...(record?.doc && attachDoc ? { doc: record.doc } : {}) };
      if (conv) await post(`/api/v1/inbox/${conv.id}/messages`, body);
      else await post('/api/v1/whatsapp/send', { object: record!.object, id: record!.id, ...body });
      setText('');
      setTplId('');
      setValues([]);
      toast('Sent');
      onSent();
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  };
  if (conv?.channel === 'instagram' && !windowOpen) return <div className="composer muted small">Instagram allows replies only within 24 hours of the customer’s last message.</div>;
  return (
    <div className="composer">
      {!windowOpen && (!conv || conv.channel === 'whatsapp') && <div className="small window-note">It has been more than 24 hours since they last wrote, so WhatsApp only allows an approved template. Their reply reopens the chat.</div>}
      {windowOpen && conv?.windowClosesAt && <div className="small muted">Free replies until {dateTime(conv.windowClosesAt)}</div>}
      {(!conv || conv.channel === 'whatsapp') && (
        <div className="row">
          <select value={tplId} onChange={(e) => setTplId(e.target.value)} aria-label="Template" style={{ flex: 1 }}>
            <option value="">{windowOpen ? 'Free text (or pick a template)' : 'Choose a template…'}</option>
            {tpls.data?.items.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name} · {t.category === 'MARKETING' ? 'marketing' : 'utility'} · {t.language}
              </option>
            ))}
          </select>
        </div>
      )}
      {tpl && (
        <div className="tpl-fill">
          <div className="tpl-preview pre-wrap small">{String(tpl.body_text ?? '').replace(/\{\{(\d+)\}\}/g, (_: string, n: string) => values[Number(n) - 1] || `{{${n}}}`)}</div>
          {values.map((v, i) => (
            <label key={i} className="field">
              <span className="small">{`{{${i + 1}}}`}</span>
              <input
                value={v}
                placeholder={record?.doc && attachDoc && !v ? 'Document link goes here' : ''}
                onChange={(e) => setValues(values.map((x, j) => (j === i ? e.target.value : x)))}
              />
            </label>
          ))}
          {tpl.category === 'MARKETING' && <p className="muted small">Marketing templates go only to people who agreed to WhatsApp offers.</p>}
        </div>
      )}
      {mode === 'text' && (
        <div className="composer-box">
          {matches.length > 0 && (
            <ul className="quick-pick">
              {matches.map((r) => (
                <li key={r.id}>
                  <button onClick={() => setText(r.body)}>
                    <b>/{r.shortcut}</b> {r.title}
                  </button>
                </li>
              ))}
            </ul>
          )}
          <textarea
            rows={3}
            value={text}
            placeholder="Type a reply. Start with / for saved replies. Ctrl+Enter sends."
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && text.trim()) void send();
            }}
          />
        </div>
      )}
      <div className="spread">
        {record?.doc ? (
          <label className="check small">
            <input type="checkbox" checked={attachDoc} onChange={(e) => setAttachDoc(e.target.checked)} /> Include the document link
          </label>
        ) : (
          <span />
        )}
        <button className="btn primary" disabled={busy || (mode === 'text' ? !text.trim() && !(record?.doc && attachDoc) : !tpl || values.some((v, i) => !v.trim() && !(record?.doc && attachDoc && i === values.findIndex((x) => !x.trim()))))} onClick={send}>
          {busy ? 'Sending…' : 'Send'}
        </button>
      </div>
    </div>
  );
}

/** "WhatsApp" on a record: free text inside the 24-hour window, otherwise a template; documents go as links. */
export function WhatsAppButton({ object, id, name }: { object: string; id: string; name?: string }) {
  const [open, setOpen] = useState(false);
  const st = useQuery({ queryKey: ['wa-status', object, id], queryFn: () => get<Json>(`/api/v1/whatsapp/status?object=${object}&id=${id}`), staleTime: 30_000 });
  if (!st.data?.connected) return null;
  const doc = object === 'quote' || object === 'invoice' || object === 'sales_order' ? { kind: object as 'quote' | 'invoice' | 'sales_order', id } : undefined;
  return (
    <>
      <button className="btn" onClick={() => setOpen(true)}>
        WhatsApp
      </button>
      {open && (
        <WaModal title={`WhatsApp${name ? ` · ${name}` : ''}`} onClose={() => setOpen(false)}>
          {st.data.conversationId && (
            <p className="small">
              <Link to={`/inbox?c=${st.data.conversationId}`}>Open the conversation</Link>
            </p>
          )}
          <Composer conv={null} record={{ object, id, name, windowOpen: st.data.windowOpen, doc }} onSent={() => setOpen(false)} />
        </WaModal>
      )}
    </>
  );
}

function WaModal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <Modal title={title} onClose={onClose}>
      <div className="modal-body one">{children}</div>
    </Modal>
  );
}
