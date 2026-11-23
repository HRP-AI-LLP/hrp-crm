/**
 * The project's WhatsApp chats: customers' one-to-one threads, project groups and exported chats,
 * read by the AI into suggestions — bugs, requirements, stories, tasks, change requests, calls,
 * questions and follow-ups — that become work with one click (or on their own in "auto").
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { unzipSync, strFromU8 } from 'fflate';
import { useState } from 'react';
import { del, get, patch, post } from '../../lib/api';
import { date } from '../../lib/format';
import { Empty, Modal, Spinner, useToast } from '../ui';
import { Guide } from '../admin/ConnectionKeys';

type Json = Record<string, any>;

const KIND_LABEL: Record<string, string> = {
  bug: 'Bug',
  requirement: 'Requirement',
  story: 'Story',
  task: 'Task',
  change_request: 'Change request',
  call: 'Call',
  question: 'Question to answer',
  follow_up: 'Follow-up',
};
const KIND_CHIP: Record<string, string> = { bug: 'bad', change_request: 'warn', requirement: 'good', story: 'good', call: '', question: 'warn', follow_up: '', task: '' };
const MODE: [string, string, string][] = [
  ['suggest', 'Suggest', 'the AI proposes; someone on the project creates each with one click'],
  ['auto', 'Create automatically', 'items the AI is fairly sure of become work at once (calls still need a time)'],
  ['off', 'Off', 'messages are kept, not read'],
];
const KIND_LINE: Record<string, string> = { contact: 'Customer chat', group: 'Project group', import: 'Exported chat' };
const when = (s: string | null | undefined) => (s ? new Date(s).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : '—');

function useAct() {
  const toast = useToast();
  return async <T,>(fn: () => Promise<T>, ok?: string): Promise<T | null> => {
    try {
      const r = await fn();
      if (ok) toast(ok);
      return r;
    } catch (e) {
      toast((e as Error).message, true);
      return null;
    }
  };
}

export function ProjectChats({ id }: { id: string }) {
  const { data, refetch } = useQuery({ queryKey: ['project-chats', id], queryFn: () => get<Json>(`/api/v1/projects/${id}/chats`), refetchInterval: 60_000 });
  const [modal, setModal] = useState<null | 'link' | 'group' | 'import'>(null);
  const [importInto, setImportInto] = useState<Json | null>(null);
  const [open, setOpen] = useState<Json | null>(null);
  const [show, setShow] = useState<'proposed' | 'done'>('proposed');
  const act = useAct();
  const toast = useToast();
  if (!data) return <Spinner />;
  const chats = data.chats as Json[];
  const props = (data.proposals as Json[]).filter((p) => (show === 'proposed' ? p.status === 'proposed' : p.status !== 'proposed'));
  const openCount = (data.proposals as Json[]).filter((p) => p.status === 'proposed').length;
  return (
    <div className="stack">
      <Guide id="project_whatsapp" />
      <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
        <div>
          <h3 className="section-label" style={{ margin: 0 }}>
            WhatsApp chats
          </h3>
          <div className="small muted">Customer chats and groups on this project. The AI reads what's new once a chat goes quiet and turns it into work.</div>
        </div>
        {data.canManage && (
          <div className="row" style={{ gap: 6 }}>
            <button className="btn primary" onClick={() => setModal('link')}>
              + Link a customer chat
            </button>
            <button className="btn" onClick={() => setModal('group')}>
              New project group
            </button>
            <button className="btn" onClick={() => (setImportInto(null), setModal('import'))}>
              Import an exported chat
            </button>
          </div>
        )}
      </div>

      {!chats.length ? (
        <Empty title="No chats yet">
          Link a customer's WhatsApp thread, make a project group, or upload a chat exported from any WhatsApp group (⋮ → More → Export chat).
        </Empty>
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Chat</th>
                <th>AI</th>
                <th className="num">Messages</th>
                <th>Last message</th>
                <th className="num">To review</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {chats.map((c) => (
                <tr key={c.id} className="click" onClick={() => setOpen(c)}>
                  <td>
                    <b>{c.title}</b>
                    <div className="small muted">
                      {KIND_LINE[c.kind]}
                      {c.address && c.kind === 'contact' ? ` · +${c.address}` : ''}
                      {c.group_pending ? ' · WhatsApp is creating the group…' : ''}
                    </div>
                    {c.invite_link && (
                      <div className="small">
                        Invite link:{' '}
                        <a href={c.invite_link} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
                          {c.invite_link}
                        </a>
                      </div>
                    )}
                    {c.last_error && <div className="small" style={{ color: 'var(--bad)' }}>{c.last_error}</div>}
                  </td>
                  <td onClick={(e) => e.stopPropagation()}>
                    {data.canManage ? (
                      <select style={{ minWidth: 170 }} value={c.mode} onChange={async (e) => (await act(() => patch(`/api/v1/projects/${id}/chats/${c.id}`, { mode: e.target.value }), 'Saved')) !== null && refetch()}>
                        {MODE.map(([k, l]) => (
                          <option key={k} value={k}>
                            {l}
                          </option>
                        ))}
                      </select>
                    ) : (
                      MODE.find((m) => m[0] === c.mode)?.[1]
                    )}
                  </td>
                  <td className="num">{c.messages}</td>
                  <td>
                    {when(c.last_message_at)}
                    <div className="small muted">{c.pending_since ? <span className="chip warn">new — AI reads it soon</span> : c.last_analysed_at ? `read ${when(c.last_analysed_at)}` : ''}</div>
                  </td>
                  <td className="num">{c.open_proposals ? <span className="chip warn">{c.open_proposals}</span> : '—'}</td>
                  <td className="nowrap" onClick={(e) => e.stopPropagation()}>
                    {data.canAct && (
                      <button
                        className="btn small"
                        title="Read what's new now instead of waiting for the chat to go quiet"
                        onClick={async () => {
                          const r = await act(() => post<Json>(`/api/v1/projects/${id}/chats/${c.id}/analyse`));
                          if (r) {
                            refetch();
                            toast(r.proposals ? `${r.proposals} new from the chat${r.created ? ` (${r.created} created)` : ''}` : 'Nothing new to act on');
                          }
                        }}
                      >
                        Read now
                      </button>
                    )}{' '}
                    {c.kind === 'import' && data.canManage && (
                      <button className="btn small" onClick={() => (setImportInto(c), setModal('import'))}>
                        Upload newer export
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="row" style={{ justifyContent: 'space-between', marginTop: 8 }}>
        <h3 className="section-label" style={{ margin: 0 }}>
          From the chats
        </h3>
        <div className="seg">
          <button aria-pressed={show === 'proposed'} onClick={() => setShow('proposed')}>
            To review ({openCount})
          </button>
          <button aria-pressed={show === 'done'} onClick={() => setShow('done')}>
            Handled (30 days)
          </button>
        </div>
      </div>
      {!props.length ? (
        <p className="small muted">{show === 'proposed' ? 'Nothing waiting. New suggestions appear here when the AI has read a chat.' : 'Nothing handled in the last 30 days.'}</p>
      ) : (
        <div className="stack" style={{ gap: 8 }}>
          {props.map((p) => (
            <Proposal key={p.id} p={p} projectId={id} canAct={data.canAct} onDone={refetch} />
          ))}
        </div>
      )}

      {modal === 'link' && <LinkChat projectId={id} onClose={() => setModal(null)} onDone={refetch} />}
      {modal === 'group' && <NewGroup projectId={id} onClose={() => setModal(null)} onDone={refetch} />}
      {modal === 'import' && <ImportChat projectId={id} chat={importInto} onClose={() => setModal(null)} onDone={refetch} />}
      {open && <ChatView projectId={id} chat={open} canManage={data.canManage} onClose={() => setOpen(null)} onChanged={refetch} />}
    </div>
  );
}

function Proposal({ p, projectId, canAct, onDone }: { p: Json; projectId: string; canAct: boolean; onDone: () => void }) {
  const act = useAct();
  const [edit, setEdit] = useState<Json | null>(null);
  const [busy, setBusy] = useState(false);
  const accept = async (body: Json = {}) => {
    setBusy(true);
    const r = await act(() => post<Json>(`/api/v1/projects/${projectId}/chat-proposals/${p.id}/accept`, body), 'Created');
    setBusy(false);
    if (r) (setEdit(null), onDone());
  };
  const startsLocal = (s: string | null) => (s ? new Date(new Date(s).getTime() - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 16) : '');
  return (
    <div className="panel" style={{ padding: 10 }}>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
        <div style={{ minWidth: 0 }}>
          <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
            <span className={`chip ${KIND_CHIP[p.kind] ?? ''}`}>{KIND_LABEL[p.kind] ?? p.kind}</span>
            <b>{p.title}</b>
            {p.priority === 'high' && <span className="chip bad">high</span>}
            {!p.ai && <span className="chip" title="Found by keyword rules (the AI was not available)">rules</span>}
          </div>
          {p.detail && <div className="small" style={{ marginTop: 4 }}>{p.detail}</div>}
          {p.quote && (
            <div className="small muted" style={{ marginTop: 4, borderLeft: '3px solid var(--line)', paddingLeft: 8 }}>
              “{p.quote}”
            </div>
          )}
          <div className="small muted" style={{ marginTop: 4 }}>
            {p.chat_title}
            {p.requested_by ? ` · ${p.requested_by}` : ''}
            {p.message_at ? ` · ${when(p.message_at)}` : ''}
            {p.due ? ` · due ${date(p.due)}` : ''}
            {p.starts_at ? ` · ${when(p.starts_at)}` : ''}
            {p.status === 'proposed' ? ` · ${Math.round(p.confidence * 100)}% sure` : ''}
          </div>
        </div>
        <div className="row nowrap" style={{ gap: 6 }}>
          {p.status === 'created' ? (
            <span className="chip good">
              {p.created_key ?? 'Created'}
              {p.created_object === 'call' ? ' · call scheduled' : p.created_object === 'action_item' ? ' · on the to-do list' : ''}
            </span>
          ) : p.status === 'dismissed' ? (
            <span className="chip">Dismissed</span>
          ) : canAct ? (
            <>
              <button className="btn small primary" disabled={busy} onClick={() => (p.kind === 'call' && !p.starts_at ? setEdit({ ...p, startsAt: '' }) : accept())}>
                {p.kind === 'call' ? 'Schedule' : p.kind === 'question' || p.kind === 'follow_up' ? 'Add to-do' : 'Create'}
              </button>
              <button className="btn small" disabled={busy} onClick={() => setEdit({ ...p, startsAt: startsLocal(p.starts_at) })}>
                Edit…
              </button>
              <button className="btn small ghost" disabled={busy} onClick={async () => (await act(() => post(`/api/v1/projects/${projectId}/chat-proposals/${p.id}/dismiss`))) !== null && onDone()}>
                Dismiss
              </button>
            </>
          ) : null}
        </div>
      </div>
      {edit && (
        <Modal
          title="Before creating"
          onClose={() => setEdit(null)}
          footer={
            <button
              className="btn primary"
              disabled={busy || !edit.title.trim() || (edit.kind === 'call' && !edit.startsAt)}
              onClick={() =>
                accept({
                  kind: edit.kind,
                  title: edit.title.trim(),
                  detail: edit.detail || null,
                  priority: edit.priority,
                  due: edit.due ? String(edit.due).slice(0, 10) : null,
                  ...(edit.kind === 'call' && edit.startsAt ? { startsAt: new Date(edit.startsAt).toISOString() } : {}),
                })
              }
            >
              {edit.kind === 'call' ? 'Schedule the call' : 'Create'}
            </button>
          }
        >
          <div className="modal-body stack">
            <label className="field">
              Make it a
              <select value={edit.kind} onChange={(e) => setEdit({ ...edit, kind: e.target.value })}>
                {Object.entries(KIND_LABEL).map(([k, l]) => (
                  <option key={k} value={k}>
                    {l}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              Title
              <input value={edit.title} onChange={(e) => setEdit({ ...edit, title: e.target.value })} />
            </label>
            <label className="field">
              Details
              <textarea rows={4} value={edit.detail ?? ''} onChange={(e) => setEdit({ ...edit, detail: e.target.value })} />
            </label>
            <div className="grid2">
              <label className="field">
                Priority
                <select value={edit.priority} onChange={(e) => setEdit({ ...edit, priority: e.target.value })}>
                  <option value="high">High</option>
                  <option value="medium">Medium</option>
                  <option value="low">Low</option>
                </select>
              </label>
              {edit.kind === 'call' ? (
                <label className="field">
                  When
                  <input type="datetime-local" value={edit.startsAt} onChange={(e) => setEdit({ ...edit, startsAt: e.target.value })} />
                </label>
              ) : (
                <label className="field">
                  Due
                  <input type="date" value={edit.due ? String(edit.due).slice(0, 10) : ''} onChange={(e) => setEdit({ ...edit, due: e.target.value })} />
                </label>
              )}
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

function ModeChoice({ mode, set }: { mode: string; set: (m: string) => void }) {
  return (
    <div className="field">
      What the AI does
      {MODE.map(([k, l, d]) => (
        <label key={k} className="row small" style={{ gap: 6, alignItems: 'flex-start' }}>
          <input type="radio" checked={mode === k} onChange={() => set(k)} />
          <span>
            <strong>{l}</strong> — {d}
          </span>
        </label>
      ))}
    </div>
  );
}

function LinkChat({ projectId, onClose, onDone }: { projectId: string; onClose: () => void; onDone: () => void }) {
  const { data } = useQuery({ queryKey: ['project-chats', projectId, 'choices'], queryFn: () => get<Json>(`/api/v1/projects/${projectId}/chats/choices`) });
  const [q, setQ] = useState('');
  const [pick, setPick] = useState<Json | null>(null);
  const [mode, setMode] = useState('suggest');
  const [history, setHistory] = useState(true);
  const [account, setAccount] = useState('');
  const act = useAct();
  if (!data) return null;
  const ql = q.trim().toLowerCase();
  const convs = (data.conversations as Json[]).filter((c) => !ql || `${c.display_name ?? ''} ${c.address}`.toLowerCase().includes(ql));
  const groups = (data.groups as Json[]).filter((g) => g.group_id && !g.linked_to);
  const people = ((data.contacts ?? []) as Json[]).filter((c) => !ql || `${c.full_name} ${c.number} ${c.account ?? ''}`.toLowerCase().includes(ql));
  return (
    <Modal
      title="Link a customer chat"
      onClose={onClose}
      wide
      footer={
        <button
          className="btn primary"
          disabled={!pick}
          onClick={async () => {
            const target = pick!.group ? { waGroupId: pick!.id } : pick!.contact ? { contactId: pick!.id, channelAccountId: account || null } : { conversationId: pick!.id };
            const r = await act(() => post<Json>(`/api/v1/projects/${projectId}/chats`, { ...target, mode, readHistory: history }), 'Linked');
            if (r) (onDone(), onClose());
          }}
        >
          Link
        </button>
      }
    >
      <div className="modal-body stack">
        {!data.accounts.length ? (
          <div className="callout warn small">
            No WhatsApp Business number is connected yet (Settings → Channels → WhatsApp). Until then, use <b>Import an exported chat</b>.
          </div>
        ) : (
          <>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Search ${data.conversations.length} WhatsApp chats and ${(data.contacts ?? []).length} contacts by name or number…`} />
            <p className="small muted" style={{ margin: 0 }}>
              Chats appear here once someone writes to your WhatsApp Business number{data.accounts.length > 1 ? 's' : ''} — WhatsApp does not share your phone's older chats or contact list. Contacts with a mobile number can be linked now; the first message to them must be an approved template.
            </p>
            <div className="repo-pick" style={{ maxHeight: 320, overflowY: 'auto' }}>
              {groups.map((g) => (
                <label key={g.id} className="repo-opt row small" style={{ gap: 8 }}>
                  <input type="radio" name="chat" checked={pick?.id === g.id} onChange={() => setPick({ ...g, group: true })} />
                  <b>{g.subject ?? 'WhatsApp group'}</b> <span className="chip">group</span>
                </label>
              ))}
              {convs.map((c) => (
                <label key={c.id} className="repo-opt row small" style={{ gap: 8, opacity: c.linked_here ? 0.6 : 1 }}>
                  <input type="radio" name="chat" disabled={c.linked_here} checked={pick?.id === c.id} onChange={() => setPick(c)} />
                  <span>
                    <b>{c.display_name ?? `+${c.address}`}</b> <span className="muted">+{c.address}</span>
                    {c.linked_here && <span className="chip good" style={{ marginLeft: 6 }}>on this project</span>}
                    {c.linked_elsewhere && <span className="muted"> · also on {c.linked_elsewhere}</span>}
                    <div className="muted">
                      {when(c.last_message_at)} · {c.last_preview}
                    </div>
                  </span>
                </label>
              ))}
              {people.length > 0 && <div className="small muted" style={{ padding: '6px 4px 2px', fontWeight: 600 }}>Contacts not on WhatsApp chat yet</div>}
              {people.map((c) => (
                <label key={`c-${c.id}`} className="repo-opt row small" style={{ gap: 8 }}>
                  <input type="radio" name="chat" checked={pick?.contact && pick.id === c.id} onChange={() => setPick({ ...c, contact: true })} />
                  <span>
                    <b>{c.full_name}</b> <span className="muted">+{c.number}</span>
                    {c.of_customer && <span className="chip info" style={{ marginLeft: 6 }}>project's customer</span>}
                    {c.account && <div className="muted">{c.account}</div>}
                  </span>
                </label>
              ))}
              {!convs.length && !groups.length && !people.length && <span className="muted small">No chats yet: they appear once a customer writes to your WhatsApp Business number. Add a mobile number to the customer's contacts to link them before they write.</span>}
            </div>
          </>
        )}
        {pick?.contact && data.accounts.length > 1 && (
          <label className="field">
            Chat from
            <select value={account || data.accounts[0].id} onChange={(e) => setAccount(e.target.value)}>
              {(data.accounts as Json[]).map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <ModeChoice mode={mode} set={setMode} />
        <label className="row small" style={{ gap: 6 }}>
          <input type="checkbox" checked={history} onChange={(e) => setHistory(e.target.checked)} /> Also read the last 30 days of the chat now
        </label>
        <p className="small muted" style={{ margin: 0 }}>
          A chat can be on more than one project; a project can have any number of chats.
        </p>
      </div>
    </Modal>
  );
}

function NewGroup({ projectId, onClose, onDone }: { projectId: string; onClose: () => void; onDone: () => void }) {
  const { data } = useQuery({ queryKey: ['project-chats', projectId, 'choices'], queryFn: () => get<Json>(`/api/v1/projects/${projectId}/chats/choices`) });
  const [f, setF] = useState({ channelAccountId: '', subject: '', description: '', mode: 'suggest' });
  const act = useAct();
  if (!data) return null;
  const acc = f.channelAccountId || data.accounts[0]?.id || '';
  return (
    <Modal
      title="New WhatsApp group for the project"
      onClose={onClose}
      footer={
        <button
          className="btn primary"
          disabled={!acc || !f.subject.trim()}
          onClick={async () => {
            const r = await act(() => post<Json>(`/api/v1/projects/${projectId}/chats/group`, { ...f, channelAccountId: acc, subject: f.subject.trim(), description: f.description || null }), 'Group requested');
            if (r) (onDone(), onClose());
          }}
        >
          Create the group
        </button>
      }
    >
      <div className="modal-body stack">
        <div className="callout small">
          Made on your WhatsApp Business number through WhatsApp's Groups API: up to 8 people, who join with an invite link (shown here once WhatsApp confirms the group). It needs an Official Business Account; the number must not be in the WhatsApp Business app. For groups that already exist on someone's phone, use <b>Import an exported chat</b>.
        </div>
        {!data.accounts.length ? (
          <div className="callout warn small">Connect a WhatsApp Business number first (Settings → Channels → WhatsApp).</div>
        ) : (
          <>
            {data.accounts.length > 1 && (
              <label className="field">
                Number
                <select value={acc} onChange={(e) => setF({ ...f, channelAccountId: e.target.value })}>
                  {data.accounts.map((a: Json) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label className="field">
              Group name
              <input maxLength={128} value={f.subject} onChange={(e) => setF({ ...f, subject: e.target.value })} placeholder="e.g. Fleet portal — HRP AI" />
            </label>
            <label className="field">
              Description (optional)
              <textarea rows={2} maxLength={2048} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
            </label>
            <ModeChoice mode={f.mode} set={(mode) => setF({ ...f, mode })} />
          </>
        )}
      </div>
    </Modal>
  );
}

/** The .txt of an export, or the .txt inside its .zip (opened here; media files stay on this computer). */
async function exportText(file: File) {
  if (/\.zip$/i.test(file.name) || file.type.includes('zip')) {
    const files = unzipSync(new Uint8Array(await file.arrayBuffer()), { filter: (f) => /\.txt$/i.test(f.name) });
    const txt = Object.entries(files).sort((a, b) => b[1].length - a[1].length)[0];
    if (!txt) throw new Error('No chat .txt inside this .zip');
    return strFromU8(txt[1]);
  }
  return file.text();
}

