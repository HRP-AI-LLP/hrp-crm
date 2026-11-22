import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Spinner } from '../components/ui';
import { date, dateTime } from '../lib/format';

type Json = Record<string, any>;

async function call<T>(path: string, body?: unknown): Promise<T> {
  const r = await fetch(path, body === undefined ? undefined : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j?.error?.message ?? 'Something went wrong');
  return j as T;
}

/** Finger / mouse signature on a canvas; returns a PNG data URL (or null when empty). */
function SignaturePad({ onChange }: { onChange: (png: string | null) => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const dirty = useRef(false);
  useEffect(() => {
    const c = ref.current!;
    const ratio = window.devicePixelRatio || 1;
    c.width = c.offsetWidth * ratio;
    c.height = c.offsetHeight * ratio;
    const g = c.getContext('2d')!;
    g.scale(ratio, ratio);
    g.lineWidth = 2.2;
    g.lineCap = 'round';
    g.strokeStyle = '#0f172a';
  }, []);
  const pos = (e: React.PointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top] as const;
  };
  return (
    <div className="sig-wrap">
      <canvas
        ref={ref}
        className="sig"
        aria-label="Sign here"
        onPointerDown={(e) => {
          drawing.current = true;
          ref.current!.setPointerCapture(e.pointerId);
          const g = ref.current!.getContext('2d')!;
          g.beginPath();
          g.moveTo(...pos(e));
        }}
        onPointerMove={(e) => {
          if (!drawing.current) return;
          const g = ref.current!.getContext('2d')!;
          g.lineTo(...pos(e));
          g.stroke();
          dirty.current = true;
        }}
        onPointerUp={() => {
          drawing.current = false;
          if (dirty.current) onChange(ref.current!.toDataURL('image/png'));
        }}
      />
      <button
        type="button"
        className="btn sm ghost"
        onClick={() => {
          const c = ref.current!;
          c.getContext('2d')!.clearRect(0, 0, c.width, c.height);
          dirty.current = false;
          onChange(null);
        }}
      >
        Clear
      </button>
    </div>
  );
}

function Stars({ value, onChange }: { value: number; onChange: (n: number) => void }) {
  return (
    <div className="stars" role="radiogroup" aria-label="Rating">
      {[1, 2, 3, 4, 5].map((n) => (
        <button key={n} type="button" role="radio" aria-checked={value === n} aria-label={`${n} star${n > 1 ? 's' : ''}`} className={n <= value ? 'on' : ''} onClick={() => onChange(n)}>
          ★
        </button>
      ))}
    </div>
  );
}

