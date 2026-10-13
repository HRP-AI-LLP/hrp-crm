import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { get, getWorkspace, post, setWorkspace } from '../lib/api';
import { useAuth } from '../lib/auth';

interface TenantProbe {
  tenant: { slug: string; name: string } | null;
  signupEnabled: boolean;
  tenantHeaderAllowed: boolean;
  appHost: string | null;
  /** set when each workspace can also get <slug>.<this domain> */
  vanityDomains: string | null;
}

export function useTenantProbe() {
  return useQuery({ queryKey: ['tenant-probe'], queryFn: () => get<TenantProbe>('/api/public/tenant'), staleTime: Infinity });
}

function Art() {
  return (
    <div className="auth-art">
      <div className="row" style={{ gap: 12 }}>
        <span className="brand-mark" style={{ width: 44, height: 44 }}>
          <img src="/logo-mark.png" alt="HRP AI" style={{ width: 36, height: 36 }} />
        </span>
        <div>
          <b style={{ color: '#fff', fontSize: 17, display: 'block' }}>HRP Synapse</b>
          <span style={{ color: '#7dd3fc', fontSize: 13 }}>by HRP AI LLP</span>
        </div>
      </div>
      <div>
        <h1>Every conversation, connected.</h1>
        <p>Leads, deals and customer messages in one place, with AI that tells your team who to call next and why.</p>
      </div>
      <p className="small">HRP AI LLP · Where humans &amp; machines think together</p>
    </div>
  );
}

export function LoginPage() {
  const { login, verifyMfa } = useAuth();
  const [challenge, setChallenge] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [useRecovery, setUseRecovery] = useState(false);
  const nav = useNavigate();
  const probe = useTenantProbe();
  const [ws, setWs] = useState(() => new URLSearchParams(window.location.search).get('workspace') ?? getWorkspace() ?? '');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const needsWorkspace = !probe.data?.tenant;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      if (challenge) {
        await verifyMfa(challenge, useRecovery ? { recoveryCode: code.trim() } : { code: code.replace(/\s/g, '') });
        nav('/');
        return;
      }
      const r = await login(needsWorkspace ? ws.trim().toLowerCase() : null, email, password);
      if ('mfaChallenge' in r) {
        setChallenge(r.mfaChallenge);
        setCode('');
        return;
      }
      nav('/');
    } catch (e) {
      if (challenge && /expired|password again/i.test((e as Error).message)) setChallenge(null);
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth">
      <Art />
      <div className="auth-form">
        {challenge ? (
          <form onSubmit={submit}>
            <div>
              <h1>Two-factor sign-in</h1>
              <p className="muted">{useRecovery ? 'Enter one of the recovery codes you saved when you set up two-factor sign-in.' : 'Enter the 6-digit code from your authenticator app.'}</p>
            </div>
            <label className="field">
              {useRecovery ? 'Recovery code' : 'Authentication code'}
              <input
                value={code}
                onChange={(e) => setCode(e.target.value)}
                autoFocus
                required
                inputMode={useRecovery ? 'text' : 'numeric'}
                autoComplete="one-time-code"
                pattern={useRecovery ? undefined : '[0-9 ]{6,7}'}
                maxLength={useRecovery ? 12 : 7}
                className="mono otp-input"
                placeholder={useRecovery ? 'xxxx-xxxx' : '123 456'}
              />
            </label>
            {err && <div className="field-error" role="alert">{err}</div>}
            <button className="btn primary" disabled={busy}>
              {busy ? 'Checking…' : 'Verify and sign in'}
            </button>
            <p className="muted small">
              <button type="button" className="link" style={{ padding: 0 }} onClick={() => { setUseRecovery((r) => !r); setCode(''); setErr(null); }}>
                {useRecovery ? 'Use my authenticator app instead' : 'Lost your phone? Use a recovery code'}
              </button>
              {' · '}
              <button type="button" className="link" style={{ padding: 0 }} onClick={() => { setChallenge(null); setErr(null); }}>
                Start again
              </button>
            </p>
          </form>
        ) : (
        <form onSubmit={submit}>
          <div>
            <h1>Sign in{probe.data?.tenant ? ` to ${probe.data.tenant.name}` : ''}</h1>
            <p className="muted">Use the email your workspace admin invited.</p>
          </div>
          {needsWorkspace && (
            <label className="field">
              Workspace
              <input value={ws} onChange={(e) => setWs(e.target.value)} placeholder="your-company" required autoComplete="organization" />
              <span className="muted small">The workspace ID you chose when your company signed up.</span>
            </label>
          )}
          <label className="field">
            Email
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="username" />
          </label>
          <label className="field">
            Password
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required autoComplete="current-password" />
          </label>
          {err && <div className="field-error" role="alert">{err}</div>}
          <button className="btn primary" disabled={busy}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
          <p className="muted small">
            <Link to={`/forgot-password${ws ? `?workspace=${encodeURIComponent(ws)}` : ''}`}>Forgot your password?</Link>
            {probe.data?.signupEnabled && (
              <>
                {' · '}New to Synapse? <Link to="/signup">Create a workspace</Link>
              </>
            )}
          </p>
        </form>
        )}
      </div>
    </div>
  );
}

