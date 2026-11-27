/**
 * The workspace assistant: ask anything about the workspace, or ask it to do something. It reads
 * as you, and every change it suggests appears as a card you approve (or edit, or reject) before
 * it runs — as you, with your permissions.
 *
 *   AssistantLauncher  the ✦ button on every page, opening a side panel
 *   AssistantPage      /assistant: all your chats
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { del, get, post, upload } from '../../lib/api';
import { relative } from '../../lib/format';
import { Markdown } from '../Markdown';
import { Spinner, useToast } from '../ui';

type Json = Record<string, any>;
type Thread = { thread: Json; messages: Json[]; actions: Json[] };

const SUGGESTIONS = [
  'I have an idea for an app — build it for me (attach any notes or sketches with 📎)',
  'What is due this week across my projects?',
  'Plan the next sprint for my project from the backlog',
  'Which leads have I not followed up on in 7 days?',
  'Create a milestone for UAT sign-off next Friday',
  'Summarise the open bugs reported on WhatsApp',
  'Log 2 hours today on my current task',
];

function Steps({ steps }: { steps?: Json[] }) {
  if (!steps?.length) return null;
  const finds = steps.filter((s) => s.kind === 'find').length;
  const reads = steps.filter((s) => s.kind === 'read');
  const failed = reads.filter((s) => s.status && s.status >= 400).length;
  return (
    <div className="asst-steps" title={steps.map((s) => (s.kind === 'find' ? `searched "${s.detail}"` : `read ${s.detail} (${s.status})`)).join('\n')}>
      {reads.length ? `Looked at ${reads.length} thing${reads.length === 1 ? '' : 's'}` : 'Searched'}
      {finds ? ` · searched ${finds}×` : ''}
      {failed ? ` · ${failed} not accessible` : ''}
    </div>
  );
}

function ActionCard({ a, busy, onApprove, onReject }: { a: Json; busy: boolean; onApprove: (body?: unknown) => void; onReject: () => void }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(() => (a.body == null ? '' : JSON.stringify(a.body, null, 2)));
  const [bad, setBad] = useState(false);
  const pending = a.status === 'proposed';
  const verb = { POST: 'Create', PUT: 'Update', PATCH: 'Change', DELETE: 'Delete' }[a.method as string] ?? a.method;
  const approve = () => {
    if (!open || a.body == null) return onApprove();
    try {
      onApprove(text.trim() ? JSON.parse(text) : null);
    } catch {
      setBad(true);
    }
  };
  return (
    <div className={`asst-action ${a.status}`}>
      <div className="spread" style={{ gap: 8, alignItems: 'flex-start' }}>
        <div style={{ minWidth: 0 }}>
          <span className={`chip ${a.method === 'DELETE' ? 'bad' : 'info'}`}>{verb}</span> <b>{a.summary}</b>
          <div className="muted small asst-path">
            {a.method} {a.path}
          </div>
        </div>
        {a.status !== 'proposed' && (
          <span className={`chip ${a.status === 'done' ? 'good' : a.status === 'failed' ? 'bad' : ''}`}>{a.status === 'done' ? '✓ done' : a.status === 'failed' ? 'failed' : a.status === 'running' ? 'running…' : 'rejected'}</span>
        )}
      </div>
      {a.error && <div className="small" style={{ color: 'var(--bad)' }}>{a.error}</div>}
      {a.body != null && (
        <button type="button" className="link-btn small" onClick={() => setOpen(!open)}>
          {open ? 'Hide details' : pending ? 'Details / edit' : 'Details'}
        </button>
      )}
      {open &&
        (pending ? (
          <>
            <textarea className="asst-json" rows={Math.min(14, text.split('\n').length + 1)} value={text} onChange={(e) => (setText(e.target.value), setBad(false))} spellCheck={false} />
            {bad && <div className="small" style={{ color: 'var(--bad)' }}>That is not valid JSON.</div>}
          </>
        ) : (
          <pre className="asst-json">{text}</pre>
        ))}
      {pending && (
        <div className="row" style={{ gap: 6 }}>
          <button className={`btn sm ${a.method === 'DELETE' ? 'danger' : 'primary'}`} disabled={busy} onClick={approve}>
            Approve
          </button>
          <button className="btn sm ghost" disabled={busy} onClick={onReject}>
            Reject
          </button>
        </div>
      )}
    </div>
  );
}

/* ─── Voice: dictation in, spoken replies out (Web Speech API, when the browser has it) ─── */
const SR: any = typeof window !== 'undefined' ? (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition : undefined;
const SYNTH: SpeechSynthesis | undefined = typeof window !== 'undefined' ? window.speechSynthesis : undefined;
// strip markdown/links so the reply is read aloud as plain speech
const plainForSpeech = (s: string) =>
  s
    .replace(/```[\s\S]*?```/g, ' code block ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_`#>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

/** Push-to-talk dictation. Appends what it hears to whatever is already typed. */
function useDictation(onText: (append: string) => void) {
  const [listening, setListening] = useState(false);
  const recRef = useRef<any>(null);
  useEffect(() => () => { try { recRef.current?.stop(); } catch { /* noop */ } }, []);
  const toggle = () => {
    if (!SR) return;
    if (listening) { try { recRef.current?.stop(); } catch { /* noop */ } return; }
    const rec = new SR();
    rec.lang = navigator.language || 'en-IN';
    rec.interimResults = false;
    rec.continuous = false;
    rec.onresult = (e: any) => {
      const said = Array.from(e.results).map((r: any) => r[0].transcript).join(' ').trim();
      if (said) onText(said);
    };
    rec.onend = () => setListening(false);
    rec.onerror = () => setListening(false);
    recRef.current = rec;
    try { rec.start(); setListening(true); } catch { setListening(false); }
  };
  return { supported: !!SR, listening, toggle };
}

/** Read assistant replies aloud when the viewer turns it on. The choice sticks per browser. */
function useSpeech() {
  const [on, setOn] = useState(() => {
    try { return localStorage.getItem('asst-speak') === '1'; } catch { return false; }
  });
  useEffect(() => {
    try { localStorage.setItem('asst-speak', on ? '1' : '0'); } catch { /* noop */ }
    if (!on) SYNTH?.cancel();
  }, [on]);
  useEffect(() => () => SYNTH?.cancel(), []);
  const speak = (text: string) => {
    if (!on || !SYNTH || !text.trim()) return;
    SYNTH.cancel();
    const u = new SpeechSynthesisUtterance(plainForSpeech(text).slice(0, 4000));
    u.lang = navigator.language || 'en-IN';
    SYNTH.speak(u);
  };
  return { supported: !!SYNTH, on, setOn, speak, cancel: () => SYNTH?.cancel() };
}

/** One chat: messages, change cards, and the box to type in. */
export function AssistantChat({ threadId, onThread, compact }: { threadId: string | null; onThread: (id: string | null) => void; compact?: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const loc = useLocation();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [pendingText, setPendingText] = useState<string | null>(null);
  const [files, setFiles] = useState<{ id: string; name: string }[]>([]);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const end = useRef<HTMLDivElement>(null);
  const attach = async (list: FileList | null) => {
    if (!list?.length) return;
    setUploading(true);
    try {
      for (const f of Array.from(list)) {
        if (f.size > 25 * 1024 * 1024) {
          toast(`${f.name} is over 25 MB`, true);
          continue;
        }
        const r = await upload<{ id: string; name: string }>(`/api/v1/sdlc/studio/files?name=${encodeURIComponent(f.name)}`, f);
        setFiles((x) => [...x, { id: r.id, name: r.name }]);
      }
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };
  const dictation = useDictation((said) => setText((t) => (t ? `${t} ${said}` : said)));
  const speech = useSpeech();
  const spokenRef = useRef<string | null>(null);
  const { data, isLoading } = useQuery({ queryKey: ['assistant', threadId], queryFn: () => get<Thread>(`/api/v1/assistant/threads/${threadId}`), enabled: !!threadId });
  const set = (t: Thread) => qc.setQueryData(['assistant', t.thread.id], t);
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' });
  }, [data, pendingText, busy]);
  // read the newest assistant reply aloud, once, when speak-aloud is on
  useEffect(() => {
    if (!speech.on || busy) return;
    const last = [...(data?.messages ?? [])].reverse().find((m) => m.role === 'assistant' && !m.data?.error);
    if (last && last.id !== spokenRef.current) {
      spokenRef.current = last.id;
      speech.speak(String(last.content));
    }
  }, [data, busy, speech.on]);

  const send = async (msg: string) => {
    const m = msg.trim();
    if (!m || busy) return;
    setBusy(true);
    setPendingText(m);
    setText('');
    const sent = files;
    setFiles([]);
    try {
      const t = await post<Thread>('/api/v1/assistant/chat', { threadId, message: m, page: loc.pathname, ...(sent.length ? { attachments: sent } : {}) });
      set(t);
      if (t.thread.id !== threadId) onThread(t.thread.id);
      qc.invalidateQueries({ queryKey: ['assistant-threads'] });
    } catch (e) {
      toast((e as Error).message, true);
      setText(m);
      setFiles(sent);
    } finally {
      setBusy(false);
      setPendingText(null);
    }
  };
  const decide = async (a: Json, ok: boolean, body?: unknown) => {
    setBusy(true);
    try {
      const r = await post<Json>(`/api/v1/assistant/actions/${a.id}/${ok ? 'approve' : 'reject'}`, ok && body !== undefined ? { body } : {});
      if (ok && r.status === 'failed') toast(`Didn't work: ${r.error ?? 'error'}`, true);
      // refresh what the change touched, then let the assistant carry on once nothing is waiting
      qc.invalidateQueries({ predicate: (q) => q.queryKey[0] !== 'assistant' });
      const t = await get<Thread>(`/api/v1/assistant/threads/${threadId}`);
      set(t);
      if (!t.actions.some((x) => x.status === 'proposed')) {
        const n = await post<Thread>(`/api/v1/assistant/threads/${threadId}/continue`, { page: loc.pathname });
        set(n);
      }
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  };
  const approveAll = async (list: Json[]) => {
    for (const a of list.slice(0, -1)) {
      try {
        await post(`/api/v1/assistant/actions/${a.id}/approve`, {});
      } catch (e) {
        toast((e as Error).message, true);
      }
    }
    await decide(list[list.length - 1]!, true);
  };

  const messages = (data?.messages ?? []).filter((m) => m.role !== 'tool');
  const byMsg = new Map<string, Json[]>();
  for (const a of data?.actions ?? []) byMsg.set(a.message_id, [...(byMsg.get(a.message_id) ?? []), a]);
  const empty = !threadId && !pendingText;
  return (
    <div className={`asst-chat ${compact ? 'compact' : ''}`}>
      <div className="asst-scroll">
        {empty && (
          <div className="asst-empty">
            <div className="asst-hello">✦</div>
            <b>Ask about anything in your workspace, or ask me to do it.</b>
            <p className="muted small">I read what you can read. Anything I change — tasks, sprints, milestones, leads, invoices — waits for your approval and runs as you.</p>
            <div className="asst-suggest">
              {SUGGESTIONS.map((s) => (
                <button key={s} className="chip" onClick={() => send(s)}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
        {threadId && isLoading && <Spinner />}
        {messages.map((m) => {
          const acts = byMsg.get(m.id) ?? [];
          const waiting = acts.filter((a) => a.status === 'proposed');
          return (
            <div key={m.id} className={`asst-msg ${m.role}`}>
              {m.role === 'user' ? (
                <div className="asst-bubble">
                  {String(m.content).split('\n\n[Attached files')[0]}
                  {(m.data?.attachments as Json[] | undefined)?.length ? (
                    <div className="row" style={{ gap: 4, flexWrap: 'wrap', marginTop: 6 }}>
                      {(m.data.attachments as Json[]).map((a) => (
                        <span key={a.id} className="chip">
                          📎 {a.name}
                        </span>
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : (
                <div className="asst-answer">
                  <Steps steps={m.data?.steps} />
                  <div className={m.data?.error ? 'notice small' : 'asst-md'}>
                    <Markdown source={m.content} />
                  </div>
                  {(m.data?.links as Json[] | undefined)?.length ? (
                    <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                      {(m.data.links as Json[]).map((l) => (
                        <Link key={l.to} className="btn sm ghost" to={l.to}>
                          {l.label} →
                        </Link>
                      ))}
                    </div>
                  ) : null}
                  {acts.map((a) => (
                    <ActionCard key={a.id} a={a} busy={busy} onApprove={(b) => decide(a, true, b)} onReject={() => decide(a, false)} />
                  ))}
                  {waiting.length > 1 && (
                    <button className="btn sm primary" disabled={busy} onClick={() => approveAll(waiting)} style={{ alignSelf: 'flex-start' }}>
                      Approve all {waiting.length}
                    </button>
                  )}
                </div>
              )}
            </div>
          );
        })}
        {pendingText && (
          <div className="asst-msg user">
            <div className="asst-bubble">{pendingText}</div>
          </div>
        )}
        {busy && (
          <div className="asst-msg assistant">
            <div className="asst-answer muted small">
              <span className="asst-dots">Working on it</span>
            </div>
          </div>
        )}
        <div ref={end} />
      </div>
      {files.length > 0 && (
        <div className="row" style={{ gap: 4, flexWrap: 'wrap', padding: '6px 12px 0' }}>
          {files.map((f) => (
            <span key={f.id} className="chip">
              📎 {f.name}
              <button type="button" className="btn ghost sm" style={{ height: 18, padding: '0 4px' }} aria-label={`Remove ${f.name}`} onClick={() => setFiles((x) => x.filter((y) => y.id !== f.id))}>
                ✕
              </button>
            </span>
          ))}
        </div>
      )}
      <form
        className="asst-input"
        onSubmit={(e) => {
          e.preventDefault();
          void send(text);
        }}
      >
        <textarea
          rows={compact ? 2 : 3}
          value={text}
          placeholder="Ask, or tell me what to do…  (Enter to send, Shift+Enter for a new line)"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void send(text);
            }
          }}
          aria-label="Message to the assistant"
        />
        <input ref={fileRef} type="file" multiple hidden onChange={(e) => attach(e.target.files)} />
        <button type="button" className="btn ghost" disabled={busy || uploading} onClick={() => fileRef.current?.click()} title="Attach documents or pictures (a BRD, notes, sketches, screenshots)" aria-label="Attach files">
          {uploading ? '…' : '📎'}
        </button>
        {dictation.supported && (
          <button type="button" className={`btn ghost ${dictation.listening ? 'rec' : ''}`} disabled={busy} onClick={dictation.toggle} title={dictation.listening ? 'Listening… tap to stop' : 'Speak your message'} aria-label="Dictate message" aria-pressed={dictation.listening}>
            {dictation.listening ? '🔴' : '🎤'}
          </button>
        )}
        {speech.supported && (
          <button type="button" className={`btn ghost ${speech.on ? 'on' : ''}`} onClick={() => speech.setOn((v) => !v)} title={speech.on ? 'Reading replies aloud — tap to mute' : 'Read replies aloud'} aria-label="Read replies aloud" aria-pressed={speech.on}>
            {speech.on ? '🔊' : '🔈'}
          </button>
        )}
        <button className="btn primary" disabled={busy || uploading || !text.trim()}>
          Send
        </button>
      </form>
    </div>
  );
}

function ThreadList({ current, onPick }: { current: string | null; onPick: (id: string | null) => void }) {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['assistant-threads'], queryFn: () => get<{ items: Json[] }>('/api/v1/assistant/threads') });
  return (
    <div className="asst-threads">
      <button className="btn sm primary" onClick={() => onPick(null)}>
        + New chat
      </button>
      {(data?.items ?? []).map((t) => (
        <div key={t.id} className={`asst-thread ${t.id === current ? 'on' : ''}`}>
          <button className="link-btn" onClick={() => onPick(t.id)} title={t.title}>
            {t.title}
            <span className="muted small"> · {relative(t.updated_at)}</span>
          </button>
          <button
            className="icon-btn"
            aria-label="Delete chat"
            onClick={async () => {
              await del(`/api/v1/assistant/threads/${t.id}`);
              if (t.id === current) onPick(null);
              qc.invalidateQueries({ queryKey: ['assistant-threads'] });
            }}
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}

const LAST = 'asst:last';
const remembered = () => {
  try {
    return localStorage.getItem(LAST);
  } catch {
    return null;
  }
};
const remember = (id: string | null) => {
  try {
    if (id) localStorage.setItem(LAST, id);
    else localStorage.removeItem(LAST);
  } catch {
    /* private mode */
  }
};

/** The ✦ button and side panel, on every page. Ctrl/⌘ + J opens it. */
export function AssistantLauncher() {
  const [open, setOpen] = useState(false);
  const [thread, setThread] = useState<string | null>(remembered);
  const [history, setHistory] = useState(false);
  const loc = useLocation();
  const nav = useNavigate();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'j') {
        e.preventDefault();
        setOpen((o) => !o);
      }
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const pick = (id: string | null) => {
    setThread(id);
    remember(id);
    setHistory(false);
  };
  if (loc.pathname.startsWith('/assistant')) return null;
  return (
    <>
      {!open && (
        <button className="asst-fab" onClick={() => setOpen(true)} title="Assistant (Ctrl+J)" aria-label="Open the assistant">
          ✦
        </button>
      )}
      {open && (
        <aside className="asst-drawer" aria-label="Assistant">
          <div className="asst-head">
            <b>✦ Assistant</b>
            <div className="row" style={{ gap: 4 }}>
              <button className="btn sm ghost" onClick={() => pick(null)}>
                New
              </button>
              <button className="btn sm ghost" onClick={() => setHistory(!history)}>
                Chats
              </button>
              <button className="btn sm ghost" onClick={() => (setOpen(false), nav(thread ? `/assistant?t=${thread}` : '/assistant'))} title="Open full page">
                ⤢
              </button>
              <button className="icon-btn" onClick={() => setOpen(false)} aria-label="Close">
                ✕
              </button>
            </div>
          </div>
          {history ? <ThreadList current={thread} onPick={pick} /> : <AssistantChat threadId={thread} onThread={pick} compact />}
        </aside>
      )}
    </>
  );
}

export function AssistantPage() {
  const loc = useLocation();
  const nav = useNavigate();
  const thread = new URLSearchParams(loc.search).get('t');
  const pick = (id: string | null) => {
    remember(id);
    nav(id ? `/assistant?t=${id}` : '/assistant', { replace: true });
  };
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Assistant</h1>
          <p>Ask about anything in your workspace, or ask it to do the work. Changes wait for your approval and run as you.</p>
        </div>
      </div>
      <div className="asst-page">
        <ThreadList current={thread} onPick={pick} />
        <section className="panel" style={{ minWidth: 0 }}>
          <AssistantChat key={thread ?? 'new'} threadId={thread} onThread={pick} />
        </section>
      </div>
    </>
  );
}
