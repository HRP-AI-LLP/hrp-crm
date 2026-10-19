/**
 * Public privacy pages (no sign-in): the workspace's notice and request form, email confirmation,
 * request status, and one-click unsubscribe.
 */
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Markdown } from '../components/Markdown';
import { Spinner } from '../components/ui';
import { date, dateTime } from '../lib/format';

type Json = Record<string, any>;

async function call<T>(path: string, body?: unknown): Promise<T> {
  const r = await fetch(path, body === undefined ? undefined : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j?.error?.message ?? 'Something went wrong');
  return j as T;
}

const KINDS: [string, string, string][] = [
  ['access', 'See my data', 'A summary of the personal data held about you and how it is used.'],
  ['correction', 'Correct or update my data', 'Fix wrong details or complete missing ones.'],
  ['erasure', 'Erase my data', 'Delete your personal data, except what the law requires to be kept (such as tax invoices).'],
  ['withdraw_consent', 'Stop marketing messages', 'Withdraw consent for offers on WhatsApp, email, SMS and calls.'],
  ['nomination', 'Nominate someone', 'Name a person who can exercise your rights if you cannot.'],
  ['grievance', 'Raise a grievance', 'Complain about how your data was handled.'],
];
const LANG: Record<string, string> = { en: 'English', hi: 'हिन्दी', mr: 'मराठी', gu: 'ગુજરાતી', ta: 'தமிழ்', te: 'తెలుగు', kn: 'ಕನ್ನಡ', bn: 'বাংলা', ml: 'മലയാളം', pa: 'ਪੰਜਾਬੀ' };

export function PrivacyPortalPage() {
  const { key = '' } = useParams();
  const [p, setP] = useState<Json | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [lang, setLang] = useState('en');
  const [f, setF] = useState({ kind: '', name: '', email: '', phone: '', details: '', _hp: '' });
  const [done, setDone] = useState<Json | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    call<Json>(`/api/public/privacy/${encodeURIComponent(key)}`)
      .then((j) => {
        setP(j);
        document.title = `Privacy — ${j.company}`;
        const langs = (j.notices as Json[]).map((n) => n.language);
        const nav = navigator.language.slice(0, 2);
        setLang(langs.includes(nav) ? nav : langs.includes('en') ? 'en' : (langs[0] ?? 'en'));
      })
      .catch(() => setErr('This privacy page is not available.'));
  }, [key]);
  if (err) return <div className="public-wrap"><p>{err}</p></div>;
  if (!p) return <div className="public-wrap"><Spinner /></div>;
  const notice = (p.notices as Json[]).find((n) => n.language === lang) ?? p.notices[0];
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      setDone(await call<Json>(`/api/public/privacy/${encodeURIComponent(key)}/requests`, f));
    } catch (x) {
      setErr((x as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="public-wrap customer-page privacy-page">
      <header className="cp-head">
        <b>{p.company}</b>
        <span className="muted small">Privacy</span>
      </header>
      {p.notices.length > 1 && (
        <div className="row" style={{ justifyContent: 'flex-end', marginTop: 10 }}>
          <select value={lang} onChange={(e) => setLang(e.target.value)} aria-label="Language" style={{ width: 'auto' }}>
            {(p.notices as Json[]).map((n) => (
              <option key={n.language} value={n.language}>
                {LANG[n.language] ?? n.language}
              </option>
            ))}
          </select>
        </div>
      )}
      {notice ? (
        <article className="panel cp-card">
          <Markdown source={notice.body} />
          <p className="muted small">
            Version {notice.version} · published {date(notice.published_at)}
          </p>
        </article>
      ) : (
        <p className="muted">The privacy notice is being prepared.</p>
      )}
      <section className="panel cp-card">
        <h2>Grievance officer</h2>
        {p.officer.name && <p>{p.officer.name}</p>}
        {p.officer.email && (
          <p>
            <a href={`mailto:${p.officer.email}`}>{p.officer.email}</a>
          </p>
        )}
        {p.officer.phone && (
          <p>
            <a href={`tel:${p.officer.phone}`}>{p.officer.phone}</a>
          </p>
        )}
        {p.officer.address && <p className="muted small">{p.officer.address}</p>}
      </section>
      <section className="panel cp-card">
        <h2>Make a request</h2>
        {done ? (
          <div className="stack">
            <p>
              <b>Thank you. We have received your request.</b>
            </p>
            {done.verificationEmailed ? <p>We sent you an email. Open the link in it to confirm the request is yours. We act on it once you confirm.</p> : <p>We will contact you to confirm your identity before acting on it.</p>}
            <p>We will respond by {date(done.dueAt)}.</p>
            <p>
              <Link to={done.statusUrl}>Track your request</Link>
            </p>
          </div>
        ) : (
          <form onSubmit={submit} className="stack">
            <fieldset className="kind-pick">
              <legend className="small muted">What would you like to do?</legend>
              {KINDS.map(([k, l, hint]) => (
                <label key={k} className={`kind-opt${f.kind === k ? ' on' : ''}`}>
                  <input type="radio" name="kind" value={k} checked={f.kind === k} onChange={() => setF({ ...f, kind: k })} />
                  <span>
                    <b>{l}</b>
                    <span className="muted small">{hint}</span>
                  </span>
                </label>
              ))}
            </fieldset>
            <label className="field">
              Your name
              <input required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} autoComplete="name" />
            </label>
            <label className="field">
              Email (the one you gave us)
              <input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} autoComplete="email" />
            </label>
            <label className="field">
              Phone (the one you gave us)
              <input type="tel" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} autoComplete="tel" />
            </label>
            <label className="field">
              Details (optional)
              <textarea rows={3} value={f.details} onChange={(e) => setF({ ...f, details: e.target.value })} />
            </label>
            <input className="hp" tabIndex={-1} autoComplete="off" value={f._hp} onChange={(e) => setF({ ...f, _hp: e.target.value })} aria-hidden="true" />
            {err && <p className="field-error">{err}</p>}
            <button className="btn primary" disabled={busy || !f.kind || !f.name || (!f.email && !f.phone)}>
              Send request
            </button>
            <p className="muted small">We respond within {p.slaDays} days. If you are not satisfied, you may complain to the Data Protection Board of India.</p>
          </form>
        )}
      </section>
    </div>
  );
}