export function SignupPage() {
  const nav = useNavigate();
  const probe = useTenantProbe();
  const [f, setF] = useState({ workspaceName: '', slug: '', fullName: '', email: '', password: '' });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF((s) => ({ ...s, [k]: e.target.value }));
  const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      const r = await post<{ tenant: { slug: string }; url: string | null; vanityUrl: string | null }>('/api/public/signup', f);
      setWorkspace(r.tenant.slug);
      if (r.url && new URL(r.url).host !== window.location.host) {
        window.location.href = r.url;
        return;
      }
      nav(`/login?workspace=${encodeURIComponent(r.tenant.slug)}`);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth">
      <Art />
      <div className="auth-form">
        <form onSubmit={submit}>
          <div>
            <h1>Create your workspace</h1>
            <p className="muted">You will be the workspace owner. Invite your team after signing in.</p>
          </div>
          <label className="field">
            Company name
            <input value={f.workspaceName} onChange={(e) => setF((s) => ({ ...s, workspaceName: e.target.value, slug: s.slug && s.slug !== slugify(s.workspaceName) ? s.slug : slugify(e.target.value) }))} required />
          </label>
          <label className="field">
            Workspace ID
            {probe.data?.vanityDomains ? (
              <div className="ws-suffix">
                <input value={f.slug} onChange={set('slug')} required pattern="[a-z0-9][a-z0-9-]{1,38}[a-z0-9]" />
                <span>.{probe.data.vanityDomains}</span>
              </div>
            ) : (
              <input value={f.slug} onChange={set('slug')} required pattern="[a-z0-9][a-z0-9-]{1,38}[a-z0-9]" />
            )}
            <span className="muted small">Your team types this when signing in. Lowercase letters, digits and hyphens.</span>
          </label>
          <label className="field">
            Your name
            <input value={f.fullName} onChange={set('fullName')} required autoComplete="name" />
          </label>
          <label className="field">
            Work email
            <input type="email" value={f.email} onChange={set('email')} required autoComplete="email" />
          </label>
          <label className="field">
            Password
            <input type="password" value={f.password} onChange={set('password')} required minLength={10} autoComplete="new-password" />
            <span className="muted small">At least 10 characters, using three of: lowercase, uppercase, digits, symbols.</span>
          </label>
          {err && <div className="field-error" role="alert">{err}</div>}
          <button className="btn primary" disabled={busy}>
            {busy ? 'Creating…' : 'Create workspace'}
          </button>
          <p className="muted small">
            Already have one? <Link to="/login">Sign in</Link>
          </p>
        </form>
      </div>
    </div>
  );
}

/** Shared shell for the small token pages (invite, reset, forgot). */
function TokenPage({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="auth">
      <Art />
      <div className="auth-form">
        <div className="stack" style={{ maxWidth: 380, width: '100%' }}>
          <h1>{title}</h1>
          {children}
        </div>
      </div>
    </div>
  );
}

function useTokenParams() {
  const q = new URLSearchParams(window.location.search);
  const ws = q.get('workspace');
  if (ws) setWorkspace(ws);
  return { workspace: ws ?? getWorkspace() ?? '', token: q.get('token') ?? '' };
}

