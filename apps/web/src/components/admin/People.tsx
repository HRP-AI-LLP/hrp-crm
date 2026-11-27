import { WORK_AREAS } from '@synapse/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { get, patch, post, put } from '../../lib/api';
import { relative } from '../../lib/format';
import { blankIdentity, IdentitySection, persistIdentity, type IdentityValues } from '../IdentitySection';
import { Modal, Spinner, useToast } from '../ui';

type Json = Record<string, any>;

function LinkModal({ title, intro, url, onClose }: { title: string; intro: string; url: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <Modal title={title} onClose={onClose} footer={<button className="btn primary" onClick={onClose}>Done</button>}>
      <div className="modal-body" style={{ display: 'block' }}>
        <p style={{ marginTop: 0 }}>{intro}</p>
        <div className="row">
          <input readOnly value={url} onFocus={(e) => e.target.select()} aria-label="Link" className="mono small" />
          <button
            className="btn"
            onClick={async () => {
              await navigator.clipboard?.writeText(url).catch(() => undefined);
              setCopied(true);
            }}
          >
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
        <p className="muted small">Share it privately (WhatsApp, Teams…). Anyone with the link can use it once.</p>
      </div>
    </Modal>
  );
}

/** Settings → Users: invite by link/email, roles, manager, teams, 2FA status and account actions. */
export function PeopleTab() {
  const qc = useQueryClient();
  const toast = useToast();
  const { data, isLoading } = useQuery({ queryKey: ['admin-users'], queryFn: () => get<{ items: Json[] }>('/api/admin/users') });
  const { data: roles } = useQuery({ queryKey: ['admin-roles'], queryFn: () => get<{ items: Json[] }>('/api/admin/roles') });
  const { data: teams } = useQuery({ queryKey: ['admin-teams'], queryFn: () => get<{ items: Json[] }>('/api/admin/teams') });
  const { data: sec } = useQuery({ queryKey: ['admin-security'], queryFn: () => get<{ mailer: boolean }>('/api/admin/security') });
  const [inv, setInv] = useState<{ email: string; fullName: string; role: string; teamIds: string[]; invite: boolean } | null>(null);
  const [link, setLink] = useState<{ title: string; intro: string; url: string } | null>(null);
  const [idv, setIdv] = useState<IdentityValues>(blankIdentity());
  const [idFor, setIdFor] = useState<Json | null>(null);
  const [menu, setMenuState] = useState<{ id: string; top: number; right: number } | null>(null);
  const setMenu = (_: null) => setMenuState(null);
  // close the floating menu on outside click / scroll
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenuState(null);
    const t = setTimeout(() => window.addEventListener('click', close), 0);
    window.addEventListener('scroll', close, true);
    return () => {
      clearTimeout(t);
      window.removeEventListener('click', close);
      window.removeEventListener('scroll', close, true);
    };
  }, [menu]);

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    setMenu(null);
    try {
      const r = await fn();
      toast(ok);
      qc.invalidateQueries({ queryKey: ['admin-users'] });
      return r;
    } catch (e) {
      toast((e as Error).message, true);
      return null;
    }
  };

  if (isLoading) return <Spinner />;
  const teamOf = (id: string) => (teams?.items ?? []).filter((t) => t.member_ids.includes(id) || t.lead_id === id).map((t) => t.name);

  return (
    <div className="stack">
      <div className="spread">
        <p className="muted small" style={{ margin: 0 }}>
          {sec?.mailer ? 'Invitations and reset links are emailed.' : 'Email is not configured, so you will get a link to share for invitations and password resets.'} Attributes like region or branch drive attribute-based access.
        </p>
        <button className="btn primary" onClick={() => setInv({ email: '', fullName: '', role: roles?.items.some((r) => r.key === 'project_member') ? 'project_member' : '', teamIds: [], invite: true })}>
          Add people
        </button>
      </div>
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>Person</th>
              <th>Role</th>
              <th>Manager</th>
              <th>Teams</th>
              <th>Security</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {data?.items.map((u) => (
              <tr key={u.id} className={u.status === 'disabled' ? 'muted-row' : undefined}>
                <td>
                  <b>{u.full_name}</b> {u.is_owner && <span className="chip">owner</span>} {u.status === 'invited' && <span className="chip">invited</span>} {u.status === 'profile' && <span className="chip warn">no login yet</span>} {u.status === 'disabled' && <span className="chip bad">disabled</span>}
                  <div className="muted small">
                    {u.email ?? 'No email yet'} · {u.status === 'profile' ? 'not onboarded to the CRM' : u.last_login_at ? `signed in ${relative(u.last_login_at)}` : 'never signed in'}
                  </div>
                </td>
                <td>
                  <select value={u.roles[0] ?? ''} onChange={(e) => act(() => patch(`/api/admin/users/${u.id}`, { roles: [e.target.value] }), 'Role updated')} style={{ width: 'auto' }} aria-label={`Role of ${u.full_name}`}>
                    {roles?.items.map((r) => (
                      <option key={r.id} value={r.key}>
                        {r.name}
                      </option>
                    ))}
                  </select>
                </td>
                <td>
                  <select value={u.manager_id ?? ''} onChange={(e) => act(() => patch(`/api/admin/users/${u.id}`, { managerId: e.target.value || null }), 'Manager updated')} style={{ width: 'auto', maxWidth: 160 }} aria-label={`Manager of ${u.full_name}`}>
                    <option value="">—</option>
                    {data.items
                      .filter((m) => m.id !== u.id && m.status !== 'disabled')
                      .map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.full_name}
                        </option>
                      ))}
                  </select>
                </td>
                <td className="small">{teamOf(u.id).join(', ') || <span className="muted">—</span>}</td>
                <td>
                  {u.mfa_enabled ? <span className="chip good">2FA on</span> : <span className="muted small">Password only</span>}
                  {u.attributes?.assistantOff === true && <span className="chip" style={{ marginLeft: 4 }}>AI off</span>}
                </td>
                <td style={{ width: 90 }}>
                  <button
                    className="btn sm"
                    aria-haspopup="menu"
                    aria-expanded={menu?.id === u.id}
                    onClick={(e) => {
                      const r = e.currentTarget.getBoundingClientRect();
                      setMenuState(menu?.id === u.id ? null : { id: u.id, top: r.bottom + 4, right: window.innerWidth - r.right });
                    }}
                  >
                    Actions ▾
                  </button>
                  {menu?.id === u.id && (
                    <div className="menu" role="menu" style={{ position: 'fixed', top: menu!.top, right: menu!.right }} onClick={(e) => e.stopPropagation()}>
                      {(u.status === 'profile' || u.status === 'invited') && (
                        <button role="menuitem" onClick={async () => {
                          setMenu(null);
                          const email = window.prompt(`Email for ${u.full_name}`, u.email ?? '');
                          if (email === null) return;
                          await act(() => put(`/api/admin/users/${u.id}/email`, { email: email.trim() || null }), 'Email saved');
                        }}>
                          {u.email ? 'Change email' : 'Add email'}
                        </button>
                      )}
                      {u.status === 'profile' && u.email && (
                        <button role="menuitem" onClick={async () => {
                          const r = (await act(() => post<{ inviteUrl: string; emailed: boolean }>(`/api/admin/users/${u.id}/invite-link`), 'Invitation created')) as { inviteUrl: string; emailed: boolean } | null;
                          if (r && !r.emailed) setLink({ title: 'Invitation link', intro: `Send this link to ${u.full_name}. It is valid for 7 days.`, url: r.inviteUrl });
                        }}>
                          Onboard to the CRM (send invitation)
                        </button>
                      )}
                      {u.status === 'invited' && (
                        <button role="menuitem" onClick={async () => {
                          const r = (await act(() => post<{ inviteUrl: string; emailed: boolean }>(`/api/admin/users/${u.id}/invite-link`), 'New invitation created')) as { inviteUrl: string; emailed: boolean } | null;
                          if (r && !r.emailed) setLink({ title: 'Invitation link', intro: `Send this link to ${u.full_name}. It is valid for 7 days.`, url: r.inviteUrl });
                        }}>
                          Resend invitation
                        </button>
                      )}
                      {u.status === 'active' && (
                        <button role="menuitem" onClick={async () => {
                          const r = (await act(() => post<{ resetUrl: string; emailed: boolean }>(`/api/admin/users/${u.id}/reset-link`), 'Reset link created')) as { resetUrl: string; emailed: boolean } | null;
                          if (r && !r.emailed) setLink({ title: 'Password reset link', intro: `Send this link to ${u.full_name}. It works once, for 24 hours.`, url: r.resetUrl });
                        }}>
                          Password reset link
                        </button>
                      )}
                      {u.mfa_enabled && (
                        <button role="menuitem" onClick={() => window.confirm(`Turn off two-factor sign-in for ${u.full_name}? Use this when they lost their phone.`) && act(() => post(`/api/admin/users/${u.id}/reset-mfa`), 'Two-factor reset')}>
                          Reset two-factor
                        </button>
                      )}
                      {!u.is_owner && (
                        <button
                          role="menuitem"
                          onClick={() => act(() => patch(`/api/admin/users/${u.id}`, { attributes: { ...(u.attributes ?? {}), assistantOff: u.attributes?.assistantOff === true ? undefined : true } }), u.attributes?.assistantOff === true ? 'AI assistant turned on' : 'AI assistant turned off')}
                        >
                          {u.attributes?.assistantOff === true ? 'Turn on AI assistant' : 'Turn off AI assistant'}
                        </button>
                      )}
                      <button
                        role="menuitem"
                        onClick={() => {
                          setMenu(null);
                          setIdFor(u);
                        }}
                      >
                        ID and statutory details
                      </button>
                      <button role="menuitem" onClick={() => act(() => post(`/api/admin/users/${u.id}/sign-out`), 'Signed out everywhere')}>
                        Sign out everywhere
                      </button>
                      <button
                        role="menuitem"
                        onClick={() => {
                          const v = window.prompt('Attributes as JSON, e.g. {"region":"west","branch":"pune"}', JSON.stringify(u.attributes ?? {}));
                          if (v === null) return;
                          try {
                            const parsed = JSON.parse(v);
                            void act(() => patch(`/api/admin/users/${u.id}`, { attributes: parsed }), 'Attributes saved');
                          } catch {
                            toast('That is not valid JSON', true);
                          }
                        }}
                      >
                        Edit attributes
                      </button>
                      <button
                        role="menuitem"
                        onClick={() => {
                          const v = window.prompt(`Phone number for ${u.full_name} (rings first for click-to-call). Leave empty to remove.`, u.phone ?? '');
                          if (v === null) return;
                          void act(() => patch(`/api/admin/users/${u.id}`, { phone: v.trim() || null }), 'Phone saved');
                        }}
                      >
                        Set phone number
                      </button>
                      {!u.is_owner && (
                        <button role="menuitem" className="danger" onClick={() => act(() => patch(`/api/admin/users/${u.id}`, { status: u.status === 'disabled' ? 'active' : 'disabled' }), u.status === 'disabled' ? 'User enabled' : 'User disabled')}>
                          {u.status === 'disabled' ? 'Enable' : 'Disable'}
                        </button>
                      )}
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {inv && (
        <Modal
          title="Add someone to the team"
          wide
          onClose={() => {
            setInv(null);
            setIdv(blankIdentity());
          }}
          footer={
            <button
              className="btn primary"
              disabled={!inv.fullName.trim() || !inv.role || (inv.email.trim() !== '' && !/^\S+@\S+\.\S+$/.test(inv.email.trim()))}
              onClick={async () => {
                const onboard = inv.invite && !!inv.email.trim();
                const r = (await act(() => post<{ id: string; inviteUrl: string | null; emailed: boolean }>('/api/admin/users/invite', { email: inv.email.trim() || null, fullName: inv.fullName, roles: [inv.role], teamIds: inv.teamIds, invite: onboard }), onboard ? 'Invitation created' : `${inv.fullName} added to the team`)) as { id: string; inviteUrl: string | null; emailed: boolean } | null;
                if (!r) return;
                const filled = idv.pan || idv.aadhaar || idv.uan || idv.pfNumber || Object.values(idv.files).some(Boolean);
                if (filled && r.id) await persistIdentity('user', r.id, idv, { includePan: true }).catch((e) => toast(`Invited ${inv.fullName}, but the ID details were not saved: ${(e as Error).message}`, true));
                setIdv(blankIdentity());
                qc.invalidateQueries({ queryKey: ['users'] });
                qc.invalidateQueries({ queryKey: ['admin-teams'] });
                setInv(null);
                if (!r.inviteUrl) return;
                if (r.emailed) toast(`Invitation emailed to ${inv.email}`);
                else setLink({ title: 'Invitation link', intro: `Send this link to ${inv.fullName}. It is valid for 7 days.`, url: r.inviteUrl });
              }}
            >
              {!(inv.invite && inv.email.trim()) ? 'Add to team' : sec?.mailer ? 'Add and send invitation' : 'Add and create invitation link'}
            </button>
          }
        >
          <div className="modal-body">
            <label className="field">
              Full name
              <input value={inv.fullName} onChange={(e) => setInv({ ...inv, fullName: e.target.value })} autoFocus />
            </label>
            <label className="field">
              Work email <span className="muted small">(optional — add it later to give them a login)</span>
              <input type="email" value={inv.email} onChange={(e) => setInv({ ...inv, email: e.target.value })} />
            </label>
            <label className="check-row">
              <input type="checkbox" checked={inv.invite && !!inv.email.trim()} disabled={!inv.email.trim()} onChange={(e) => setInv({ ...inv, invite: e.target.checked })} />
              Give them a login now (send the invitation)
            </label>
            <label className="field">
              Role
              <select value={inv.role} onChange={(e) => setInv({ ...inv, role: e.target.value })}>
                {!inv.role && <option value="">Choose a role…</option>}
                {roles?.items.map((r) => (
                  <option key={r.id} value={r.key}>
                    {r.name}
                  </option>
                ))}
              </select>
              {(() => {
                const r = roles?.items.find((x) => x.key === inv.role);
                const areas: string[] = r?.permissions?.apps ?? ['*'];
                return (
                  r && (
                    <small className="muted">
                      {r.description}
                      {areas.includes('*') ? ' · Reaches every part of the workspace.' : ` · Areas: ${areas.map((a) => WORK_AREAS.find((w) => w.key === a)?.label ?? a).join(', ') || 'only home, tasks and their own things'}.`}
                    </small>
                  )
                );
              })()}
            </label>
            {!!teams?.items.length && (
              <div className="field">
                <span>Teams</span>
                <div className="row" style={{ flexWrap: 'wrap', gap: 10 }}>
                  {teams.items.map((t) => (
                    <label key={t.id} className="row small">
                      <input type="checkbox" checked={inv.teamIds.includes(t.id)} onChange={(e) => setInv({ ...inv, teamIds: e.target.checked ? [...inv.teamIds, t.id] : inv.teamIds.filter((x) => x !== t.id) })} />
                      {t.name}
                    </label>
                  ))}
                </div>
              </div>
            )}
            <IdentitySection subject="user" id={null} value={idv} onChange={setIdv} />
          </div>
        </Modal>
      )}
      {idFor && <UserIdentityModal user={idFor} onClose={() => setIdFor(null)} />}
      {link && <LinkModal {...link} onClose={() => setLink(null)} />}
    </div>
  );
}

/** A team member's PAN, Aadhaar, UAN and PF number, with copies. */
function UserIdentityModal({ user, onClose }: { user: Json; onClose: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [v, setV] = useState<IdentityValues>(blankIdentity());
  const [busy, setBusy] = useState(false);
  return (
    <Modal
      title={`${user.full_name}: ID and statutory details`}
      wide
      onClose={onClose}
      footer={
        <button
          className="btn primary"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await persistIdentity('user', user.id, v, { includePan: true });
              qc.invalidateQueries({ queryKey: ['identity', 'user', user.id] });
              qc.invalidateQueries({ queryKey: ['organisation', 'documents'] });
              toast('Saved');
              onClose();
            } catch (e) {
              toast((e as Error).message, true);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? 'Saving…' : 'Save'}
        </button>
      }
    >
      <div className="modal-body">
        <IdentitySection subject="user" id={user.id} value={v} onChange={setV} />
      </div>
    </Modal>
  );
}
