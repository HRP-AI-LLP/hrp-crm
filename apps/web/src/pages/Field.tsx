/**
 * "My day" — the mobile home of the installable app. One screen for people on the move:
 * check in at a site (GPS), capture a walk-in lead, tick off tasks, see today's jobs and follow-ups.
 * Visits, leads and task ticks work offline (outbox) and are sent when the network returns.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, type ReactNode, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { LEAD_SOURCES } from '@synapse/shared';
import { Modal, Spinner, useToast } from '../components/ui';
import { get } from '../lib/api';
import { useAuth } from '../lib/auth';
import { dateTime } from '../lib/format';
import { discardOutboxItem, flushOutbox, sendOrQueue, useOnline, useOutbox } from '../lib/outbox';
import { enablePush, isStandalone, pushConfig, pushSupported, useCurrentEndpoint, useInstallPrompt } from '../lib/pwa';

type Row = Record<string, any>;
interface Today {
  tasks: Row[];
  events: Row[];
  followUps: Row[];
  installations: Row[];
  shipments: Row[];
  tickets: Row[];
  visits: Row[];
}

const SEARCHABLE = ['lead', 'account', 'contact', 'deal'];
const OUTCOMES = ['Met the customer', 'Measurement done', 'Quotation discussed', 'Follow-up needed', 'Order confirmed', 'Not interested', 'Customer not available'];
const label = (s: string) => s.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
const time = (v: unknown) => (v ? new Date(String(v)).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '');

function dayRange(offset = 0) {
  const from = new Date();
  from.setHours(0, 0, 0, 0);
  from.setDate(from.getDate() + offset);
  const to = new Date(from);
  to.setDate(to.getDate() + 1);
  return { from: from.toISOString(), to: to.toISOString(), day: from };
}

function useLocation() {
  const [loc, setLoc] = useState<{ lat: number; lng: number; accuracy: number } | null>(null);
  const [state, setState] = useState<'idle' | 'locating' | 'denied'>('idle');
  const locate = () => {
    if (!navigator.geolocation) return setState('denied');
    setState('locating');
    navigator.geolocation.getCurrentPosition(
      (p) => {
        setLoc({ lat: +p.coords.latitude.toFixed(6), lng: +p.coords.longitude.toFixed(6), accuracy: Math.round(p.coords.accuracy) });
        setState('idle');
      },
      () => setState('denied'),
      { enableHighAccuracy: true, timeout: 15_000, maximumAge: 60_000 },
    );
  };
  return { loc, state, locate };
}

// ------------------------------------------------------------------------------- check-in
function VisitSheet({ owner, onClose, onDone }: { owner: string; onClose: () => void; onDone: (queued: boolean) => void }) {
  const toast = useToast();
  const online = useOnline();
  const [q, setQ] = useState('');
  const [pick, setPick] = useState<{ object: string; id: string; title: string } | null>(null);
  const [outcome, setOutcome] = useState(OUTCOMES[0]!);
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const gps = useLocation();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => gps.locate(), []);
  const search = useQuery({
    queryKey: ['visit-search', q],
    queryFn: () => get<{ results: { object: string; label: string; items: { id: string; title: string }[] }[] }>(`/api/v1/search?q=${encodeURIComponent(q)}`),
    enabled: online && q.trim().length >= 2 && !pick,
    staleTime: 30_000,
  });
  const hits = (search.data?.results ?? []).filter((r) => SEARCHABLE.includes(r.object)).flatMap((r) => r.items.slice(0, 5).map((i) => ({ ...i, object: r.object, kind: r.label })));
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!pick) return toast('Pick the customer you are visiting', true);
    setBusy(true);
    try {
      const r = await sendOrQueue(owner, {
        method: 'POST',
        path: `/api/v1/records/${pick.object}/${pick.id}/activities`,
        body: { kind: 'visit', subject: `Visit: ${outcome}`, body: notes || undefined, outcome, occurredAt: new Date().toISOString(), ...(gps.loc ? { location: gps.loc } : {}) },
        label: `Visit — ${pick.title}`,
      });
      onDone(r === null);
    } catch (err) {
      toast((err as Error).message, true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title="Check in"
      onClose={onClose}
      footer={
        <>
          <button className="btn" type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" form="visit-form" disabled={busy || !pick}>
            {busy ? 'Saving…' : 'Check in'}
          </button>
        </>
      }
    >
      <form id="visit-form" className="modal-body day-form" onSubmit={submit}>
        <div className={`day-gps ${gps.loc ? 'ok' : gps.state}`}>
          {gps.loc ? (
            <>
              📍 Location captured <span className="muted small">±{gps.loc.accuracy} m</span>
            </>
          ) : gps.state === 'locating' ? (
            'Reading your location…'
          ) : (
            <>
              Location not captured.{' '}
              <button type="button" className="link" onClick={gps.locate}>
                Try again
              </button>
            </>
          )}
        </div>
        {pick ? (
          <div className="spread day-pick">
            <span>
              <b>{pick.title}</b> <span className="muted small">{label(pick.object)}</span>
            </span>
            <button type="button" className="link" onClick={() => setPick(null)}>
              Change
            </button>
          </div>
        ) : (
          <label className="field">
            <span>Customer</span>
            <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder={online ? 'Search leads, accounts, contacts, deals' : 'Search needs a connection'} disabled={!online} />
            {hits.length > 0 && (
              <div className="day-hits" role="listbox">
                {hits.map((h) => (
                  <button type="button" key={`${h.object}:${h.id}`} role="option" aria-selected={false} onClick={() => setPick({ object: h.object, id: h.id, title: h.title })}>
                    <b>{h.title}</b>
                    <span className="muted small">{h.kind}</span>
                  </button>
                ))}
              </div>
            )}
          </label>
        )}
        <label className="field">
          <span>Outcome</span>
          <select value={outcome} onChange={(e) => setOutcome(e.target.value)}>
            {OUTCOMES.map((o) => (
              <option key={o}>{o}</option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Notes</span>
          <textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="What was discussed, measurements, next step…" />
        </label>
      </form>
    </Modal>
  );
}

// ------------------------------------------------------------------------------- walk-in lead
function LeadSheet({ owner, onClose, onDone }: { owner: string; onClose: () => void; onDone: (queued: boolean) => void }) {
  const toast = useToast();
  const [f, setF] = useState({ first_name: '', last_name: '', phone: '', email: '', company: '', source: 'walk_in', source_detail: '', follow: 'tomorrow' });
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!f.last_name.trim()) return toast('Enter the customer’s name', true);
    if (!f.phone.trim() && !f.email.trim()) return toast('Add a phone number or email', true);
    let follow: string | undefined;
    if (f.follow !== 'none') {
      const d = new Date();
      d.setDate(d.getDate() + (f.follow === 'tomorrow' ? 1 : 3));
      d.setHours(11, 0, 0, 0);
      follow = d.toISOString();
    }
    setBusy(true);
    try {
      const body: Row = { last_name: f.last_name.trim(), source: f.source };
      for (const k of ['first_name', 'phone', 'email', 'company', 'source_detail'] as const) if (f[k].trim()) body[k] = f[k].trim();
      if (follow) body.next_follow_up_at = follow;
      const r = await sendOrQueue(owner, { method: 'POST', path: '/api/v1/records/lead', body, label: `New lead — ${[f.first_name, f.last_name].filter(Boolean).join(' ')}` });
      onDone(r === null);
    } catch (err) {
      toast((err as Error).message, true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title="New walk-in lead"
      onClose={onClose}
      footer={
        <>
          <button className="btn" type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" form="lead-form" disabled={busy}>
            {busy ? 'Saving…' : 'Save lead'}
          </button>
        </>
      }
    >
      <form id="lead-form" className="modal-body day-form" onSubmit={submit}>
        <div className="grid2">
          <label className="field">
            <span>First name</span>
            <input value={f.first_name} onChange={set('first_name')} autoComplete="off" />
          </label>
          <label className="field">
            <span>Last name *</span>
            <input value={f.last_name} onChange={set('last_name')} autoComplete="off" required />
          </label>
        </div>
        <div className="grid2">
          <label className="field">
            <span>Phone</span>
            <input type="tel" inputMode="tel" value={f.phone} onChange={set('phone')} />
          </label>
          <label className="field">
            <span>Email</span>
            <input type="email" inputMode="email" value={f.email} onChange={set('email')} />
          </label>
        </div>
        <label className="field">
          <span>Company / project</span>
          <input value={f.company} onChange={set('company')} />
        </label>
        <div className="grid2">
          <label className="field">
            <span>Source</span>
            <select value={f.source} onChange={set('source')}>
              {LEAD_SOURCES.map((s) => (
                <option key={s} value={s}>
                  {label(s)}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Follow up</span>
            <select value={f.follow} onChange={set('follow')}>
              <option value="tomorrow">Tomorrow 11:00</option>
              <option value="3d">In 3 days</option>
              <option value="none">No reminder</option>
            </select>
          </label>
        </div>
        <label className="field">
          <span>Requirement</span>
          <input value={f.source_detail} onChange={set('source_detail')} placeholder="e.g. Modular kitchen, 3BHK, budget 4L" maxLength={250} />
        </label>
      </form>
    </Modal>
  );
}

// ------------------------------------------------------------------------------- cards
function Section({ title, count, children, empty }: { title: string; count: number; children: ReactNode; empty?: string }) {
  if (!count && !empty) return null;
  return (
    <section className="day-section">
      <h3>
        {title} {count > 0 && <span className="chip">{count}</span>}
      </h3>
      {count ? <div className="day-list">{children}</div> : <p className="muted small">{empty}</p>}
    </section>
  );
}

function SetupCards() {
  const toast = useToast();
  const inst = useInstallPrompt();
  const cfg = useQuery({ queryKey: ['push-config'], queryFn: pushConfig, staleTime: 300_000 });
  const [endpoint, refresh] = useCurrentEndpoint();
  const [hidden, setHidden] = useState(() => {
    try {
      return localStorage.getItem('synapse.day.setup-hidden') === '1';
    } catch {
      return false;
    }
  });
  const showPush = pushSupported() && cfg.data?.enabled && endpoint === null && (typeof Notification === 'undefined' || Notification.permission !== 'denied');
  const showInstall = !isStandalone() && (inst.canInstall || inst.iosHint);
  if (hidden || (!showPush && !showInstall)) return null;
  return (
    <div className="day-setup">
      {showInstall && (
        <div>
          <b>Install Synapse on this phone</b>
          <p className="muted small">{inst.canInstall ? 'Opens full-screen from your home screen and works with a weak signal.' : 'In Safari tap Share, then “Add to Home Screen”.'}</p>
          {inst.canInstall && (
            <button className="btn primary sm" onClick={() => void inst.install()}>
              Install app
            </button>
          )}
        </div>
      )}
      {showPush && (
        <div>
          <b>Get reminders on this device</b>
          <p className="muted small">Follow-ups, new leads, jobs and approvals — even when the app is closed.</p>
          <button
            className="btn primary sm"
            onClick={async () => {
              try {
                await enablePush(cfg.data!.publicKey!);
                refresh();
                toast('Notifications are on for this device');
              } catch (e) {
                toast((e as Error).message, true);
              }
            }}
          >
            Turn on notifications
          </button>
        </div>
      )}
      <button
        className="link small"
        onClick={() => {
          setHidden(true);
          try {
            localStorage.setItem('synapse.day.setup-hidden', '1');
          } catch {
            /* ignore */
          }
        }}
      >
        Not now
      </button>
    </div>
  );
}