export function ForgotPasswordPage() {
  const probe = useTenantProbe();
  const [ws, setWs] = useState(() => new URLSearchParams(window.location.search).get('workspace') ?? getWorkspace() ?? '');
  const [email, setEmail] = useState('');
  const [done, setDone] = useState<null | boolean>(null);
  const [err, setErr] = useState<string | null>(null);
  const needsWorkspace = !probe.data?.tenant;
  return (
    <TokenPage title="Reset your password">
      {done === null ? (
        <form
          className="stack"
          onSubmit={async (e) => {
            e.preventDefault();
            setErr(null);
            try {
              if (needsWorkspace) setWorkspace(ws.trim().toLowerCase());
              const r = await post<{ emailed: boolean }>('/api/auth/password/forgot', { email });
              setDone(r.emailed);
            } catch (e2) {
              setErr((e2 as Error).message);
            }
          }}
        >
          <p className="muted" style={{ margin: 0 }}>We will email you a link to choose a new password.</p>
          {needsWorkspace && (
            <label className="field">
              Workspace
              <input value={ws} onChange={(e) => setWs(e.target.value)} required />
            </label>
          )}
          <label className="field">
            Email
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="username" />
          </label>
          {err && <div className="field-error">{err}</div>}
          <button className="btn primary">Send reset link</button>
          <Link to="/login" className="small">Back to sign in</Link>
        </form>
      ) : done ? (
        <p>If that email belongs to an account, a reset link is on its way. It works for one hour.</p>
      ) : (
        <p>
          Email is not set up for this workspace yet, so we cannot send a link. Ask your workspace administrator to send you a password reset link from Settings → Users.
        </p>
      )}
    </TokenPage>
  );
}

export function ResetPasswordPage() {
  const { token } = useTokenParams();
  const nav = useNavigate();
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState(false);
  return (
    <TokenPage title="Choose a new password">
      {ok ? (
        <>
          <p>Your password is changed and you were signed out everywhere.</p>
          <button className="btn primary" onClick={() => nav('/login')}>
            Sign in
          </button>
        </>
      ) : (
        <form
          className="stack"
          onSubmit={async (e) => {
            e.preventDefault();
            setErr(null);
            if (pw !== pw2) return setErr('The passwords do not match');
            try {
              await post('/api/auth/password/reset', { token, password: pw });
              setOk(true);
            } catch (e2) {
              setErr((e2 as Error).message);
            }
          }}
        >
          <label className="field">
            New password
            <input type="password" value={pw} onChange={(e) => setPw(e.target.value)} required minLength={10} autoComplete="new-password" />
            <span className="muted small">At least 10 characters, using three of: lowercase, uppercase, digits, symbols.</span>
          </label>
          <label className="field">
            Repeat it
            <input type="password" value={pw2} onChange={(e) => setPw2(e.target.value)} required autoComplete="new-password" />
          </label>
          {err && <div className="field-error">{err}</div>}
          <button className="btn primary">Save password</button>
        </form>
      )}
    </TokenPage>
  );
}

export function AcceptInvitePage() {
  const { token } = useTokenParams();
  const { adopt } = useAuth();
  const nav = useNavigate();
  const info = useQuery({ queryKey: ['invite', token], queryFn: () => get<{ email: string; fullName: string; workspace: string }>(`/api/auth/invite/${encodeURIComponent(token)}`), retry: false });
  const [name, setName] = useState('');
  const [pw, setPw] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (info.error) {
    return (
      <TokenPage title="Invitation not valid">
        <p>{(info.error as Error).message}</p>
        <Link to="/login">Go to sign in</Link>
      </TokenPage>
    );
  }
  if (!info.data) return <TokenPage title="Joining…"><p className="muted">Checking your invitation…</p></TokenPage>;
  return (
    <TokenPage title={`Join ${info.data.workspace}`}>
      <p className="muted" style={{ margin: 0 }}>
        You are joining as <b>{info.data.email}</b>. Choose a password to finish.
      </p>
      <form
        className="stack"
        onSubmit={async (e) => {
          e.preventDefault();
          setErr(null);
          setBusy(true);
          try {
            const r = await post<{ accessToken: string }>('/api/auth/invite/accept', { token, password: pw, fullName: name.trim() || undefined });
            await adopt(r.accessToken);
            nav('/');
          } catch (e2) {
            setErr((e2 as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <label className="field">
          Your name
          <input value={name || info.data.fullName} onChange={(e) => setName(e.target.value)} autoComplete="name" />
        </label>
        <label className="field">
          Password
          <input type="password" value={pw} onChange={(e) => setPw(e.target.value)} required minLength={10} autoComplete="new-password" />
          <span className="muted small">At least 10 characters, using three of: lowercase, uppercase, digits, symbols.</span>
        </label>
        {err && <div className="field-error">{err}</div>}
        <button className="btn primary" disabled={busy}>
          {busy ? 'Joining…' : 'Join workspace'}
        </button>
      </form>
    </TokenPage>
  );
}
