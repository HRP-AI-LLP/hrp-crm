import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { get, getWorkspace, post, setWorkspace } from '../lib/api';
import { useAuth } from '../lib/auth';

interface TenantProbe {
  tenant: { slug: string; name: string } | null;
  signupEnabled: boolean;
  tenantHeaderAllowed: boolean;
  baseDomain: string;
}

export function useTenantProbe() {
  return useQuery({ queryKey: ['tenant-probe'], queryFn: () => get<TenantProbe>('/api/public/tenant'), staleTime: Infinity });
}

function Art() {
  return (
    <div className="auth-art">
      <div className="row" style={{ gap: 10 }}>
        <img src="/favicon.svg" width="34" height="34" alt="" />
        <b style={{ color: '#fff', fontSize: 16 }}>HRP Synapse</b>
      </div>
      <div>
        <h1>Every conversation, connected.</h1>
        <p>Leads, deals and customer messages in one place, with AI that tells your team who to call next and why.</p>
      </div>
      <p className="small">A product of HRP AI LLP</p>
    </div>
  );
}

export function LoginPage() {
  const { login } = useAuth();
  const nav = useNavigate();
  const probe = useTenantProbe();
  const [ws, setWs] = useState(getWorkspace() ?? '');
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
      await login(needsWorkspace ? ws.trim().toLowerCase() : null, email, password);
      nav('/');
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
            <h1>Sign in{probe.data?.tenant ? ` to ${probe.data.tenant.name}` : ''}</h1>
            <p className="muted">Use the email your workspace admin invited.</p>
          </div>
          {needsWorkspace && (
            <label className="field">
              Workspace
              <div className="ws-suffix">
                <input value={ws} onChange={(e) => setWs(e.target.value)} placeholder="your-company" required autoComplete="organization" />
                {probe.data?.baseDomain && probe.data.baseDomain !== 'localhost' && <span>.{probe.data.baseDomain}</span>}
              </div>
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
          {probe.data?.signupEnabled && (
            <p className="muted small">
              New to Synapse? <Link to="/signup">Create a workspace</Link>
            </p>
          )}
        </form>
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
      const r = await post<{ tenant: { slug: string }; url: string | null }>('/api/public/signup', f);
      if (r.url && probe.data?.baseDomain && probe.data.baseDomain !== 'localhost' && !probe.data.tenantHeaderAllowed) {
        window.location.href = `${r.url}/login`;
        return;
      }
      setWorkspace(r.tenant.slug);
      nav('/login');
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
            Workspace address
            <div className="ws-suffix">
              <input value={f.slug} onChange={set('slug')} required pattern="[a-z0-9][a-z0-9-]{1,38}[a-z0-9]" />
              {probe.data?.baseDomain && probe.data.baseDomain !== 'localhost' && <span>.{probe.data.baseDomain}</span>}
            </div>
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
