/**
 * Project calls: schedule a call with the client or the team (plain, with a pasted Zoom / Meet /
 * Teams link, or as a new meeting on one of my connected accounts), add the transcript (paste or
 * upload .txt / .vtt / .srt / .md, or fetched automatically from the meeting app), and read the
 * minutes: summary, points discussed, requirements, decisions, open questions, risks and the
 * actions for each person (team actions become project tasks).
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { del, get, patch, post, put, upload } from '../../lib/api';
import { date } from '../../lib/format';
import { Empty, Modal, Spinner, useToast } from '../ui';

type Json = Record<string, any>;

export const MEET_LABEL: Record<string, string> = { zoom_meet: 'Zoom', google_meet: 'Google Meet', ms_teams_meet: 'Teams' };
const TRANSCRIPT: Record<string, [string, string]> = {
  none: ['', ''],
  waiting: ['info', 'Transcript after the call'],
  fetched: ['good', 'Transcript fetched'],
  not_available: ['warn', 'No transcript from the app'],
  failed: ['bad', 'Transcript fetch failed'],
};
const when = (s: string) => new Date(s).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const localInput = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);

export function CallStatus({ c }: { c: Json }) {
  if (c.analyzedAt) return <span className="chip good">Minutes ready</span>;
  if (c.hasTranscript) return <span className="chip info">Transcript added</span>;
  const [cls, label] = TRANSCRIPT[c.transcriptStatus] ?? ['', ''];
  if (label) return <span className={`chip ${cls}`}>{label}</span>;
  if (c.status === 'cancelled') return <span className="chip">Cancelled</span>;
  return new Date(c.endsAt).getTime() > Date.now() ? <span className="chip">Upcoming</span> : <span className="chip warn">Add transcript</span>;
}

/** The project's Calls section. */
export function ProjectCalls({ id }: { id: string }) {
  const { data } = useQuery({ queryKey: ['project', id, 'calls'], queryFn: () => get<Json>(`/api/v1/projects/${id}/calls`) });
  const [params, setParams] = useSearchParams();
  const open = params.get('call');
  const setOpen = (v: string | null) =>
    setParams(
      (p) => {
        const n = new URLSearchParams(p);
        if (v) n.set('call', v);
        else n.delete('call');
        return n;
      },
      { preventScrollReset: true },
    );
  const [schedule, setSchedule] = useState<boolean | 'past'>(false);
  if (!data) return <Spinner />;
  const calls = data.calls as Json[];
  const upcoming = calls.filter((c) => new Date(c.endsAt).getTime() >= Date.now() && c.status !== 'cancelled').reverse();
  const past = calls.filter((c) => !upcoming.includes(c));
  return (
    <div className="stack">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <p className="muted small" style={{ margin: 0, maxWidth: 640 }}>
          Calls with the client or the team. Add the transcript — or let Zoom, Google Meet or Teams send it — and Synapse writes the minutes: what was discussed, requirements, decisions and who does what.
        </p>
        {data.canSchedule && (
          <div className="row" style={{ gap: 6 }}>
            <button className="btn" onClick={() => setSchedule('past')}>
              Add a past call
            </button>
            <button className="btn primary" onClick={() => setSchedule(true)}>
              Schedule a call
            </button>
          </div>
        )}
      </div>
      {!calls.length ? (
        <Empty title="No calls yet">Schedule the kick-off or a requirements call, or record one that already happened and upload its transcript.</Empty>
      ) : (
        <>
          {upcoming.length > 0 && <CallTable title="Upcoming" calls={upcoming} onOpen={setOpen} />}
          {past.length > 0 && <CallTable title="Held" calls={past} onOpen={setOpen} />}
        </>
      )}
      {schedule && <ScheduleCall projectId={id} team={data.team} contacts={data.contacts} past={schedule === 'past'} onClose={() => setSchedule(false)} onDone={(cid) => (setSchedule(false), setOpen(cid))} />}
      {open && <CallDetail id={open} onClose={() => setOpen(null)} invalidate={[['project', id, 'calls'], ['project', id]]} />}
    </div>
  );
}