export function PrivacyVerifyPage() {
  const { token = '' } = useParams();
  const [state, setState] = useState<'busy' | 'ok' | 'bad'>('busy');
  const [statusUrl, setStatusUrl] = useState<string | null>(null);
  useEffect(() => {
    call<Json>('/api/public/privacy-verify', { token })
      .then((j) => {
        setStatusUrl(j.statusUrl);
        setState('ok');
      })
      .catch(() => setState('bad'));
  }, [token]);
  return (
    <div className="public-wrap">
      {state === 'busy' && <Spinner />}
      {state === 'ok' && (
        <>
          <h1>Request confirmed</h1>
          <p>Thank you. We will act on your request and let you know by email.</p>
          {statusUrl && <Link to={statusUrl}>Track your request</Link>}
        </>
      )}
      {state === 'bad' && (
        <>
          <h1>Link not valid</h1>
          <p>This confirmation link is invalid, already used or has expired. Submit the request again from the privacy page.</p>
        </>
      )}
    </div>
  );
}

const STATUS: Record<string, string> = { received: 'Received', verifying: 'Waiting for your confirmation', in_progress: 'In progress', completed: 'Completed', rejected: 'Closed' };

export function PrivacyStatusPage() {
  const { token = '' } = useParams();
  const [r, setR] = useState<Json | null>(null);
  const [err, setErr] = useState(false);
  useEffect(() => {
    call<Json>(`/api/public/privacy-status/${encodeURIComponent(token)}`)
      .then(setR)
      .catch(() => setErr(true));
  }, [token]);
  if (err) return <div className="public-wrap"><p>This link is not valid.</p></div>;
  if (!r) return <div className="public-wrap"><Spinner /></div>;
  const closed = ['completed', 'rejected'].includes(r.status);
  return (
    <div className="public-wrap customer-page">
      <header className="cp-head">
        <b>{r.company}</b>
        <span className="muted small">{r.number}</span>
      </header>
      <h1>{KINDS.find(([k]) => k === r.kind)?.[1] ?? 'Privacy request'}</h1>
      <p>
        <span className={`chip ${r.status === 'completed' ? 'good' : 'info'}`}>{STATUS[r.status] ?? r.status}</span>{' '}
        <span className="muted small">
          Received {dateTime(r.created_at)}
          {!closed && ` · response due by ${date(r.due_at)}`}
        </span>
      </p>
      {r.resolution && closed && (
        <section className="panel cp-card">
          <h2>Response</h2>
          <p className="pre-wrap">{r.resolution}</p>
        </section>
      )}
    </div>
  );
}

export function UnsubscribePage() {
  const { token = '' } = useParams();
  const [u, setU] = useState<Json | null>(null);
  const [done, setDone] = useState(false);
  const [err, setErr] = useState(false);
  useEffect(() => {
    call<Json>(`/api/public/unsubscribe/${encodeURIComponent(token)}`)
      .then(setU)
      .catch(() => setErr(true));
  }, [token]);
  if (err) return <div className="public-wrap"><p>This link is not valid.</p></div>;
  if (!u) return <div className="public-wrap"><Spinner /></div>;
  const ch = { whatsapp: 'WhatsApp', email: 'email', sms: 'SMS', calls: 'phone' }[u.channel as string] ?? u.channel;
  return (
    <div className="public-wrap">
      <h1>{done ? 'You are unsubscribed' : `Stop ${ch} offers from ${u.company}?`}</h1>
      {done ? (
        <p>
          {u.company} will not send offers to {u.address} on {ch} any more. You will still receive messages about your orders, invoices and service requests.
        </p>
      ) : (
        <>
          <p>
            We will stop sending offers to <b>{u.address}</b>.
          </p>
          <button className="btn primary" onClick={() => call(`/api/public/unsubscribe/${encodeURIComponent(token)}`, {}).then(() => setDone(true))}>
            Unsubscribe
          </button>
        </>
      )}
    </div>
  );
}