function ImportChat({ projectId, chat, onClose, onDone }: { projectId: string; chat: Json | null; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({ title: '', team: '', mode: 'suggest' });
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Json | null>(null);
  const act = useAct();
  const qc = useQueryClient();
  return (
    <Modal
      title={chat ? `Newer export of “${chat.title}”` : 'Import an exported chat'}
      onClose={onClose}
      footer={
        result ? (
          <button className="btn primary" onClick={onClose}>
            Done
          </button>
        ) : (
          <button
            className="btn primary"
            disabled={busy || !file || (!chat && !f.title.trim())}
            onClick={async () => {
              setBusy(true);
              const r = await act(async () => {
                const text = await exportText(file!);
                return post<Json>(`/api/v1/projects/${projectId}/chats/import`, {
                  chatId: chat?.id ?? null,
                  title: chat ? null : f.title.trim(),
                  mode: f.mode,
                  text,
                  teamNames: f.team.split(',').map((s) => s.trim()).filter(Boolean),
                  offsetMinutes: -new Date().getTimezoneOffset(),
                });
              });
              setBusy(false);
              if (r) {
                setResult(r);
                onDone();
                qc.invalidateQueries({ queryKey: ['project-chats', projectId] });
              }
            }}
          >
            {busy ? 'Reading…' : 'Import'}
          </button>
        )
      }
    >
      <div className="modal-body stack">
        {result ? (
          <p>
            Read {result.read} messages ({date(result.from)} – {date(result.to)}): <b>{result.added} new</b>
            {result.skipped ? `, ${result.skipped} already here` : ''}. The AI reads the new ones in a few minutes — or press <b>Read now</b>.
          </p>
        ) : (
          <>
            <ol className="small" style={{ margin: 0, paddingLeft: 18 }}>
              <li>On the phone, open the WhatsApp group or chat → ⋮ (or the name, on iPhone) → More → <b>Export chat</b> → Without media.</li>
              <li>Send the file to yourself (mail, Drive) and choose it below — the .zip or the .txt.</li>
              <li>Later, export again and use <b>Upload newer export</b>: only new messages are added.</li>
            </ol>
            {!chat && (
              <label className="field">
                Name of the chat
                <input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder="e.g. Fleet portal — client group" />
              </label>
            )}
            <label className="field">
              Export file (.zip or .txt)
              <input type="file" accept=".zip,.txt,text/plain,application/zip" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            </label>
            <label className="field">
              Names in the chat who are on our side (comma-separated)
              <input value={f.team} onChange={(e) => setF({ ...f, team: e.target.value })} placeholder="Names as they appear in the chat; colleagues' names are matched already" />
            </label>
            {!chat && <ModeChoice mode={f.mode} set={(mode) => setF({ ...f, mode })} />}
          </>
        )}
      </div>
    </Modal>
  );
}

function ChatView({ projectId, chat, canManage, onClose, onChanged }: { projectId: string; chat: Json; canManage: boolean; onClose: () => void; onChanged: () => void }) {
  const { data } = useQuery({ queryKey: ['project-chats', projectId, chat.id, 'messages'], queryFn: () => get<Json[]>(`/api/v1/projects/${projectId}/chats/${chat.id}/messages`) });
  const act = useAct();
  return (
    <Modal
      title={chat.title}
      onClose={onClose}
      wide
      footer={
        canManage ? (
          <button
            className="btn danger"
            onClick={async () => {
              if (!window.confirm(`Take “${chat.title}” off the project? Its suggestions go too; work already created stays.`)) return;
              if ((await act(() => del(`/api/v1/projects/${projectId}/chats/${chat.id}`), 'Removed')) !== null) (onChanged(), onClose());
            }}
          >
            Take off the project
          </button>
        ) : null
      }
    >
      <div className="modal-body">
        {!data ? (
          <Spinner />
        ) : !data.length ? (
          <p className="muted small">No messages yet.</p>
        ) : (
          <div className="stack" style={{ gap: 6, maxHeight: '60vh', overflowY: 'auto' }}>
            {[...data].reverse().map((m) => (
              <div key={m.id} style={{ alignSelf: m.side === 'team' ? 'flex-end' : 'flex-start', maxWidth: '80%', background: m.side === 'team' ? 'var(--accent-soft)' : 'var(--bg-2, #f4f5f7)', borderRadius: 10, padding: '6px 10px' }}>
                <div className="small muted">
                  {m.sender} · {when(m.at)}
                </div>
                <div style={{ whiteSpace: 'pre-wrap' }}>{m.body}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </Modal>
  );
}
