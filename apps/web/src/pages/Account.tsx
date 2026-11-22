import { useQuery, useQueryClient } from '@tanstack/react-query';
import qrcode from 'qrcode-generator';
import { useMemo, useState } from 'react';
import { MailboxPanel } from '../components/MailboxPanel';
import { MeetingAppsPanel } from '../components/MeetingApps';
import { PushDevices } from '../components/PushDevices';
import { WorkAlertPrefs } from '../components/projects/WorkPlus';
import { Modal, Spinner, useToast } from '../components/ui';
import { ApiError, get, post } from '../lib/api';
import { useAuth } from '../lib/auth';
import { downloadText } from '../lib/csv';
import { relative } from '../lib/format';

function Qr({ text }: { text: string }) {
  const svg = useMemo(() => {
    const q = qrcode(0, 'M');
    q.addData(text);
    q.make();
    return q.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
  }, [text]);
  // generated locally from the otpauth URI; never sent to a third-party QR service
  return <div className="qr" role="img" aria-label="QR code for your authenticator app" dangerouslySetInnerHTML={{ __html: svg }} />;
}

function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  return (
    <div className="stack">
      <div className="notice">
        <div>
          <b>Save these recovery codes now.</b> Each works once if you lose your phone. They will not be shown again.
        </div>
      </div>
      <ol className="recovery">
        {codes.map((c) => (
          <li key={c} className="mono">
            {c}
          </li>
        ))}
      </ol>
      <div className="row">
        <button className="btn" onClick={() => downloadText('hrp-synapse-recovery-codes.txt', `SanchalanOS recovery codes\n\n${codes.join('\n')}\n`, 'text/plain')}>
          Download
        </button>
        <button className="btn" onClick={() => navigator.clipboard?.writeText(codes.join('\n'))}>
          Copy
        </button>
        <button className="btn primary" onClick={onDone}>
          I have saved them
        </button>
      </div>
    </div>
  );
}

