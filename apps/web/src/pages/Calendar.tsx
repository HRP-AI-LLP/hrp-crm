import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Modal, Spinner, useToast } from '../components/ui';
import { ApiError, del, get, patch, post } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useUsers } from '../lib/hooks';

export interface CalEvent {
  id: string;
  title: string;
  kind: 'meeting' | 'call' | 'site_visit' | 'demo' | 'other';
  starts_at: string;
  ends_at: string;
  all_day: boolean;
  location: string | null;
  description: string | null;
  status: 'scheduled' | 'done' | 'cancelled';
  outcome: string | null;
  related_object: string | null;
  related_id: string | null;
  owner_id: string;
  owner_name: string | null;
  attendees: ({ userId: string } | { email: string; name?: string })[];
  reminder_minutes: number | null;
}

export const EVENT_KINDS: [CalEvent['kind'], string][] = [
  ['meeting', 'Meeting'],
  ['call', 'Call'],
  ['site_visit', 'Site visit'],
  ['demo', 'Demo'],
  ['other', 'Other'],
];
const KIND_COLOR: Record<string, string> = { meeting: '#0f8dde', call: '#06a6c7', site_visit: '#075492', demo: '#0b6d86', other: '#64748b' };
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const HOURS = Array.from({ length: 15 }, (_, i) => i + 7); // 07:00–21:00

const startOfWeek = (d: Date) => {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return x;
};
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
const hhmm = (d: Date) => d.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' });

export function CalendarPage() {
  const { me } = useAuth();
  const { data: users } = useUsers();
  const [params] = useSearchParams();
  const [view, setView] = useState<'week' | 'month'>('week');
  const [anchor, setAnchor] = useState(() => new Date());
  const [user, setUser] = useState<string>('');
  const [editing, setEditing] = useState<Partial<CalEvent> | null>(null);

  const range = useMemo(() => {
    if (view === 'week') {
      const s = startOfWeek(anchor);
      return { from: s, to: addDays(s, 7) };
    }
    const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
    const s = startOfWeek(first);
    return { from: s, to: addDays(s, 42) };
  }, [view, anchor]);

  const { data, isLoading } = useQuery({
    queryKey: ['events', range.from.toISOString(), range.to.toISOString(), user],
    queryFn: () => get<{ items: CalEvent[] }>(`/api/v1/events?from=${encodeURIComponent(range.from.toISOString())}&to=${encodeURIComponent(range.to.toISOString())}${user ? `&user=${user}` : ''}`),
  });
  const events = data?.items ?? [];
  // deep link from a reminder notification: /calendar?event=<id>
  const focus = params.get('event');
  const opened = useRef<string | null>(null);
  useEffect(() => {
    const ev = focus ? events.find((e) => e.id === focus) : undefined;
    if (ev && opened.current !== ev.id) {
      opened.current = ev.id;
      setAnchor(new Date(ev.starts_at));
      setEditing(ev);
    }
  }, [focus, events]);

  const step = (d: number) => setAnchor((a) => (view === 'week' ? addDays(a, 7 * d) : new Date(a.getFullYear(), a.getMonth() + d, 1)));
  const today = new Date();
  const title = view === 'week' ? `${range.from.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })} – ${addDays(range.from, 6).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}` : anchor.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });

  const newAt = (d: Date, hour = 10) => {
    const s = new Date(d.getFullYear(), d.getMonth(), d.getDate(), hour);
    setEditing({ title: '', kind: 'meeting', starts_at: s.toISOString(), ends_at: new Date(s.getTime() + 3600_000).toISOString(), reminder_minutes: 30, attendees: [] });
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Calendar</h1>
          <p>Meetings, calls and site visits — linked to the records they are about.</p>
        </div>
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <select value={user} onChange={(e) => setUser(e.target.value)} style={{ width: 'auto' }} aria-label="Whose calendar">
            <option value="">Everyone I can see</option>
            <option value={me?.user.id}>Only mine</option>
            {users?.items
              .filter((u) => u.id !== me?.user.id)
              .map((u) => (
                <option key={u.id} value={u.id}>
                  {u.full_name}
                </option>
              ))}
          </select>
          <div className="seg" role="group" aria-label="View">
            {(['week', 'month'] as const).map((v) => (
              <button key={v} aria-pressed={view === v} onClick={() => setView(v)}>
                {v === 'week' ? 'Week' : 'Month'}
              </button>
            ))}
          </div>
          <button className="btn" onClick={() => setAnchor(new Date())}>
            Today
          </button>
          <button className="btn" aria-label="Previous" onClick={() => step(-1)}>
            ←
          </button>
          <b style={{ minWidth: 170, textAlign: 'center' }}>{title}</b>
          <button className="btn" aria-label="Next" onClick={() => step(1)}>
            →
          </button>
          <button className="btn primary" onClick={() => newAt(today, Math.min(20, today.getHours() + 1))}>
            New event
          </button>
        </div>
      </div>
      <section className="panel cal">
        {isLoading && (
          <div className="panel-body">
            <Spinner />
          </div>
        )}
        {view === 'week' ? (
          <div className="cal-week">
            <div className="cal-corner" />
            {Array.from({ length: 7 }, (_, i) => addDays(range.from, i)).map((d, i) => (
              <div key={i} className={`cal-dayhead${sameDay(d, today) ? ' today' : ''}`}>
                <span>{DAYS[i]}</span>
                <b>{d.getDate()}</b>
              </div>
            ))}
            {HOURS.map((h) => (
              <div key={h} className="cal-row" style={{ display: 'contents' }}>
                <div className="cal-hour">{h > 12 ? `${h - 12} pm` : h === 12 ? '12 pm' : `${h} am`}</div>
                {Array.from({ length: 7 }, (_, i) => addDays(range.from, i)).map((d, i) => (
                  <button key={i} className="cal-slot" aria-label={`New event ${d.toDateString()} ${h}:00`} onClick={() => newAt(d, h)}>
                    {events
                      .filter((e) => {
                        const s = new Date(e.starts_at);
                        return sameDay(s, d) && (s.getHours() === h || (h === 7 && s.getHours() < 7) || (h === 21 && s.getHours() > 21));
                      })
                      .map((e) => (
                        <EventChip key={e.id} e={e} onOpen={() => setEditing(e)} />
                      ))}
                  </button>
                ))}
              </div>
            ))}
          </div>
        ) : (
          <div className="cal-month">
            {DAYS.map((d) => (
              <div key={d} className="cal-dayhead">
                <span>{d}</span>
              </div>
            ))}
            {Array.from({ length: 42 }, (_, i) => addDays(range.from, i)).map((d, i) => (
              <button key={i} className={`cal-cell${d.getMonth() !== anchor.getMonth() ? ' other' : ''}${sameDay(d, today) ? ' today' : ''}`} onClick={() => newAt(d)} aria-label={`New event on ${d.toDateString()}`}>
                <span className="cal-date">{d.getDate()}</span>
                {events
                  .filter((e) => sameDay(new Date(e.starts_at), d))
                  .slice(0, 4)
                  .map((e) => (
                    <EventChip key={e.id} e={e} onOpen={() => setEditing(e)} compact />
                  ))}
              </button>
            ))}
          </div>
        )}
      </section>
      {editing && <EventModal event={editing} onClose={() => setEditing(null)} />}
    </>
  );
}

