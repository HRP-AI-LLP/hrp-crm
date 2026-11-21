/**
 * Settings → Connection keys: every key the platform's connections need, set here instead of in the
 * server's .env — each with a step-by-step guide to create it. Also the reusable <Guide> shown next
 * to every connection in the app.
 */
import { GUIDES, type Guide as GuideT } from '@synapse/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Fragment, type ReactNode, useState } from 'react';
import { get, post, put } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { relative } from '../../lib/format';
import { useUsers } from '../../lib/hooks';
import { Spinner, useToast } from '../ui';

type Json = Record<string, any>;

/* ───────────────────────── guides ───────────────────────── */

function linkify(s: string): ReactNode[] {
  // `code` spans and bare https links inside a step
  return s.split(/(`[^`]+`|https?:\/\/[^\s)]+)/g).map((part, i) =>
    part.startsWith('`') ? (
      <code key={i}>{part.slice(1, -1)}</code>
    ) : /^https?:\/\//.test(part) ? (
      <a key={i} href={part} target="_blank" rel="noreferrer noopener">
        {part}
      </a>
    ) : (
      <Fragment key={i}>{part}</Fragment>
    ),
  );
}

function CopyLine({ label, value }: { label: string; value: string }) {
  const toast = useToast();
  return (
    <div className="guide-copy">
      <span className="muted small">{label}</span>
      <div className="row" style={{ gap: 6 }}>
        <input readOnly value={value} onFocus={(e) => e.target.select()} className="mono small" aria-label={label} />
        <button
          type="button"
          className="btn sm"
          onClick={async () => {
            await navigator.clipboard?.writeText(value).catch(() => undefined);
            toast('Copied');
          }}
        >
          Copy
        </button>
      </div>
    </div>
  );
}