/** Two-factor setup: scan → confirm a code → save recovery codes. */
export function TwoFactorSetup({ onEnabled }: { onEnabled?: () => void }) {
  const { reload } = useAuth();
  const [setup, setSetup] = useState<{ secret: string; uri: string } | null>(null);
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState<string[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (codes) {
    return (
      <RecoveryCodes
        codes={codes}
        onDone={async () => {
          await reload();
          onEnabled?.();
        }}
      />
    );
  }
  if (!setup) {
    return (
      <div className="stack">
        <p style={{ margin: 0 }}>Protect your account with a code from an authenticator app (Google Authenticator, Microsoft Authenticator, Authy, 1Password…) in addition to your password.</p>
        {err && <div className="field-error">{err}</div>}
        <div>
          <button
            className="btn primary"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setErr(null);
              try {
                setSetup(await post<{ secret: string; uri: string }>('/api/auth/mfa/setup'));
              } catch (e) {
                setErr((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            Set up two-factor sign-in
          </button>
        </div>
      </div>
    );
  }
  return (
    <form
      className="mfa-setup"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setErr(null);
        try {
          const r = await post<{ recoveryCodes: string[] }>('/api/auth/mfa/enable', { code: code.replace(/\s/g, '') });
          setCodes(r.recoveryCodes);
        } catch (e2) {
          setErr(e2 instanceof ApiError ? e2.message : 'Could not turn it on');
        } finally {
          setBusy(false);
        }
      }}
    >
      <Qr text={setup.uri} />
      <div className="stack">
        <ol className="steps">
          <li>Open your authenticator app and add an account.</li>
          <li>Scan the QR code — or type this key: <code className="mono">{setup.secret.match(/.{1,4}/g)?.join(' ')}</code></li>
          <li>Enter the 6-digit code it shows.</li>
        </ol>
        <label className="field">
          Code from the app
          <input value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" maxLength={7} className="mono otp-input" placeholder="123 456" required autoFocus />
        </label>
        {err && <div className="field-error">{err}</div>}
        <div>
          <button className="btn primary" disabled={busy}>
            {busy ? 'Checking…' : 'Turn on'}
          </button>
        </div>
      </div>
    </form>
  );
}

export function AccountPage() {
  const { me, reload } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const sessions = useQuery({ queryKey: ['my-sessions'], queryFn: () => get<{ items: { family_id: string; created_at: string; last_seen: string; user_agent: string | null; ip: string | null; current: boolean }[] }>('/api/auth/sessions') });
  const [pw, setPw] = useState({ current: '', next: '' });
  const [dialog, setDialog] = useState<null | 'disable' | 'codes'>(null);
  const [newCodes, setNewCodes] = useState<string[] | null>(null);
  const mfaOn = !!me?.security?.mfaEnabled;

  const device = (ua: string | null) => {
    if (!ua) return 'Unknown device';
    const browser = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
    const os = /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Mac OS/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : '';
    return `${browser}${os ? ` on ${os}` : ''}`;
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>My account</h1>
          <p>
            {me?.user.fullName} · {me?.user.email} · {me?.tenant.name}
          </p>
        </div>
      </div>
      <div className="account-grid">
        <MailboxPanel />
        <MeetingAppsPanel />
        <WorkAlertPrefs />
        <PushDevices />
        <section className="panel">
          <div className="panel-head">
            <h2>Two-factor sign-in</h2>
            {mfaOn ? <span className="chip good">On</span> : <span className="chip">Off</span>}
          </div>
          <div className="panel-body stack">
            {mfaOn ? (
              <>
                <p style={{ margin: 0 }}>Signing in needs your password and a code from your authenticator app.</p>
                <div className="row">
                  <button className="btn" onClick={() => setDialog('codes')}>
                    New recovery codes
                  </button>
                  {!me?.security?.mfaRequired && (
                    <button className="btn danger" onClick={() => setDialog('disable')}>
                      Turn off
                    </button>
                  )}
                </div>
                {me?.security?.mfaRequired && <p className="muted small" style={{ margin: 0 }}>Your workspace requires two-factor sign-in.</p>}
              </>
            ) : (
              <TwoFactorSetup onEnabled={() => toast('Two-factor sign-in is on')} />
            )}
          </div>
        </section>

        <section className="panel">
          <div className="panel-head">
            <h2>Password</h2>
          </div>
          <form
            className="panel-body stack"
            onSubmit={async (e) => {
              e.preventDefault();
              try {
                await post('/api/auth/change-password', { currentPassword: pw.current, newPassword: pw.next });
                setPw({ current: '', next: '' });
                toast('Password changed — other devices were signed out');
                qc.invalidateQueries({ queryKey: ['my-sessions'] });
              } catch (e2) {
                toast((e2 as Error).message, true);
              }
            }}
          >
            <label className="field">
              Current password
              <input type="password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} required autoComplete="current-password" />
            </label>
            <label className="field">
              New password
              <input type="password" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} required minLength={10} autoComplete="new-password" />
            </label>
            <div>
              <button className="btn primary">Change password</button>
            </div>
          </form>
        </section>

        <section className="panel wide-panel">
          <div className="panel-head">
            <h2>Where you are signed in</h2>
            <button
              className="btn sm"
              onClick={async () => {
                await post('/api/auth/sessions/revoke', { others: true });
                toast('Signed out of all other devices');
                qc.invalidateQueries({ queryKey: ['my-sessions'] });
              }}
            >
              Sign out everywhere else
            </button>
          </div>
          {!sessions.data ? (
            <div className="panel-body">
              <Spinner />
            </div>
          ) : (
            <table className="data">
              <tbody>
                {sessions.data.items.map((s) => (
                  <tr key={s.family_id}>
                    <td>
                      <b>{device(s.user_agent)}</b>
                      {s.current && <span className="chip good" style={{ marginLeft: 8 }}>This device</span>}
                      <div className="muted small">
                        {s.ip ?? 'unknown IP'} · signed in {relative(s.created_at)} · active {relative(s.last_seen)}
                      </div>
                    </td>
                    <td style={{ width: 120, textAlign: 'right' }}>
                      {!s.current && (
                        <button
                          className="btn sm"
                          onClick={async () => {
                            await post('/api/auth/sessions/revoke', { familyId: s.family_id });
                            qc.invalidateQueries({ queryKey: ['my-sessions'] });
                          }}
                        >
                          Sign out
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>

      {dialog === 'disable' && (
        <CodePrompt
          title="Turn off two-factor sign-in"
          withPassword
          action="Turn off"
          onClose={() => setDialog(null)}
          onSubmit={async (password, code) => {
            await post('/api/auth/mfa/disable', { password, ...(code.includes('-') ? { recoveryCode: code } : { code }) });
            await reload();
            toast('Two-factor sign-in is off');
            setDialog(null);
          }}
        />
      )}
      {dialog === 'codes' && !newCodes && (
        <CodePrompt
          title="New recovery codes"
          action="Create new codes"
          onClose={() => setDialog(null)}
          onSubmit={async (_pw, code) => {
            const r = await post<{ recoveryCodes: string[] }>('/api/auth/mfa/recovery-codes', { code });
            setNewCodes(r.recoveryCodes);
          }}
        />
      )}
      {newCodes && (
        <Modal title="Your new recovery codes" onClose={() => { setNewCodes(null); setDialog(null); }}>
          <div className="modal-body" style={{ display: 'block' }}>
            <RecoveryCodes codes={newCodes} onDone={() => { setNewCodes(null); setDialog(null); }} />
          </div>
        </Modal>
      )}
    </>
  );
}

function CodePrompt({ title, action, withPassword, onSubmit, onClose }: { title: string; action: string; withPassword?: boolean; onSubmit: (password: string, code: string) => Promise<void>; onClose: () => void }) {
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [err, setErr] = useState<string | null>(null);
  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <button
          className="btn primary"
          onClick={async () => {
            setErr(null);
            try {
              await onSubmit(password, code.trim());
            } catch (e) {
              setErr((e as Error).message);
            }
          }}
        >
          {action}
        </button>
      }
    >
      <div className="modal-body">
        {withPassword && (
          <label className="field wide">
            Password
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
          </label>
        )}
        <label className="field wide">
          Code from your app (or a recovery code)
          <input value={code} onChange={(e) => setCode(e.target.value)} className="mono" autoComplete="one-time-code" />
        </label>
        {err && <div className="field-error wide">{err}</div>}
      </div>
    </Modal>
  );
}

/** Full-screen gate when the workspace requires two-factor and this person has not set it up. */
export function MfaRequiredGate() {
  const { logout, me } = useAuth();
  return (
    <div className="gate">
      <section className="panel" style={{ maxWidth: 640, width: '100%' }}>
        <div className="panel-head">
          <h2>Set up two-factor sign-in</h2>
          <button className="btn ghost sm" onClick={() => logout()}>
            Sign out
          </button>
        </div>
        <div className="panel-body stack">
          <p style={{ margin: 0 }}>
            <b>{me?.tenant.name}</b> requires two-factor sign-in for everyone. It takes about a minute.
          </p>
          <TwoFactorSetup />
        </div>
      </section>
    </div>
  );
}