export function FieldPage() {
  const { me } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const online = useOnline();
  const [params, setParams] = useSearchParams();
  const [offset, setOffset] = useState(0);
  const range = useMemo(() => dayRange(offset), [offset]);
  const owner = me ? `${me.tenant.id}:${me.user.id}` : null;
  const refresh = () => qc.invalidateQueries({ queryKey: ['field-today'] });
  const outbox = useOutbox(owner, (r) => {
    if (r.sent) toast(`${r.sent} saved item${r.sent > 1 ? 's' : ''} sent`);
    if (r.failed) toast(`${r.failed} item${r.failed > 1 ? 's were' : ' was'} rejected — see “Waiting to send”`, true);
    refresh();
  });
  const { data, isLoading, error } = useQuery({
    queryKey: ['field-today', range.from],
    queryFn: () => get<Today>(`/api/v1/field/today?from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}`),
    refetchInterval: () => (document.visibilityState === 'visible' ? 120_000 : false),
    networkMode: 'offlineFirst',
  });
  const sheet = params.get('new');
  const close = () => {
    params.delete('new');
    setParams(params, { replace: true });
  };
  const done = (what: string) => (queued: boolean) => {
    close();
    toast(queued ? `${what} saved on this device — it will be sent when you are back online` : `${what} saved`);
    if (!queued) refresh();
  };
  const tick = async (t: Row) => {
    if (!owner) return;
    try {
      const r = await sendOrQueue(owner, { method: 'PATCH', path: `/api/v1/tasks/${t.id}`, body: { status: 'done' }, label: `Done — ${t.title}` });
      toast(r === null ? 'Marked done — will sync when online' : 'Task done');
      qc.setQueryData<Today>(['field-today', range.from], (d) => (d ? { ...d, tasks: d.tasks.filter((x) => x.id !== t.id) } : d));
    } catch (e) {
      toast((e as Error).message, true);
    }
  };
  const now = Date.now();
  const d = data;
  const jobs = (d?.installations.length ?? 0) + (d?.shipments.length ?? 0);
  const dayName = offset === 0 ? 'Today' : offset === 1 ? 'Tomorrow' : range.day.toLocaleDateString([], { weekday: 'long' });

  return (
    <div className="day">
      <div className="day-head">
        <div>
          <span className="muted small">{range.day.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' })}</span>
          <h1>
            {offset === 0 ? `Hi ${me?.user.fullName.split(' ')[0] ?? ''}` : dayName}
          </h1>
        </div>
        <div className="seg" role="group" aria-label="Day">
          {[0, 1].map((o) => (
            <button key={o} aria-pressed={offset === o} onClick={() => setOffset(o)}>
              {o === 0 ? 'Today' : 'Tomorrow'}
            </button>
          ))}
        </div>
      </div>

      {!online && <div className="notice day-offline">You are offline. Visits, leads and task ticks are saved on this phone and sent when you reconnect.</div>}

      <div className="day-actions">
        <button className="day-action" onClick={() => setParams({ new: 'visit' })}>
          <span aria-hidden="true">📍</span>
          Check in
        </button>
        <button className="day-action" onClick={() => setParams({ new: 'lead' })}>
          <span aria-hidden="true">＋</span>
          Walk-in lead
        </button>
        <Link className="day-action" to="/calendar">
          <span aria-hidden="true">🗓</span>
          Calendar
        </Link>
      </div>

      <SetupCards />

      {outbox.length > 0 && (
        <section className="day-section day-outbox">
          <h3>
            Waiting to send <span className="chip">{outbox.length}</span>
            {online && owner && (
              <button className="btn sm" style={{ marginLeft: 'auto' }} onClick={() => void flushOutbox(owner).then(refresh)}>
                Send now
              </button>
            )}
          </h3>
          <div className="day-list">
            {outbox.map((o) => (
              <div key={o.id} className="day-item">
                <div className="grow">
                  <b>{o.label}</b>
                  <span className="muted small">
                    Saved {dateTime(o.createdAt)}
                    {o.lastError ? ` · ${o.lastError}` : ''}
                  </span>
                </div>
                {o.lastError && (
                  <button className="link small" onClick={() => void discardOutboxItem(o.id)}>
                    Discard
                  </button>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      {isLoading && !d ? (
        <Spinner />
      ) : error && !d ? (
        <p className="muted">Could not load your day{online ? '' : ' while offline'}.</p>
      ) : d ? (
        <>
          <div className="kpis day-kpis">
            <div className="panel kpi">
              <div className="l">Visits</div>
              <div className="v">{d.visits.length}</div>
            </div>
            <div className="panel kpi">
              <div className="l">Follow-ups</div>
              <div className="v">{d.followUps.length}</div>
            </div>
            <div className="panel kpi">
              <div className="l">Tasks</div>
              <div className="v">{d.tasks.length}</div>
            </div>
            {jobs > 0 && (
              <div className="panel kpi">
              <div className="l">Jobs</div>
              <div className="v">{jobs}</div>
            </div>
            )}
          </div>

          <Section title="Schedule" count={d.events.length}>
            {d.events.map((e) => (
              <div key={e.id} className="day-item">
                <span className="day-time">{e.all_day ? 'All day' : time(e.starts_at)}</span>
                <div className="grow">
                  <b>{e.title}</b>
                  <span className="muted small">
                    {label(e.kind)}
                    {e.location ? ` · ${e.location}` : ''}
                  </span>
                </div>
                {e.location && (
                  <a className="btn sm" href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(e.location)}`} target="_blank" rel="noreferrer">
                    Map
                  </a>
                )}
              </div>
            ))}
          </Section>

          <Section title="Jobs" count={jobs}>
            {d.installations.map((j) => (
              <Link key={j.id} to={`/o/installation/${j.id}`} className="day-item">
                <span className="day-time">{time(j.scheduled_start)}</span>
                <div className="grow">
                  <b>{j.name ?? j.job_number ?? 'Installation'}</b>
                  <span className="muted small">
                    Installation · {label(j.status)}
                    {j.site_address ? ` · ${j.site_address}` : ''}
                  </span>
                </div>
              </Link>
            ))}
            {d.shipments.map((s) => (
              <Link key={s.id} to={`/o/shipment/${s.id}`} className="day-item">
                <span className="day-time">{s.planned_date && new Date(s.planned_date) < range.day ? 'Late' : 'Drop'}</span>
                <div className="grow">
                  <b>{s.name ?? s.shipment_number ?? 'Delivery'}</b>
                  <span className="muted small">
                    Delivery · {label(s.status)}
                    {s.delivery_address ? ` · ${s.delivery_address}` : ''}
                  </span>
                </div>
              </Link>
            ))}
          </Section>

          <Section title="Follow-ups" count={d.followUps.length} empty="No follow-ups due.">
            {d.followUps.map((l) => {
              const due = l.next_follow_up_at ? Date.parse(l.next_follow_up_at) : 0;
              return (
                <div key={l.id} className="day-item">
                  <span className={`day-time${due < now ? ' late' : ''}`}>{due < range.day.getTime() ? 'Overdue' : time(l.next_follow_up_at)}</span>
                  <Link to={`/o/lead/${l.id}`} className="grow">
                    <b>{l.full_name}</b>
                    <span className="muted small">{[l.company, l.source && label(l.source)].filter(Boolean).join(' · ')}</span>
                  </Link>
                  {l.phone && (
                    <>
                      <a className="btn sm" href={`tel:${l.phone}`} aria-label={`Call ${l.full_name}`}>
                        Call
                      </a>
                      <a className="btn sm" href={`https://wa.me/${String(l.phone).replace(/\D/g, '')}`} target="_blank" rel="noreferrer" aria-label={`WhatsApp ${l.full_name}`}>
                        WhatsApp
                      </a>
                    </>
                  )}
                </div>
              );
            })}
          </Section>

          <Section title="Tasks" count={d.tasks.length} empty="Nothing due. Nice.">
            {d.tasks.map((t) => (
              <div key={t.id} className="day-item">
                <input type="checkbox" aria-label={`Mark “${t.title}” done`} onChange={() => void tick(t)} />
                <div className="grow">
                  <b>{t.title}</b>
                  <span className={`small ${Date.parse(t.due_at) < now ? 'day-late' : 'muted'}`}>
                    {Date.parse(t.due_at) < range.day.getTime() ? `Overdue · ${dateTime(t.due_at)}` : `Due ${time(t.due_at)}`}
                    {t.priority !== 'normal' ? ` · ${label(t.priority)}` : ''}
                  </span>
                </div>
              </div>
            ))}
          </Section>

          <Section title="My open tickets" count={d.tickets.length}>
            {d.tickets.map((t) => (
              <Link key={t.id} to={`/o/ticket/${t.id}`} className="day-item">
                <div className="grow">
                  <b>
                    {t.ticket_number} · {t.name}
                  </b>
                  <span className="muted small">
                    {label(t.status)} · {label(t.priority ?? 'normal')}
                    {t.resolution_due ? ` · due ${dateTime(t.resolution_due)}` : ''}
                  </span>
                </div>
              </Link>
            ))}
          </Section>

          <Section title="Visits logged" count={d.visits.length} empty={offset === 0 ? 'No visits yet today — tap “Check in” when you reach a site.' : undefined}>
            {d.visits.map((v) => (
              <Link key={v.id} to={`/o/${v.related_object}/${v.related_id}`} className="day-item">
                <span className="day-time">{time(v.occurred_at)}</span>
                <div className="grow">
                  <b>{v.subject ?? 'Visit'}</b>
                  <span className="muted small">
                    {v.metadata?.location ? `📍 ±${v.metadata.location.accuracy ?? '?'} m` : 'No location'}
                    {v.body ? ` · ${String(v.body).slice(0, 80)}` : ''}
                  </span>
                </div>
              </Link>
            ))}
          </Section>
        </>
      ) : null}

      {owner && sheet === 'visit' && <VisitSheet owner={owner} onClose={close} onDone={done('Visit')} />}
      {owner && sheet === 'lead' && <LeadSheet owner={owner} onClose={close} onDone={done('Lead')} />}
    </div>
  );
}