/** "How to set this up" — numbered steps, links to the provider's console and addresses to paste there. */
export function Guide({ id, open: startOpen = false, extra, label }: { id: string; open?: boolean; extra?: ReactNode; label?: string }) {
  const g: GuideT | undefined = GUIDES[id];
  const [open, setOpen] = useState(startOpen);
  if (!g) return null;
  const origin = window.location.origin;
  return (
    <div className={`guide ${open ? 'open' : ''}`}>
      <button type="button" className="guide-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span aria-hidden="true">{open ? '▾' : '▸'}</span> {label ?? 'How to set this up'} <span className="muted small">— {g.title}</span>
      </button>
      {open && (
        <div className="guide-body">
          {g.links.length > 0 && (
            <div className="row small" style={{ gap: 10, flexWrap: 'wrap' }}>
              {g.links.map((l) => (
                <a key={l.url} href={l.url} target="_blank" rel="noreferrer noopener" className="guide-link">
                  {l.label} ↗
                </a>
              ))}
            </div>
          )}
          <ol className="guide-steps">
            {g.steps.map((s, i) => (
              <li key={i}>{linkify(s)}</li>
            ))}
          </ol>
          {g.copy?.map((c) => (
            <CopyLine key={c.path} label={c.label} value={`${origin}${c.path}`} />
          ))}
          {g.copy?.length ? <p className="muted small" style={{ margin: 0 }}>These addresses use the address you are on now ({origin}). On the live server they must use its public address.</p> : null}
          {extra}
          {g.notes?.map((n, i) => (
            <p key={i} className="muted small" style={{ margin: 0 }}>
              {linkify(n)}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}

/** A line pointing a platform admin to where keys are set (shown where a connection is still off). */
export function SetUpKeysLink({ group, children }: { group: string; children?: ReactNode }) {
  const { data } = useQuery({ queryKey: ['connection-keys-me'], queryFn: () => get<{ platformAdmin: boolean }>('/api/admin/connection-keys/me'), retry: false, staleTime: 5 * 60_000 });
  return (
    <span className="small">
      {children ?? 'Not set up yet.'}{' '}
      {data?.platformAdmin ? (
        <a href={`/settings?keys=${group}#keys`}>Set it up in Settings → Connection keys</a>
      ) : (
        <span className="muted">Your platform admin sets this up in Settings → Connection keys.</span>
      )}
    </span>
  );
}

/* ───────────────────────── the settings page ───────────────────────── */

const STATUS: Record<string, [string, string]> = { ready: ['good', 'Ready'], partial: ['warn', 'Partly set'], off: ['', 'Not set'] };
const SOURCE: Record<string, string> = { here: 'set here', env: 'from the server’s .env', platform: 'platform’s value' };

function GroupCard({ g, scope, onSaved, focus }: { g: Json; scope: 'platform' | 'workspace'; onSaved: () => void; focus: boolean }) {
  const toast = useToast();
  const [open, setOpen] = useState(focus);
  const [vals, setVals] = useState<Record<string, string>>({});
  const [checks, setChecks] = useState<{ ok: boolean; message: string }[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const dirty = Object.keys(vals).length > 0;
  const act = async <T,>(label: string, fn: () => Promise<T>): Promise<T | null> => {
    setBusy(label);
    try {
      return await fn();
    } catch (e) {
      toast((e as Error).message, true);
      return null;
    } finally {
      setBusy(null);
    }
  };
  const save = async () => {
    const values = Object.fromEntries(Object.entries(vals).map(([k, v]) => [k, v === '' ? null : v]));
    const r = await act('save', () => put('/api/admin/connection-keys', { scope, values }));
    if (r) {
      toast('Saved');
      setVals({});
      onSaved();
      const t = g.testable ? await act('test', () => post<{ checks: { ok: boolean; message: string }[] }>('/api/admin/connection-keys/test', { scope, group: g.id })) : null;
      if (t) setChecks(t.checks);
    }
  };
  const clear = async (key: string, label: string) => {
    if (!window.confirm(`Remove ${label}? ${scope === 'workspace' ? 'The platform’s value applies again.' : 'The value from the server’s .env (if any) applies again.'}`)) return;
    if (await act('save', () => put('/api/admin/connection-keys', { scope, values: { [key]: null } }))) (toast('Removed'), onSaved());
  };
  const [cls, label] = STATUS[g.status] ?? STATUS.off!;
  let lastSection: string | undefined;
  return (
    <section className="integ-card ck-card" id={`keys-${g.id}`}>
      <div className="spread" style={{ alignItems: 'flex-start', gap: 10 }}>
        <div style={{ minWidth: 0 }}>
          <h3>
            {g.title} <span className={`chip ${cls}`}>{label}</span> {g.ownKeys && <span className="chip info">This workspace’s own keys</span>}
          </h3>
          <p className="muted small">{g.unlocks}</p>
        </div>
        <button className="btn sm" onClick={() => setOpen(!open)} aria-expanded={open}>
          {open ? 'Close' : g.status === 'off' ? 'Set up' : 'Change'}
        </button>
      </div>
      {open && (
        <div className="stack" style={{ gap: 10 }}>
          <Guide id={g.guide} open={g.status !== 'ready'} />
          {g.generatePair === 'vapid' && (
            <div>
              <button
                className="btn sm"
                disabled={!!busy}
                onClick={async () => {
                  if (g.fields.some((f: Json) => f.key === 'VAPID_PRIVATE_KEY' && f.source) && !window.confirm('Replace the current key pair? Everyone will have to allow notifications again.')) return;
                  const r = await act('gen', () => post<Record<string, string>>('/api/admin/connection-keys/generate', { kind: 'vapid' }));
                  if (r) setVals((v) => ({ ...v, ...r }));
                }}
              >
                Generate key pair
              </button>{' '}
              <span className="muted small">Fills both VAPID keys; press Save to keep them.</span>
            </div>
          )}
          <div className="ck-fields">
            {(g.fields as Json[]).map((f) => {
              const head = f.section && f.section !== lastSection ? f.section : null;
              lastSection = f.section;
              const v = vals[f.key];
              const set = (x: string) => setVals((o) => ({ ...o, [f.key]: x }));
              return (
                <Fragment key={f.key}>
                  {head && <h4 className="ck-section">{head}</h4>}
                  <div className="ck-field">
                    <label className="field" style={{ margin: 0 }}>
                      <span>
                        {f.label}{' '}
                        {f.source ? (
                          <span className="muted small">
                            · {SOURCE[f.source]}
                            {f.value && f.kind !== 'bool' ? `: ${f.value.length > 60 ? `${f.value.slice(0, 60)}…` : f.value}` : ''}
                            {f.updatedAt ? ` · ${relative(f.updatedAt)}` : ''}
                          </span>
                        ) : (
                          <span className="muted small">· not set</span>
                        )}
                      </span>
                      {f.kind === 'bool' ? (
                        <select value={v ?? (f.value === 'true' ? 'true' : 'false')} onChange={(e) => set(e.target.value)}>
                          <option value="false">Off</option>
                          <option value="true">On</option>
                        </select>
                      ) : f.kind === 'select' ? (
                        <select value={v ?? f.value ?? ''} onChange={(e) => set(e.target.value)}>
                          {(f.options as [string, string][]).map(([o, l]) => (
                            <option key={o} value={o}>
                              {l}
                            </option>
                          ))}
                        </select>
                      ) : f.kind === 'textarea' ? (
                        <textarea rows={5} className="mono small" value={v ?? ''} onChange={(e) => set(e.target.value)} placeholder={f.source && f.secret ? 'Saved — paste a new value to replace it' : f.placeholder} spellCheck={false} />
                      ) : (
                        <div className="row" style={{ gap: 6 }}>
                          <input
                            type={f.secret ? 'password' : 'text'}
                            autoComplete="off"
                            className="mono small"
                            value={v ?? (!f.secret && f.source === 'here' ? f.value ?? '' : '')}
                            onChange={(e) => set(e.target.value)}
                            placeholder={f.source && f.secret ? 'Saved — type a new value to replace it' : f.placeholder}
                            spellCheck={false}
                          />
                          {f.generate === 'random' && (
                            <button
                              type="button"
                              className="btn sm"
                              onClick={async () => {
                                const r = await act('gen', () => post<{ value: string }>('/api/admin/connection-keys/generate', { kind: 'random' }));
                                if (r) {
                                  set(r.value);
                                  await navigator.clipboard?.writeText(r.value).catch(() => undefined);
                                  toast('Generated and copied — paste it in the provider too, then Save');
                                }
                              }}
                            >
                              Generate
                            </button>
                          )}
                        </div>
                      )}
                      {f.help && <span className="muted small">{f.help}</span>}
                    </label>
                    {f.source === 'here' && (
                      <button type="button" className="link-btn small" onClick={() => clear(f.key, f.label)}>
                        Remove
                      </button>
                    )}
                  </div>
                </Fragment>
              );
            })}
          </div>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <button className="btn primary" disabled={!dirty || !!busy} onClick={save}>
              {busy === 'save' ? 'Saving…' : g.testable ? 'Save and test' : 'Save'}
            </button>
            {dirty && (
              <button className="btn" onClick={() => setVals({})}>
                Undo changes
              </button>
            )}
            {g.testable && (
              <button className="btn" disabled={!!busy || g.status === 'off'} onClick={async () => setChecks((await act('test', () => post<{ checks: { ok: boolean; message: string }[] }>('/api/admin/connection-keys/test', { scope, group: g.id })))?.checks ?? null)}>
                {busy === 'test' ? 'Testing…' : 'Test'}
              </button>
            )}
          </div>
          {checks && (
            <ul className="ck-checks">
              {checks.map((c, i) => (
                <li key={i} className={c.ok ? 'good-text' : 'bad-text'}>
                  {c.ok ? '✓' : '✕'} {c.message}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}

function PlatformAdmins() {
  const users = useUsers();
  const { me } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const { data } = useQuery({ queryKey: ['platform-admins'], queryFn: () => get<{ items: { user_id: string }[] }>('/api/admin/platform-admins') });
  const [pick, setPick] = useState('');
  if (!data) return null;
  const ids = new Set(data.items.map((i) => i.user_id));
  const name = (id: string) => users.data?.items.find((u: Json) => u.id === id)?.full_name ?? 'Someone';
  const change = async (uid: string, admin: boolean) => {
    try {
      await put(`/api/admin/platform-admins/${uid}`, { admin });
      qc.invalidateQueries({ queryKey: ['platform-admins'] });
      toast('Saved');
    } catch (e) {
      toast((e as Error).message, true);
    }
  };
  return (
    <details className="callout small">
      <summary>
        <strong>Platform admins</strong> — {ids.size ? [...ids].map(name).join(', ') : 'nobody listed yet, so the owners of the first workspace (on a local server: any workspace owner)'}
      </summary>
      <div className="stack" style={{ gap: 6, marginTop: 8 }}>
        <span className="muted">Platform admins set the keys every workspace shares. Listing someone here also lists you.</span>
        {[...ids].map((id) => (
          <div key={id} className="row" style={{ gap: 8 }}>
            {name(id)} {id === me?.user.id && <span className="muted">(you)</span>}
            <button className="link-btn small" onClick={() => change(id, false)}>
              Remove
            </button>
          </div>
        ))}
        <div className="row" style={{ gap: 6 }}>
          <select value={pick} onChange={(e) => setPick(e.target.value)} aria-label="Person">
            <option value="">Add someone from this workspace…</option>
            {users.data?.items
              .filter((u: Json) => !ids.has(u.id))
              .map((u: Json) => (
                <option key={u.id} value={u.id}>
                  {u.full_name}
                </option>
              ))}
          </select>
          <button className="btn sm" disabled={!pick} onClick={() => (change(pick, true), setPick(''))}>
            Add
          </button>
        </div>
      </div>
    </details>
  );
}

export function ConnectionKeysTab() {
  const qc = useQueryClient();
  const { data: me } = useQuery({ queryKey: ['connection-keys-me'], queryFn: () => get<{ platformAdmin: boolean }>('/api/admin/connection-keys/me'), retry: false });
  const [scope, setScope] = useState<'platform' | 'workspace'>('platform');
  const effective = me?.platformAdmin ? scope : 'workspace';
  const { data, isLoading } = useQuery({ queryKey: ['connection-keys', effective], enabled: !!me, queryFn: () => get<Json>(`/api/admin/connection-keys?scope=${effective}`) });
  const focus = new URLSearchParams(window.location.search).get('keys');
  if (!me || isLoading || !data) return <Spinner />;
  const groups = data.groups as Json[];
  const ready = groups.filter((g) => g.status === 'ready').length;
  return (
    <div className="stack integ">
      <p className="muted" style={{ margin: 0 }}>
        The keys Synapse needs to talk to Google, Microsoft, Zoom, GitHub, Meta, email, AI, GST and push services. Each has a guide to create it. Secret keys are encrypted and never shown again — only their last
        characters. A value saved here replaces the one in the server’s <code>.env</code>; Remove brings the <code>.env</code> value back.
      </p>
      {me.platformAdmin && (
        <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
          <div className="seg small">
            <button className={scope === 'platform' ? 'on' : ''} onClick={() => setScope('platform')}>
              Whole platform
            </button>
            <button className={scope === 'workspace' ? 'on' : ''} onClick={() => setScope('workspace')}>
              This workspace only
            </button>
          </div>
          <span className="muted small">
            {ready} of {groups.length} ready
          </span>
        </div>
      )}
      {effective === 'platform' && <PlatformAdmins />}
      {effective === 'workspace' && (
        <p className="muted small" style={{ margin: 0 }}>
          {me.platformAdmin
            ? 'Keys a workspace may set for itself — used only for this workspace, in place of the platform’s.'
            : 'The platform’s connections (Google, Microsoft, Zoom, GitHub, email …) are set up by your platform admin. Here you can use your own account where a workspace may.'}
        </p>
      )}
      {!data.encryption && <div className="callout warn small">This server has no DATA_ENCRYPTION_KEY, so secret keys can’t be stored here yet.</div>}
      {groups.map((g) => (
        <GroupCard key={`${effective}-${g.id}`} g={g} scope={effective} focus={focus === g.id} onSaved={() => qc.invalidateQueries({ queryKey: ['connection-keys'] })} />
      ))}
      <p className="muted small" style={{ margin: 0 }}>
        Still in the server’s environment, by design: the database address, <code>JWT_SECRET</code> and <code>DATA_ENCRYPTION_KEY</code> (they are needed before anything here can be read) and the Cloudflare bindings in{' '}
        <code>wrangler.jsonc</code>.
      </p>
    </div>
  );
}