/** /d/:token and /i/:token — delivery confirmation and installation sign-off. */
export function JobConfirmPage({ kind }: { kind: 'shipment' | 'installation' }) {
  const { token = '' } = useParams();
  const [job, setJob] = useState<Json | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [rating, setRating] = useState(0);
  const [feedback, setFeedback] = useState('');
  const [sig, setSig] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const load = () =>
    call<Json>(`/api/public/jobs/${kind}/${encodeURIComponent(token)}`)
      .then((j) => {
        setJob(j);
        document.title = `${j.number} — ${j.company}`;
      })
      .catch(() => setErr('This link is not valid any more. Please contact the store.'));
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, kind]);
  if (err && !job) return <div className="public-wrap"><p>{err}</p></div>;
  if (!job) return <div className="public-wrap"><Spinner /></div>;
  const canConfirm = !job.confirmedAt && (kind === 'shipment' ? ['dispatched', 'delivered'].includes(job.status) : job.status === 'completed');
  return (
    <div className="public-wrap customer-page">
      <header className="cp-head">
        <b>{job.company}</b>
        <span className="muted small">{job.number}</span>
      </header>
      <h1>{kind === 'shipment' ? (job.status === 'delivered' ? 'Your order was delivered' : job.status === 'dispatched' ? 'Your order is on its way' : 'Your delivery') : job.status === 'completed' ? 'Installation complete' : 'Your installation'}</h1>
      <section className="panel cp-card">
        {kind === 'shipment' ? (
          <>
            {job.dispatchedAt && <p>Dispatched {dateTime(job.dispatchedAt)}</p>}
            {job.deliveredAt && <p>Delivered {dateTime(job.deliveredAt)}</p>}
            {!job.deliveredAt && job.plannedDate && <p>Expected {date(job.plannedDate)}</p>}
            {job.vehicleNo && (
              <p>
                Vehicle {job.vehicleNo}
                {job.driverName ? ` · ${job.driverName}` : ''}
                {job.driverPhone ? (
                  <>
                    {' · '}
                    <a href={`tel:${job.driverPhone}`}>{job.driverPhone}</a>
                  </>
                ) : null}
              </p>
            )}
            {job.address && <p className="muted">{job.address}</p>}
            <ul className="cp-items">
              {job.items.map((i: Json, k: number) => (
                <li key={k}>
                  {i.name} <b>× {i.quantity}</b> {i.unit ?? ''}
                </li>
              ))}
            </ul>
          </>
        ) : (
          <>
            {job.scheduledStart && <p>Scheduled {dateTime(job.scheduledStart)}</p>}
            {job.technician && <p>Technician: {job.technician}</p>}
            {job.address && <p className="muted">{job.address}</p>}
            <ul className="cp-items">
              {job.checklist.map((c: Json, k: number) => (
                <li key={k}>
                  {c.done ? '✓' : '○'} {c.label}
                </li>
              ))}
            </ul>
            {job.notes && <p>Notes: {job.notes}</p>}
          </>
        )}
      </section>
      {(done || job.confirmedAt) && (
        <section className="panel cp-card">
          <p>
            <b>Thank you{job.confirmedBy ? `, ${job.confirmedBy}` : ''}!</b> {kind === 'shipment' ? 'Your confirmation of delivery is recorded.' : 'Your sign-off is recorded.'}
          </p>
        </section>
      )}
      {canConfirm && !done && (
        <section className="panel cp-card">
          <h2>{kind === 'shipment' ? 'Confirm you received it' : 'Sign off the installation'}</h2>
          <label className="field">
            Your name
            <input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" />
          </label>
          <div className="field">
            <span>How was it?</span>
            <Stars value={rating} onChange={setRating} />
          </div>
          <label className="field">
            Anything to tell us? (optional)
            <textarea value={feedback} onChange={(e) => setFeedback(e.target.value)} maxLength={2000} />
          </label>
          <div className="field">
            <span>Signature (optional)</span>
            <SignaturePad onChange={setSig} />
          </div>
          {err && <p className="field-error">{err}</p>}
          <button
            className="btn primary"
            disabled={busy || name.trim().length < 2}
            onClick={async () => {
              setBusy(true);
              setErr(null);
              try {
                await call(`/api/public/jobs/${kind}/${encodeURIComponent(token)}/confirm`, { name: name.trim(), rating: rating || null, feedback: feedback.trim() || null, signature: sig });
                setDone(true);
                await load();
              } catch (e) {
                setErr((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            {kind === 'shipment' ? 'Confirm delivery' : 'Sign off'}
          </button>
        </section>
      )}
      <p className="muted small" style={{ textAlign: 'center', margin: '24px 0' }}>
        Sent with SanchalanOS
      </p>
    </div>
  );
}

const T_STATUS: Record<string, string> = { new: 'Received', open: 'Open', in_progress: 'Being worked on', waiting_customer: 'Waiting for your reply', resolved: 'Resolved', closed: 'Closed' };

/** /t/:token — the customer follows a complaint, replies, and rates the resolution. */
export function TicketStatusPage() {
  const { token = '' } = useParams();
  const [t, setT] = useState<Json | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState('');
  const [rating, setRating] = useState(0);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const load = () =>
    call<Json>(`/api/public/tickets/${encodeURIComponent(token)}`)
      .then((j) => {
        setT(j);
        document.title = `${j.number} — ${j.company}`;
      })
      .catch(() => setErr('This link is not valid any more.'));
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);
  const send = async (body: Json) => {
    setBusy(true);
    setErr(null);
    try {
      await call(`/api/public/tickets/${encodeURIComponent(token)}`, body);
      setMsg('');
      await load();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  if (err && !t) return <div className="public-wrap"><p>{err}</p></div>;
  if (!t) return <div className="public-wrap"><Spinner /></div>;
  const resolved = ['resolved', 'closed'].includes(t.status);
  return (
    <div className="public-wrap customer-page">
      <header className="cp-head">
        <b>{t.company}</b>
        <span className="muted small">{t.number}</span>
      </header>
      <h1>{t.subject}</h1>
      <p>
        <span className={`chip ${resolved ? 'good' : 'info'}`}>{T_STATUS[t.status] ?? t.status}</span> <span className="muted small">Raised {dateTime(t.createdAt)}</span>
      </p>
      {t.resolution && (
        <section className="panel cp-card">
          <h2>Resolution</h2>
          <p style={{ whiteSpace: 'pre-wrap' }}>{t.resolution}</p>
        </section>
      )}
      {t.updates.length > 0 && (
        <section className="panel cp-card">
          <h2>Updates</h2>
          <ul className="cp-updates">
            {t.updates.map((u: Json, i: number) => (
              <li key={i} className={u.from}>
                <span className="muted small">
                  {u.from === 'you' ? 'You' : t.company} · {dateTime(u.at)}
                </span>
                <div>{u.text}</div>
              </li>
            ))}
          </ul>
        </section>
      )}
      {resolved && !t.satisfaction && (
        <section className="panel cp-card">
          <h2>How did we do?</h2>
          <Stars value={rating} onChange={setRating} />
          <label className="field" style={{ marginTop: 8 }}>
            Comment (optional)
            <input value={comment} onChange={(e) => setComment(e.target.value)} />
          </label>
          <button className="btn primary" disabled={busy || !rating} onClick={() => send({ rating, comment: comment || null })}>
            Send rating
          </button>
        </section>
      )}
      <section className="panel cp-card">
        <h2>{resolved ? 'Still a problem?' : 'Add a message'}</h2>
        <textarea value={msg} onChange={(e) => setMsg(e.target.value)} maxLength={4000} aria-label="Message" />
        {err && <p className="field-error">{err}</p>}
        <button className="btn" disabled={busy || !msg.trim()} onClick={() => send({ message: msg })}>
          {resolved ? 'Reopen with this message' : 'Send'}
        </button>
      </section>
      <p className="muted small" style={{ textAlign: 'center', margin: '24px 0' }}>
        Sent with SanchalanOS
      </p>
    </div>
  );
}

/** Where Razorpay sends the customer after paying a payment link. */
export function PaidPage() {
  const q = new URLSearchParams(window.location.search);
  const ok = q.get('razorpay_payment_link_status') !== 'cancelled' && !q.get('error');
  return (
    <div className="public-wrap customer-page">
      <div className="cp-card" style={{ textAlign: 'center' }}>
        <h1>{ok ? 'Thank you — payment received' : 'Payment not completed'}</h1>
        <p className="muted">
          {ok ? 'Your payment reference is ' : 'You can use the same payment link to try again.'}
          {ok && <b>{q.get('razorpay_payment_id') ?? '—'}</b>}
        </p>
        {ok && <p className="muted small">A receipt will follow from the business. You can close this page.</p>}
      </div>
    </div>
  );
}

/* ───────────── client project portal ───────────── */

const CR_LABEL: Record<string, string> = {
  submitted: 'Waiting for your approval',
  approved: 'Approved',
  rejected: 'Rejected',
  implemented: 'Done',
};

/** What a customer sees of their project: progress, milestones, the running sprint, releases, change requests. */
export function ProjectPortalPage() {
  const { token = '' } = useParams();
  const [p, setP] = useState<Json | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [note, setNote] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const load = () =>
    call<Json>(`/api/public/portal/${encodeURIComponent(token)}`)
      .then((j) => {
        setP(j);
        document.title = `${j.project.name} — ${j.company}`;
      })
      .catch(() => setErr('This link is not valid any more.'));
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);
  const decide = async (id: string, decision: 'approve' | 'reject') => {
    setBusy(true);
    setErr(null);
    try {
      await call(`/api/public/portal/${encodeURIComponent(token)}/change-requests/${id}`, { decision, name, note: note[id] || null });
      await load();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  if (err && !p)
    return (
      <div className="public-wrap">
        <p>{err}</p>
      </div>
    );
  if (!p)
    return (
      <div className="public-wrap">
        <Spinner />
      </div>
    );
  const pr = p.project;
  const pct = Math.round(Number(pr.progress ?? 0));
  const pending = (p.changeRequests as Json[]).filter((c) => c.status === 'submitted');
  return (
    <div className="public-wrap customer-page">
      <header className="cp-head">
        <b>{p.company}</b>
        <span className="muted small">Project status · {date(p.asOf)}</span>
      </header>
      <h1>{pr.name}</h1>
      <p className="muted small">
        {pr.account_name && <>For {pr.account_name} · </>}
        {pr.manager && <>Project manager: {pr.manager} · </>}
        {pr.start_date && date(pr.start_date)} – {pr.end_date ? date(pr.end_date) : 'ongoing'}
      </p>
      <section className="panel cp-card">
        <h2>Progress</h2>
        <div style={{ height: 12, borderRadius: 6, background: '#e5e7eb' }}>
          <div
            style={{
              width: `${pct}%`,
              height: 12,
              borderRadius: 6,
              background: '#0f8dde',
            }}
          />
        </div>
        <p className="small">
          {pct}% complete · {p.tasks?.done ?? 0} of {p.tasks?.total ?? 0} work items done
        </p>
      </section>
      {p.sprint && (
        <section className="panel cp-card">
          <h2>Current sprint: {p.sprint.name}</h2>
          {p.sprint.goal && <p>{p.sprint.goal}</p>}
          <p className="small muted">
            {date(p.sprint.start_date)} – {date(p.sprint.end_date)} · {p.sprint.done_items} of {p.sprint.items} items done ({p.sprint.done} of {p.sprint.committed} points)
          </p>
        </section>
      )}
      {p.milestones.length > 0 && (
        <section className="panel cp-card">
          <h2>Milestones</h2>
          <ul className="cp-updates">
            {p.milestones.map((m: Json, i: number) => (
              <li key={i}>
                {m.status === 'done' ? '✅' : '⏳'} <b>{m.name}</b> <span className="muted small">{m.due_date ? `due ${date(m.due_date)}` : ''}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      {p.changeRequests.length > 0 && (
        <section className="panel cp-card">
          <h2>Change requests</h2>
          {pending.length > 0 && (
            <label className="field">
              Your name (for approvals)
              <input value={name} onChange={(e) => setName(e.target.value)} />
            </label>
          )}
          {p.changeRequests.map((c: Json) => (
            <div key={c.id} style={{ borderTop: '1px solid #e5e7eb', padding: '10px 0' }}>
              <b>
                CR-{c.cr_number}: {c.title}
              </b>{' '}
              <span className={`chip ${c.status === 'approved' || c.status === 'implemented' ? 'good' : c.status === 'rejected' ? 'bad' : 'warn'}`}>{CR_LABEL[c.status] ?? c.status}</span>
              {c.description && <p style={{ whiteSpace: 'pre-wrap', margin: '6px 0' }}>{c.description}</p>}
              <p className="small muted" style={{ margin: '4px 0' }}>
                Impact: {c.impact_hours} hours · ₹{Number(c.impact_amount).toLocaleString('en-IN')} + GST · {c.impact_days} days to the schedule
                {c.decided_by && ` · ${c.status} by ${c.decided_by}`}
              </p>
              {c.status === 'submitted' && (
                <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                  <input placeholder="Comment (needed to reject)" value={note[c.id] ?? ''} onChange={(e) => setNote({ ...note, [c.id]: e.target.value })} style={{ flex: 1 }} />
                  <button className="btn primary" disabled={busy || name.trim().length < 2} onClick={() => decide(c.id, 'approve')}>
                    Approve
                  </button>
                  <button className="btn" disabled={busy || name.trim().length < 2 || !(note[c.id] ?? '').trim()} onClick={() => decide(c.id, 'reject')}>
                    Reject
                  </button>
                </div>
              )}
            </div>
          ))}
          {err && <p className="field-error">{err}</p>}
        </section>
      )}
      {p.releases.length > 0 && (
        <section className="panel cp-card">
          <h2>Releases</h2>
          {p.releases.map((r: Json, i: number) => (
            <details key={i} open={i === 0 && r.status === 'released'}>
              <summary>
                <b>{r.name}</b> {r.version} · {r.status === 'released' ? `released ${date(r.released_at)}` : r.target_date ? `planned for ${date(r.target_date)}` : r.status.replace('_', ' ')}
              </summary>
              {r.notes && <pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit' }}>{r.notes}</pre>}
            </details>
          ))}
        </section>
      )}
      <p className="muted small" style={{ textAlign: 'center', margin: '24px 0' }}>
        Sent with SanchalanOS
      </p>
    </div>
  );
}

/* ───────────── public product roadmap ───────────── */

const RM_LABEL: Record<string, string> = {
  in_progress: 'Building now',
  planned: 'Planned',
  under_review: 'Considering',
  released: 'Released',
};

export function PublicRoadmapPage() {
  const { token = '' } = useParams();
  const [r, setR] = useState<Json | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [f, setF] = useState({
    title: '',
    description: '',
    name: '',
    email: '',
  });
  const [sent, setSent] = useState(false);
  useEffect(() => {
    call<Json>(`/api/public/roadmap/${encodeURIComponent(token)}`)
      .then((j) => {
        setR(j);
        document.title = `${j.product.name} roadmap — ${j.company}`;
      })
      .catch(() => setErr('This roadmap is not shared any more.'));
  }, [token]);
  if (err && !r)
    return (
      <div className="public-wrap">
        <p>{err}</p>
      </div>
    );
  if (!r)
    return (
      <div className="public-wrap">
        <Spinner />
      </div>
    );
  const groups = ['in_progress', 'planned', 'under_review', 'released'].map((s) => [s, (r.items as Json[]).filter((i) => i.status === s)] as const).filter(([, xs]) => xs.length);
  return (
    <div className="public-wrap customer-page">
      <header className="cp-head">
        <b>{r.company}</b>
        <span className="muted small">Product roadmap</span>
      </header>
      <h1>{r.product.name}</h1>
      {r.product.vision && <p>{r.product.vision}</p>}
      {groups.map(([s, xs]) => (
        <section key={s} className="panel cp-card">
          <h2>{RM_LABEL[s]}</h2>
          {xs.map((i: Json, k: number) => (
            <div
              key={k}
              style={{
                borderTop: k ? '1px solid #e5e7eb' : undefined,
                padding: '8px 0',
              }}
            >
              <b>{i.title}</b> {i.quarter && <span className="chip">{i.quarter}</span>} {i.votes > 0 && <span className="chip">👍 {i.votes}</span>}
              {i.release_name && (
                <span className="chip good">
                  {i.release_name}
                  {i.release_version ? ` ${i.release_version}` : ''}
                </span>
              )}
              {i.description && (
                <p className="small" style={{ margin: '4px 0', whiteSpace: 'pre-wrap' }}>
                  {i.description}
                </p>
              )}
            </div>
          ))}
        </section>
      ))}
      <section className="panel cp-card">
        <h2>Ask for a feature</h2>
        {sent ? (
          <p>Thank you — the product team will look at it.</p>
        ) : (
          <>
            <label className="field">
              What would help you?
              <input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} maxLength={300} />
            </label>
            <label className="field">
              Tell us more (optional)
              <textarea value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} maxLength={5000} />
            </label>
            <label className="field">
              Your name
              <input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} maxLength={120} />
            </label>
            <label className="field">
              Email (optional)
              <input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} maxLength={200} />
            </label>
            {err && <p className="field-error">{err}</p>}
            <button
              className="btn primary"
              disabled={f.title.trim().length < 3 || f.name.trim().length < 2}
              onClick={async () => {
                setErr(null);
                try {
                  await call(`/api/public/roadmap/${encodeURIComponent(token)}/requests`, {
                    title: f.title.trim(),
                    description: f.description.trim() || null,
                    name: f.name.trim(),
                    email: f.email.trim() || null,
                  });
                  setSent(true);
                } catch (e) {
                  setErr((e as Error).message);
                }
              }}
            >
              Send
            </button>
          </>
        )}
      </section>
      <p className="muted small" style={{ textAlign: 'center', margin: '24px 0' }}>
        Sent with SanchalanOS
      </p>
    </div>
  );
}