export function CallTable({ title, calls, onOpen, showProject }: { title?: string; calls: Json[]; onOpen: (id: string) => void; showProject?: boolean }) {
  return (
    <div>
      {title && <h3 className="section-label">{title}</h3>}
      <table className="data">
        <thead>
          <tr>
            <th>When</th>
            <th>Call</th>
            {showProject && <th>Project</th>}
            <th>On</th>
            <th>Organiser</th>
            <th>Status</th>
            <th className="num">Actions</th>
          </tr>
        </thead>
        <tbody>
          {calls.map((c) => (
            <tr key={c.id} className="click" onClick={() => onOpen(c.id)}>
              <td className="nowrap">{when(c.startsAt)}</td>
              <td style={{ whiteSpace: 'normal' }}>
                <strong>{c.title}</strong>
                {c.summary && <div className="muted small clamp2">{c.summary}</div>}
              </td>
              {showProject && <td>{c.projectId ? <Link to={`/projects/${c.projectId}?s_project=calls&call=${c.id}`} onClick={(e) => e.stopPropagation()}>{c.projectName}</Link> : <span className="muted">Not filed</span>}</td>}
              <td>{c.meeting ? <span className={`meet-badge ${c.meeting.provider}`}>{c.meeting.label}</span> : <span className="muted">{c.kind === 'call' ? 'Phone' : 'In person'}</span>}</td>
              <td>{c.ownerName ?? '—'}</td>
              <td>
                <CallStatus c={c} />
              </td>
              <td className="num">{c.actionCount || ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ───────────────────────── schedule ───────────────────────── */

function ScheduleCall({ projectId, team, contacts, past: pastCall, onClose, onDone }: { projectId: string; team: Json[]; contacts: Json[]; past?: boolean; onClose: () => void; onDone: (id: string) => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const { data: acc } = useQuery({ queryKey: ['meeting-choices'], queryFn: () => get<{ accounts: Json[] }>('/api/v1/calls/meeting-accounts') });
  const start = useMemo(() => {
    const d = new Date(Date.now() + (pastCall ? -2 : 1) * 3_600_000);
    d.setMinutes(d.getMinutes() < 30 ? 30 : 60, 0, 0);
    return d;
  }, []);
  const [f, setF] = useState({ title: '', kind: 'meeting', starts: localInput(start), minutes: 30, agenda: '', mode: pastCall ? 'none' : 'none', integrationId: '', joinUrl: '', emails: '' });
  const [users, setUsers] = useState<string[]>([]);
  const [cons, setCons] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const ok = acc?.accounts.filter((a) => a.ok) ?? [];
    if (ok.length && !f.integrationId) setF((x) => ({ ...x, integrationId: ok[0]!.id, mode: x.mode === 'none' && !pastCall ? 'create' : x.mode }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [acc]);
  const toggle = (list: string[], set: (v: string[]) => void, v: string) => set(list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const past = new Date(f.starts).getTime() < Date.now();
  const save = async () => {
    setBusy(true);
    try {
      const s = new Date(f.starts);
      const r = await post<{ id: string; meeting: Json | null }>(`/api/v1/projects/${projectId}/calls`, {
        title: f.title.trim(),
        kind: f.kind,
        startsAt: s.toISOString(),
        endsAt: new Date(s.getTime() + f.minutes * 60000).toISOString(),
        agenda: f.agenda.trim() || null,
        userIds: users,
        contactIds: cons,
        emails: f.emails.split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean),
        meeting: f.mode === 'create' ? { mode: 'create', integrationId: f.integrationId } : f.mode === 'link' ? { mode: 'link', joinUrl: f.joinUrl.trim() } : { mode: 'none' },
      });
      toast(r.meeting ? `${MEET_LABEL[r.meeting.provider] ?? 'Meeting'} created and invites sent` : 'Call scheduled');
      qc.invalidateQueries({ queryKey: ['project', projectId, 'calls'] });
      onDone(r.id);
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  };
  const accounts = acc?.accounts ?? [];
  return (
    <Modal
      title={past ? 'Record a call' : 'Schedule a call'}
      onClose={onClose}
      wide
      footer={
        <button className="btn primary" disabled={busy || !f.title.trim() || (f.mode === 'link' && !/^https?:\/\//.test(f.joinUrl)) || (f.mode === 'create' && !f.integrationId)} onClick={save}>
          {busy ? 'Saving…' : past ? 'Save call' : f.mode === 'create' ? 'Create meeting & invite' : 'Schedule'}
        </button>
      }
    >
      <div className="modal-body stack">
        <div className="grid2">
          <label className="field wide">
            Title
            <input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder="e.g. Requirements walkthrough – dispatch module" autoFocus />
          </label>
          <label className="field">
            Starts
            <input type="datetime-local" value={f.starts} onChange={(e) => setF({ ...f, starts: e.target.value })} />
          </label>
          <label className="field">
            Length
            <select value={f.minutes} onChange={(e) => setF({ ...f, minutes: Number(e.target.value) })}>
              {[15, 30, 45, 60, 90, 120, 180].map((m) => (
                <option key={m} value={m}>
                  {m < 60 ? `${m} min` : `${m / 60} h`}
                </option>
              ))}
            </select>
          </label>
          <label className="field wide">
            Agenda
            <textarea rows={3} value={f.agenda} onChange={(e) => setF({ ...f, agenda: e.target.value })} placeholder="What the call should settle" />
          </label>
        </div>

        <div>
          <div className="section-label">Where</div>
          <div className="seg" role="radiogroup">
            {(
              [
                ['create', 'New online meeting'],
                ['link', 'Paste a meeting link'],
                ['none', 'Phone / in person'],
              ] as const
            ).map(([k, l]) => (
              <button key={k} type="button" role="radio" aria-checked={f.mode === k} className={f.mode === k ? 'on' : ''} onClick={() => setF({ ...f, mode: k, kind: k === 'none' ? f.kind : 'meeting' })}>
                {l}
              </button>
            ))}
          </div>
          {f.mode === 'create' &&
            (accounts.length ? (
              <label className="field" style={{ marginTop: 8 }}>
                Create it on
                <select value={f.integrationId} onChange={(e) => setF({ ...f, integrationId: e.target.value })}>
                  {accounts.map((a) => (
                    <option key={a.id} value={a.id} disabled={!a.ok}>
                      {a.label} · {a.account}
                      {a.ok ? '' : ' (reconnect)'}
                    </option>
                  ))}
                </select>
                <span className="muted small">The app sends the invites; the transcript is picked up after the call and analysed.</span>
              </label>
            ) : (
              <p className="muted small" style={{ marginTop: 8 }}>
                Connect Zoom, Google Meet or Teams in <Link to="/account#meeting-apps">My account → Meeting apps</Link> to create meetings from here — or paste a link.
              </p>
            ))}
          {f.mode === 'link' && (
            <label className="field" style={{ marginTop: 8 }}>
              Meeting link
              <input value={f.joinUrl} onChange={(e) => setF({ ...f, joinUrl: e.target.value })} placeholder="https://zoom.us/j/… · https://meet.google.com/… · https://teams.microsoft.com/…" />
              <span className="muted small">If that app is connected under your account, its transcript is fetched after the call.</span>
            </label>
          )}
          {f.mode === 'none' && (
            <label className="row small" style={{ marginTop: 8, gap: 6 }}>
              <input type="checkbox" checked={f.kind === 'call'} onChange={(e) => setF({ ...f, kind: e.target.checked ? 'call' : 'meeting' })} /> Phone call
            </label>
          )}
        </div>

        <div className="grid2">
          <div>
            <div className="section-label">Team</div>
            <div className="pick-list">
              {team.map((u) => (
                <label key={u.id} className="row small">
                  <input type="checkbox" checked={users.includes(u.id)} onChange={() => toggle(users, setUsers, u.id)} /> {u.name}
                </label>
              ))}
              {!team.length && <span className="muted small">Add people on the Team tab.</span>}
            </div>
          </div>
          <div>
            <div className="section-label">Client</div>
            <div className="pick-list">
              {contacts.map((c) => (
                <label key={c.id} className="row small" title={c.email ?? 'No email: not invited by the app'}>
                  <input type="checkbox" checked={cons.includes(c.id)} onChange={() => toggle(cons, setCons, c.id)} /> {c.name}
                  {c.title && <span className="muted"> · {c.title}</span>}
                  {!c.email && <span className="muted"> · no email</span>}
                </label>
              ))}
              {!contacts.length && <span className="muted small">No contacts on the project's customer.</span>}
            </div>
            <label className="field" style={{ marginTop: 6 }}>
              Other emails
              <input value={f.emails} onChange={(e) => setF({ ...f, emails: e.target.value })} placeholder="name@client.com, …" />
            </label>
          </div>
        </div>
      </div>
    </Modal>
  );
}

/* ───────────────────────── one call ───────────────────────── */

export function CallDetail({ id, onClose, invalidate = [] }: { id: string; onClose: () => void; invalidate?: unknown[][] }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { data: c, isLoading } = useQuery({ queryKey: ['call', id], queryFn: () => get<Json>(`/api/v1/calls/${id}`) });
  const [view, setView] = useState<'minutes' | 'transcript'>('minutes');
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['call', id] });
    for (const k of invalidate) qc.invalidateQueries({ queryKey: k });
    qc.invalidateQueries({ queryKey: ['my-calls'] });
  };
  const run = async (key: string, fn: () => Promise<unknown>, ok?: string) => {
    setBusy(key);
    try {
      const r = await fn();
      if (ok) toast(ok);
      refresh();
      return r;
    } catch (e) {
      toast((e as Error).message, true);
      return null;
    } finally {
      setBusy(null);
    }
  };
  const analyse = () =>
    run('analyse', async () => {
      const r = await post<Json>(`/api/v1/calls/${id}/analyse`, { createTasks: true });
      toast(r.analysis.ai ? `Minutes written${r.tasksCreated ? ` · ${r.tasksCreated} task${r.tasksCreated > 1 ? 's' : ''} created` : ''}` : `AI unavailable — key points picked out by rules${r.tasksCreated ? ` · ${r.tasksCreated} tasks` : ''}`);
      setView('minutes');
    });
  if (isLoading || !c) return <Modal title="Call" onClose={onClose} xl><div className="modal-body"><Spinner /></div></Modal>;
  const a = c.analysis as Json | null;
  return (
    <Modal
      title={c.title}
      onClose={onClose}
      xl
      footer={
        c.canEdit ? (
          <>
            <button className="btn danger" onClick={() => window.confirm('Delete this call, its transcript and minutes? Tasks already created stay.') && run('del', () => del(`/api/v1/calls/${id}`), 'Deleted').then((r) => r && onClose())}>
              Delete
            </button>
            {c.status === 'scheduled' && new Date(c.endsAt).getTime() > Date.now() && (
              <button className="btn" onClick={() => run('cancel', () => patch(`/api/v1/calls/${id}`, { status: 'cancelled' }), 'Call cancelled')}>
                Cancel call
              </button>
            )}
            <button className="btn" onClick={() => setEditing(true)}>
              {c.hasTranscript ? 'Replace transcript' : 'Add transcript'}
            </button>
            <button className="btn primary" disabled={!c.hasTranscript || busy === 'analyse'} onClick={analyse} title={c.hasTranscript ? '' : 'Add the transcript first'}>
              {busy === 'analyse' ? 'Analysing…' : a ? 'Analyse again' : 'Analyse transcript'}
            </button>
          </>
        ) : undefined
      }
    >
      <div className="modal-body stack">
        <div className="call-head">
          <div>
            <div>
              <strong>{new Date(c.startsAt).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}</strong>
              <span className="muted"> – {new Date(c.endsAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}</span>
            </div>
            <div className="muted small">
              Organised by {c.ownerName ?? '—'}
              {c.projectName && (
                <>
                  {' '}· <Link to={`/projects/${c.projectId}?s_project=calls`}>{c.projectName}</Link>
                </>
              )}
            </div>
          </div>
          <div className="row" style={{ gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            <CallStatus c={c} />
            {c.meeting && (
              <a className="btn small" href={c.meeting.joinUrl} target="_blank" rel="noreferrer">
                Join on {c.meeting.label}
              </a>
            )}
          </div>
        </div>
        {c.people?.length > 0 && (
          <div className="row" style={{ gap: 4, flexWrap: 'wrap' }}>
            {(c.people as Json[]).map((p, i) => (
              <span key={i} className={`chip ${p.side === 'team' ? 'info' : ''}`} title={p.email ?? ''}>
                {p.name}
                <span className="muted"> · {p.side === 'team' ? 'team' : 'client'}</span>
              </span>
            ))}
          </div>
        )}
        {c.agenda && (
          <div className="callout">
            <div className="section-label">Agenda</div>
            <div style={{ whiteSpace: 'pre-wrap' }}>{c.agenda}</div>
          </div>
        )}
        <Recordings id={id} count={c.recordings} canEdit={c.canEdit} hasTranscript={c.hasTranscript} onChanged={refresh} />
        {c.transcriptStatus === 'waiting' && !c.hasTranscript && (
          <div className="callout info small">
            {MEET_LABEL[c.meeting?.provider] ?? 'The meeting app'} makes the transcript once the call is over; Synapse checks for it and analyses it automatically. Turn on transcription / cloud recording in the meeting.
          </div>
        )}

        {(a || c.hasTranscript) && (
          <div className="seg">
            <button className={view === 'minutes' ? 'on' : ''} onClick={() => setView('minutes')}>
              Minutes
            </button>
            <button className={view === 'transcript' ? 'on' : ''} onClick={() => setView('transcript')}>
              Transcript
            </button>
          </div>
        )}
        {view === 'transcript' && c.hasTranscript && c.canEdit && <SpeakerNames id={id} speakers={c.speakers ?? []} people={c.people ?? []} onSaved={refresh} />}
        {view === 'transcript' && c.hasTranscript && <pre className="transcript">{c.transcript}</pre>}
        {view === 'minutes' &&
          (a ? (
            <Minutes call={c} a={a} canEdit={c.canEdit} onChange={refresh} />
          ) : c.hasTranscript ? (
            <Empty title="Transcript added" action={c.canEdit ? <button className="btn primary" disabled={busy === 'analyse'} onClick={analyse}>{busy === 'analyse' ? 'Analysing…' : 'Analyse transcript'}</button> : undefined}>
              Synapse reads it and writes the summary, requirements, decisions and each person's actions.
            </Empty>
          ) : c.canEdit ? (
            <TranscriptInput id={id} onSaved={refresh} />
          ) : (
            <Empty title="No transcript yet" />
          ))}
      </div>
      {editing && (
        <Modal title="Transcript" onClose={() => setEditing(false)} wide>
          <div className="modal-body">
            <TranscriptInput id={id} onSaved={() => (refresh(), setEditing(false))} />
          </div>
        </Modal>
      )}
    </Modal>
  );
}

function TranscriptInput({ id, onSaved }: { id: string; onSaved: () => void }) {
  const toast = useToast();
  const [text, setText] = useState('');
  const [name, setName] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const pick = async (f: File | undefined) => {
    if (!f) return;
    if (f.size > 2_000_000) return toast('That file is over 2 MB — paste the text instead', true);
    if (!/\.(txt|vtt|srt|md|text|csv)$/i.test(f.name) && !f.type.startsWith('text/')) return toast('Upload a text transcript: .txt, .vtt, .srt or .md', true);
    setText(await f.text());
    setName(f.name);
  };
  const save = async (andAnalyse: boolean) => {
    setBusy(true);
    try {
      await put(`/api/v1/calls/${id}/transcript`, { text, fileName: name, source: name ? 'upload' : 'pasted' });
      if (andAnalyse) {
        const r = await post<Json>(`/api/v1/calls/${id}/analyse`, { createTasks: true });
        toast(r.analysis.ai ? 'Transcript saved and analysed' : 'Saved · AI unavailable, key points picked out by rules');
      } else toast('Transcript saved');
      onSaved();
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div
      className="stack"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        void pick(e.dataTransfer.files[0]);
      }}
    >
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <span className="muted small">Paste the transcript or notes, or drop the file from Zoom, Meet, Teams or any recorder (.vtt, .srt, .txt).</span>
        <button className="btn small" onClick={() => file.current?.click()}>
          Upload file
        </button>
        <input ref={file} type="file" accept=".txt,.vtt,.srt,.md,text/*" hidden onChange={(e) => void pick(e.target.files?.[0])} />
      </div>
      {name && <span className="chip">{name}</span>}
      <textarea rows={12} value={text} onChange={(e) => (setText(e.target.value), setName(null))} placeholder={'Priya: Let’s go over the dispatch module.\nRahul (client): We need GPS tracking on every truck…'} className="mono" />
      <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
        <button className="btn" disabled={busy || text.trim().length < 20} onClick={() => save(false)}>
          Save only
        </button>
        <button className="btn primary" disabled={busy || text.trim().length < 20} onClick={() => save(true)}>
          {busy ? 'Working…' : 'Save & analyse'}
        </button>
      </div>
    </div>
  );
}

const PRI: Record<string, string> = { must: 'bad', should: 'warn', could: '' };

function Minutes({ call, a, canEdit, onChange }: { call: Json; a: Json; canEdit: boolean; onChange: () => void }) {
  const toast = useToast();
  const actions = (a.actions ?? []) as Json[];
  const byPerson = useMemo(() => {
    const m = new Map<string, { side: string; items: { a: Json; i: number }[] }>();
    actions.forEach((x, i) => {
      const k = x.owner || 'Unassigned';
      if (!m.has(k)) m.set(k, { side: x.side, items: [] });
      m.get(k)!.items.push({ a: x, i });
    });
    return [...m.entries()].sort((x, y) => (x[1].side === 'team' ? 0 : 1) - (y[1].side === 'team' ? 0 : 1));
  }, [actions]);
  const upd = async (i: number, body: Json, ok?: string) => {
    try {
      await patch(`/api/v1/calls/${call.id}/actions/${i}`, body);
      if (ok) toast(ok);
      onChange();
    } catch (e) {
      toast((e as Error).message, true);
    }
  };
  const copy = async () => {
    const lines = [
      `Minutes – ${call.title} (${date(call.startsAt)})`,
      '',
      a.summary,
      ...(a.discussion?.length ? ['', 'Discussed:', ...a.discussion.map((x: string) => `• ${x}`)] : []),
      ...(a.requirements?.length ? ['', 'Requirements:', ...a.requirements.map((r: Json) => `• [${r.priority.toUpperCase()}] ${r.text}`)] : []),
      ...(a.decisions?.length ? ['', 'Decisions:', ...a.decisions.map((x: string) => `• ${x}`)] : []),
      ...(a.openQuestions?.length ? ['', 'Open questions:', ...a.openQuestions.map((x: string) => `• ${x}`)] : []),
      ...(byPerson.length ? ['', 'Actions:', ...byPerson.flatMap(([who, g]) => [`${who}:`, ...g.items.map(({ a: x }) => `  – ${x.task}${x.due ? ` (by ${date(x.due)})` : ''}`)])] : []),
      ...(a.nextMeeting ? ['', `Next meeting: ${a.nextMeeting}`] : []),
    ];
    try {
      await navigator.clipboard.writeText(lines.join('\n'));
      toast('Minutes copied — paste them into an email');
    } catch {
      toast('Copy failed', true);
    }
  };
  const list = (title: string, items: string[] | undefined) =>
    items?.length ? (
      <div>
        <h3 className="section-label">{title}</h3>
        <ul className="bullets">
          {items.map((x, i) => (
            <li key={i}>{x}</li>
          ))}
        </ul>
      </div>
    ) : null;
  return (
    <div className="minutes">
      <div className="minutes-main stack">
        <div className="callout">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <h3 className="section-label" style={{ margin: 0 }}>
              Summary
            </h3>
            <span className="row small" style={{ gap: 6 }}>
              {a.sentiment && <span className={`chip ${a.sentiment === 'positive' ? 'good' : a.sentiment === 'negative' ? 'bad' : a.sentiment === 'mixed' ? 'warn' : ''}`}>{a.sentiment}</span>}
              <span className="muted">{a.ai ? 'AI' : 'Rule-based'}</span>
              <button className="btn small" onClick={copy}>
                Copy minutes
              </button>
            </span>
          </div>
          <p style={{ margin: '6px 0 0' }}>{a.summary}</p>
          {a.nextMeeting && <p className="small" style={{ margin: '6px 0 0' }}>Next meeting: <strong>{a.nextMeeting}</strong></p>}
        </div>
        {list('What was discussed', a.discussion)}
        {a.requirements?.length > 0 && (
          <div>
            <h3 className="section-label">Requirements</h3>
            <table className="data compact">
              <tbody>
                {(a.requirements as Json[]).map((r, i) => (
                  <tr key={i}>
                    <td style={{ width: 70 }}>
                      <span className={`chip ${PRI[r.priority] ?? ''}`}>{r.priority}</span>
                    </td>
                    <td style={{ whiteSpace: 'normal' }}>{r.text}</td>
                    <td className="muted small">{r.area ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {list('Decisions', a.decisions)}
        {list('Open questions', a.openQuestions)}
        {list('Risks', a.risks)}
      </div>
      <div className="minutes-side">
        <h3 className="section-label">Actions by person</h3>
        {!byPerson.length && <p className="muted small">No actions found.</p>}
        {byPerson.map(([who, g]) => (
          <div key={who} className="person-actions">
            <div className="person-head">
              <strong>{who}</strong>
              <span className={`chip ${g.side === 'team' ? 'info' : g.side === 'client' ? '' : 'warn'}`}>{g.side === 'team' ? 'Team' : g.side === 'client' ? 'Client' : 'Not matched'}</span>
            </div>
            {g.items.map(({ a: x, i }) => {
              const done = x.taskStatus === 'done' || x.done;
              return (
                <div key={i} className={`action-row${done ? ' done' : ''}`}>
                  <input type="checkbox" disabled={!canEdit} checked={!!done} onChange={(e) => upd(i, { done: e.target.checked })} aria-label="Done" />
                  <div style={{ flex: 1 }}>
                    <div>{x.task}</div>
                    <div className="muted small">
                      {x.due && <>Due {date(x.due)} · </>}
                      {x.priority !== 'medium' && <>{x.priority} · </>}
                      {x.taskId ? <Link to={`/projects/${call.projectId}?s_project=tasks#task-${x.taskId}`}>Task #{x.taskNumber ?? ''}</Link> : x.actionItemId ? 'In their to-dos' : null}
                      {canEdit && !x.taskId && x.side === 'team' && x.userId && call.projectId && (
                        <button className="link-btn" onClick={() => upd(i, { makeTask: true }, 'Task created')}>
                          Make task
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

/** Recordings of a call: listen, and upload one (it is transcribed and, if asked, analysed). */
function Recordings({ id, count, canEdit, hasTranscript, onChanged }: { id: string; count: number; canEdit: boolean; hasTranscript: boolean; onChanged: () => void }) {
  const toast = useToast();
  const { data, refetch } = useQuery({ queryKey: ['call', id, 'recordings'], enabled: count > 0, queryFn: () => get<Json[]>(`/api/v1/calls/${id}/recordings`) });
  const [busy, setBusy] = useState<string | null>(null);
  const [speakers, setSpeakers] = useState(true);
  const file = useRef<HTMLInputElement>(null);
  const done = (r: Json, analyse: boolean) => {
    toast(r.analysed ? `Transcribed${r.engine === 'nova-3' ? ' with speakers' : ''} and the minutes written` : r.transcribed ? `Recording transcribed${r.engine === 'nova-3' ? ' with speakers' : ''}` : r.reason ? `Recording saved · ${r.reason}` : 'Recording saved');
    if (analyse && r.transcribed && !r.analysed) toast('Transcribed — analyse it from the call');
    refetch();
    onChanged();
  };
  /** Long recordings: the browser cuts them into 10-minute WAV parts; each is transcribed with its time offset. */
  const inParts = async (fileId: string, blob: Blob, analyse: boolean) => {
    setBusy('Reading the recording…');
    const { prepareWavParts } = await import('../../lib/audio');
    const parts = await prepareWavParts(blob);
    let last: Json | null = null;
    for (let p = 0; p < parts.total; p++) {
      setBusy(`Transcribing part ${p + 1} of ${parts.total}…`);
      const w = parts.part(p);
      last = await upload<Json>(`/api/v1/calls/${id}/recordings/${fileId}/parts?index=${p}&total=${parts.total}&offset=${w.offset.toFixed(2)}&speakers=${speakers ? 1 : 0}&analyse=${analyse ? 1 : 0}`, w.blob);
    }
    return last!;
  };
  const send = async (f: File | undefined) => {
    if (!f) return;
    if (f.size > 95 * 1024 * 1024) return toast('Recordings can be at most 95 MB — export audio only (m4a / mp3) from the meeting app', true);
    const analyse = !hasTranscript;
    setBusy(`Uploading ${f.name}…`);
    try {
      const r = await upload<Json>(`/api/v1/calls/${id}/recording?name=${encodeURIComponent(f.name)}&transcribe=${hasTranscript ? 0 : 1}&analyse=${analyse ? 1 : 0}&speakers=${speakers ? 1 : 0}`, f);
      done(r.needsParts ? await inParts(r.file.id, f, analyse) : r, analyse);
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy(null);
    }
  };
  const again = async (r: Json) => {
    if (hasTranscript && !window.confirm('Replace the transcript with a new one from this recording?')) return;
    setBusy('Transcribing…');
    try {
      const out = await post<Json>(`/api/v1/calls/${id}/recordings/${r.id}/transcribe`, { analyse: false, speakers });
      if (out.needsParts) {
        setBusy('Downloading the recording…');
        const blob = await (await fetch(r.url)).blob();
        done(await inParts(r.id, blob, false), false);
      } else done(out, false);
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy(null);
    }
  };
  if (!count && !canEdit) return null;
  return (
    <div className="callout">
      <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 6 }}>
        <div>
          <strong>Recordings</strong>
          <div className="muted small">{hasTranscript ? 'Kept with the call.' : 'Upload the recording of a call that already happened — Synapse transcribes it (who said what) and writes the minutes. Long recordings are cut into parts in your browser.'}</div>
        </div>
        {canEdit && (
          <div className="row" style={{ gap: 8 }}>
            <label className="row small" style={{ gap: 4 }} title="Labels who is speaking (Speaker 1, Speaker 2 …) — you can name them afterwards">
              <input type="checkbox" checked={speakers} onChange={(e) => setSpeakers(e.target.checked)} /> Speakers
            </label>
            <button className="btn small" disabled={!!busy} onClick={() => file.current?.click()}>
              {busy ?? 'Upload recording'}
            </button>
            <input ref={file} type="file" hidden accept="audio/*,video/mp4,video/webm,video/quicktime,.m4a,.mp3,.wav,.ogg,.flac,.mp4,.webm,.mov" onChange={(e) => (void send(e.target.files?.[0]), (e.target.value = ''))} />
          </div>
        )}
      </div>
      {(data ?? []).map((r) => (
        <div key={r.id} className="stack" style={{ gap: 4, marginTop: 8 }}>
          <span className="small row" style={{ gap: 8 }}>
            <span>
              {r.name} · {(r.size / 1024 / 1024).toFixed(1)} MB{r.uploader ? ` · ${r.uploader}` : ''}
            </span>
            {canEdit && (
              <button className="link-btn small" disabled={!!busy} onClick={() => void again(r)}>
                {hasTranscript ? 'Transcribe again' : 'Transcribe'}
              </button>
            )}
          </span>
          {r.type.startsWith('video/') ? <video controls preload="none" src={r.url} style={{ maxWidth: '100%', maxHeight: 280 }} /> : <audio controls preload="none" src={r.url} style={{ width: '100%' }} />}
        </div>
      ))}
    </div>
  );
}

/** Speakers found in the transcript, with names to give them ("Speaker 1" → "Anita Desai"). */
function SpeakerNames({ id, speakers, people, onSaved }: { id: string; speakers: Json[]; people: Json[]; onSaved: () => void }) {
  const toast = useToast();
  const [names, setNames] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const generic = speakers.filter((s) => /^(P\d+ )?Speaker \d+$/.test(s.label));
  if (!speakers.length) return null;
  const changed = Object.entries(names).filter(([k, v]) => v.trim() && v.trim() !== k);
  return (
    <details className="callout small" open={generic.length > 0}>
      <summary>
        <strong>Speakers</strong> · {speakers.map((s) => s.label).join(', ')}
      </summary>
      <div className="stack" style={{ gap: 6, marginTop: 8 }}>
        {speakers.map((s) => (
          <label key={s.label} className="row" style={{ gap: 8 }}>
            <span style={{ width: 140 }}>
              {s.label} <span className="muted">({s.lines})</span>
            </span>
            <input list={`people-${id}`} value={names[s.label] ?? ''} placeholder={s.label} onChange={(e) => setNames({ ...names, [s.label]: e.target.value })} aria-label={`Name for ${s.label}`} style={{ flex: 1 }} />
          </label>
        ))}
        <datalist id={`people-${id}`}>
          {people.map((p) => (
            <option key={p.email ?? p.name} value={p.name} />
          ))}
        </datalist>
        {generic.some((s) => s.label.startsWith('P')) && <span className="muted">Long recordings are labelled per part (P1, P2 …) — the same person can have a different number in each part.</span>}
        <div>
          <button
            className="btn small primary"
            disabled={!changed.length || busy}
            onClick={async () => {
              setBusy(true);
              try {
                await put(`/api/v1/calls/${id}/speakers`, { names: Object.fromEntries(changed.map(([k, v]) => [k, v.trim()])) });
                toast('Names saved in the transcript — analyse again to use them in the minutes');
                setNames({});
                onSaved();
              } catch (e) {
                toast((e as Error).message, true);
              } finally {
                setBusy(false);
              }
            }}
          >
            Save names
          </button>
        </div>
      </div>
    </details>
  );
}