function EventChip({ e, onOpen, compact }: { e: CalEvent; onOpen: () => void; compact?: boolean }) {
  return (
    <span
      role="button"
      tabIndex={0}
      className={`cal-event ${e.status}`}
      style={{ borderLeftColor: KIND_COLOR[e.kind] }}
      onClick={(ev) => {
        ev.stopPropagation();
        onOpen();
      }}
      onKeyDown={(ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') {
          ev.preventDefault();
          ev.stopPropagation();
          onOpen();
        }
      }}
    >
      <b>{hhmm(new Date(e.starts_at))}</b> {e.title}
      {!compact && e.location && <small>{e.location}</small>}
    </span>
  );
}

const toLocal = (iso?: string) => {
  if (!iso) return '';
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};

/** Create / edit / complete an event. Also used from record pages ("Schedule"). */
export function EventModal({ event, onClose }: { event: Partial<CalEvent>; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { me } = useAuth();
  const { data: users } = useUsers();
  const isNew = !event.id;
  const [f, setF] = useState({
    title: event.title ?? '',
    kind: event.kind ?? 'meeting',
    start: toLocal(event.starts_at),
    end: toLocal(event.ends_at),
    location: event.location ?? '',
    description: event.description ?? '',
    reminder: event.reminder_minutes === null || event.reminder_minutes === undefined ? '' : String(event.reminder_minutes),
    attendees: (event.attendees ?? []).filter((a): a is { userId: string } => 'userId' in a).map((a) => a.userId),
    guests: (event.attendees ?? []).filter((a): a is { email: string; name?: string } => 'email' in a).map((a) => a.email).join(', '),
    outcome: event.outcome ?? '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mine = isNew || event.owner_id === me?.user.id;

  const body = () => ({
    title: f.title.trim(),
    kind: f.kind,
    startsAt: new Date(f.start).toISOString(),
    endsAt: new Date(f.end).toISOString(),
    location: f.location || null,
    description: f.description || null,
    reminderMinutes: f.reminder === '' ? null : Number(f.reminder),
    attendees: [...f.attendees.map((userId) => ({ userId })), ...f.guests.split(/[,;\s]+/).filter((x) => /@/.test(x)).map((email) => ({ email }))],
    ...(isNew && event.related_object ? { relatedObject: event.related_object, relatedId: event.related_id } : {}),
  });
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      toast(ok);
      qc.invalidateQueries({ queryKey: ['events'] });
      if (event.related_object) qc.invalidateQueries({ queryKey: ['timeline', event.related_object, event.related_id] });
      onClose();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not save');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={isNew ? 'New event' : event.title ?? 'Event'}
      wide
      onClose={onClose}
      footer={
        <>
          {error && (
            <span className="field-error" style={{ marginRight: 'auto' }}>
              {error}
            </span>
          )}
          {!isNew && mine && (
            <button className="btn danger" onClick={() => window.confirm('Delete this event?') && run(() => del(`/api/v1/events/${event.id}`), 'Event deleted')}>
              Delete
            </button>
          )}
          {!isNew && mine && event.status === 'scheduled' && (
            <button className="btn" disabled={busy} onClick={() => run(() => patch(`/api/v1/events/${event.id}`, { status: 'done', outcome: f.outcome || null }), 'Marked as done')}>
              Mark done
            </button>
          )}
          {mine && (
            <button className="btn primary" disabled={busy || !f.title.trim() || !f.start || !f.end} onClick={() => run(() => (isNew ? post('/api/v1/events', body()) : patch(`/api/v1/events/${event.id}`, { ...body(), outcome: f.outcome || null })), isNew ? 'Event scheduled' : 'Event saved')}>
              {isNew ? 'Schedule' : 'Save'}
            </button>
          )}
        </>
      }
    >
      <div className="modal-body">
        <label className="field wide">
          Title
          <input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} disabled={!mine} placeholder="e.g. Site visit with Asha" autoFocus />
        </label>
        <label className="field">
          Type
          <select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value as CalEvent['kind'] })} disabled={!mine}>
            {EVENT_KINDS.map(([k, l]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          Reminder
          <select value={f.reminder} onChange={(e) => setF({ ...f, reminder: e.target.value })} disabled={!mine}>
            <option value="">None</option>
            {[[5, '5 minutes before'], [15, '15 minutes before'], [30, '30 minutes before'], [60, '1 hour before'], [1440, '1 day before']].map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          Starts
          <input
            type="datetime-local"
            value={f.start}
            disabled={!mine}
            onChange={(e) => {
              const dur = new Date(f.end).getTime() - new Date(f.start).getTime();
              const ns = e.target.value;
              setF({ ...f, start: ns, end: ns && Number.isFinite(dur) && dur > 0 ? toLocal(new Date(new Date(ns).getTime() + dur).toISOString()) : f.end });
            }}
          />
        </label>
        <label className="field">
          Ends
          <input type="datetime-local" value={f.end} onChange={(e) => setF({ ...f, end: e.target.value })} disabled={!mine} />
        </label>
        <label className="field wide">
          Location or meeting link
          <input value={f.location} onChange={(e) => setF({ ...f, location: e.target.value })} disabled={!mine} placeholder="Office, site address or https://meet…" />
        </label>
        <div className="field wide">
          <span>Team members</span>
          <div className="row" style={{ flexWrap: 'wrap', gap: 12 }}>
            {users?.items
              .filter((u) => u.id !== (event.owner_id ?? me?.user.id))
              .map((u) => (
                <label key={u.id} className="row">
                  <input type="checkbox" disabled={!mine} checked={f.attendees.includes(u.id)} onChange={(e) => setF({ ...f, attendees: e.target.checked ? [...f.attendees, u.id] : f.attendees.filter((x) => x !== u.id) })} />
                  {u.full_name}
                </label>
              ))}
          </div>
        </div>
        <label className="field wide">
          Guests (emails, optional)
          <input value={f.guests} onChange={(e) => setF({ ...f, guests: e.target.value })} disabled={!mine} placeholder="client@company.in" />
        </label>
        <label className="field wide">
          Agenda / notes
          <textarea rows={3} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} disabled={!mine} />
        </label>
        {!isNew && (
          <label className="field wide">
            Outcome {event.status === 'done' ? '' : '(added to the timeline when marked done)'}
            <textarea rows={2} value={f.outcome} onChange={(e) => setF({ ...f, outcome: e.target.value })} disabled={!mine} />
          </label>
        )}
        {event.related_object && event.related_id && (
          <p className="wide small" style={{ margin: 0 }}>
            About: <Link to={`/o/${event.related_object}/${event.related_id}`} onClick={onClose}>open the {event.related_object}</Link>
            {event.owner_name ? ` · organised by ${event.owner_name}` : ''}
          </p>
        )}
      </div>
    </Modal>
  );
}
