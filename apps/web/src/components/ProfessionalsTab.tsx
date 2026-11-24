/**
 * Settings → Organisation → Accountants & CAs. Add the outside finance people a business works with
 * (CAs, accountants, auditors, bookkeepers, tax consultants), and decide per person — and per module —
 * whether they can read only, download & run reports, or edit. Each one can also ask for more access
 * from their own screen; requests land here for approval.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { del, get, patch, post, put } from '../lib/api';
import { date as fmtDate } from '../lib/format';
import { Empty, Modal, Spinner, useToast } from './ui';

type Json = Record<string, any>;
export type Access = { modules: Record<string, string>; canFile: boolean };
export const emptyAccess = (): Access => ({ modules: {}, canFile: false });

/** Per-module access editor: each module gets No access / Read only / Download & reports / Can edit. */
export function AccessEditor({ meta, value, onChange }: { meta: Json; value: Access; onChange: (v: Access) => void }) {
  const levels: Json[] = meta.levels;
  const setModule = (k: string, lvl: string) => {
    const modules = { ...value.modules };
    if (lvl) modules[k] = lvl;
    else delete modules[k];
    onChange({ ...value, modules, canFile: k === 'gst' && !lvl ? false : value.canFile });
  };
  const hasGst = !!value.modules.gst;
  const none = !Object.keys(value.modules).length;
  return (
    <div className="stack">
      <div className="table-wrap">
        <table className="data" data-export="off">
          <thead>
            <tr>
              <th>Functionality / module</th>
              <th style={{ width: 220 }}>Access</th>
            </tr>
          </thead>
          <tbody>
            {(meta.modules as Json[]).map((m) => (
              <tr key={m.key}>
                <td>{m.label}</td>
                <td>
                  <select value={value.modules[m.key] ?? ''} onChange={(e) => setModule(m.key, e.target.value)}>
                    <option value="">No access</option>
                    {levels.map((l) => (
                      <option key={l.key} value={l.key}>
                        {l.label}
                      </option>
                    ))}
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {hasGst && (
        <label className="check">
          <input type="checkbox" checked={!!value.canFile} onChange={(e) => onChange({ ...value, canFile: e.target.checked })} /> May file GST returns and work the compliance calendar
        </label>
      )}
      {none && <div className="notice small">With nothing granted, this person can sign in but will see no finance data.</div>}
      <div className="muted small">“Download &amp; reports” lets them open dashboards and export that data; “Can edit” also lets them create and change records.</div>
    </div>
  );
}

export function AccessChips({ access, meta }: { access: Access; meta: Json }) {
  const labelOf = (k: string) => (meta.modules as Json[]).find((m) => m.key === k)?.label ?? k;
  const lvlLabel = (k: string) => (meta.levels as Json[]).find((l) => l.key === k)?.label ?? k;
  const keys = Object.keys(access.modules ?? {});
  if (!keys.length) return <span className="muted small">No access yet</span>;
  return (
    <>
      {keys.map((k) => (
        <span key={k} className={`chip ${access.modules[k] === 'edit' ? 'warn' : ''}`} style={{ marginRight: 4, display: 'inline-block', marginBottom: 2 }}>
          {labelOf(k)}: {lvlLabel(access.modules[k] ?? '')}
        </span>
      ))}
      {access.canFile && <span className="chip">Files GST</span>}
    </>
  );
}

export function ProfessionalsTab() {
  const toast = useToast();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['organisation', 'professionals'], queryFn: () => get<Json>('/api/v1/organisation/professionals') });
  const [edit, setEdit] = useState<Json | null | 'new'>(null);
  const [access, setAccess] = useState<Json | null>(null);
  const [showRequests, setShowRequests] = useState(false);
  const [showSign, setShowSign] = useState(false);
  const [invite, setInvite] = useState<{ url: string; emailed: boolean; name?: string } | null>(null);
  const sendInviteFor = async (p: Json) => {
    try {
      const r = await post<{ inviteUrl: string; emailed: boolean }>(`/api/v1/organisation/professionals/${p.id}/invite`, {});
      setInvite({ url: r.inviteUrl, emailed: r.emailed, name: p.fullName });
      if (r.emailed) toast('Invite emailed');
    } catch (e) {
      toast((e as Error).message, true);
    }
  };
  if (q.isLoading) return <Spinner />;
  if (q.error) return <Empty title="Only admins see this">Accountants and CAs are managed by admins and the people they name.</Empty>;
  const data = q.data!;
  const refresh = () => qc.invalidateQueries({ queryKey: ['organisation', 'professionals'] });

  return (
    <div className="stack">
      <p className="muted small" style={{ margin: 0 }}>
        Add the CAs and accountants who work on your books. Each one signs in to your workspace seeing only the functionality and data you grant — nothing of your sales, HR or other operations. They can request more from their own screen; you approve it here.
      </p>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <button className="btn primary sm" onClick={() => setEdit('new')}>
          Add an accountant or CA
        </button>
        <button className="btn sm" onClick={() => setShowRequests(true)}>
          Access requests{data.pendingRequests ? ` (${data.pendingRequests})` : ''}
        </button>
        <button className="btn sm" onClick={() => setShowSign(true)}>
          Signature requests
        </button>
      </div>
      {!data.items.length ? (
        <Empty title="No accountants or CAs yet">Add the first one and choose what they can see.</Empty>
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Name</th>
                <th>Role</th>
                <th>Access</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.items.map((p: Json) => (
                <tr key={p.id}>
                  <td>
                    <b>{p.fullName}</b>
                    <div className="muted small">{[p.email, p.firm].filter(Boolean).join(' · ')}</div>
                    {p.membershipNo && <div className="muted small">M. No. {p.membershipNo}</div>}
                  </td>
                  <td className="small">{p.kindLabel}</td>
                  <td style={{ whiteSpace: 'normal', maxWidth: 340 }}>
                    <AccessChips access={p.access} meta={data} />
                  </td>
                  <td className="small">
                    {p.status === 'invited' ? <span className="muted">Invited</span> : p.status === 'disabled' ? <span className="muted">Disabled</span> : 'Active'}
                    {p.lastLoginAt && <div className="muted small">Last in {fmtDate(p.lastLoginAt)}</div>}
                  </td>
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    <button className="btn ghost sm" onClick={() => setAccess(p)}>
                      Access
                    </button>
                    {p.status === 'invited' && (
                      <button className="btn ghost sm" onClick={() => sendInviteFor(p)} title="Send or copy the sign-in invite">
                        Invite
                      </button>
                    )}
                    <button className="btn ghost sm" onClick={() => setEdit(p)}>
                      Edit
                    </button>
                    <button
                      className="btn ghost sm"
                      onClick={async () => {
                        if (!confirm(`Remove ${p.fullName}? They lose access immediately. Records they touched stay as they are.`)) return;
                        try {
                          await del(`/api/v1/organisation/professionals/${p.id}`);
                          toast('Removed');
                          refresh();
                        } catch (e) {
                          toast((e as Error).message, true);
                        }
                      }}
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {edit && (
        <ProfessionalModal
          pro={edit === 'new' ? null : edit}
          meta={data}
          onClose={() => setEdit(null)}
          onSaved={(res) => {
            setEdit(null);
            refresh();
            if (res?.inviteUrl) setInvite({ url: res.inviteUrl, emailed: !!res.emailed, name: res.fullName });
            else toast('Saved');
          }}
        />
      )}
      {invite && <InviteModal invite={invite} onClose={() => setInvite(null)} />}
      {access && (
        <AccessModal
          pro={access}
          meta={data}
          onClose={() => setAccess(null)}
          onSaved={() => {
            toast('Access updated');
            setAccess(null);
            refresh();
          }}
        />
      )}
      {showRequests && <RequestsModal meta={data} onClose={() => setShowRequests(false)} onDecided={refresh} />}
      {showSign && <SignRequestsModal onClose={() => setShowSign(false)} />}
    </div>
  );
}

/** Admin: pending signature requests — sign each with a soft (.pfx) certificate, or decline. */
function SignRequestsModal({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['sign-requests', 'admin'], queryFn: () => get<{ items: Json[] }>('/api/v1/organisation/sign-requests') });
  const certsQ = useQuery({ queryKey: ['org-dsc'], queryFn: () => get<Json>('/api/v1/organisation/dsc'), staleTime: 60_000 });
  const [cert, setCert] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const softCerts: Json[] = ((certsQ.data?.certificates as Json[]) ?? []).filter((c) => c.kind === 'pfx');
  const refresh = () => qc.invalidateQueries({ queryKey: ['sign-requests', 'admin'] });
  const sign = async (id: string) => {
    if (!cert) return toast('Pick the signing certificate first', true);
    setBusy(id);
    try {
      await post(`/api/v1/organisation/sign-requests/${id}/sign`, { certificateId: cert });
      toast('Signed');
      refresh();
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy(null);
    }
  };
  const reject = async (id: string) => {
    const note = prompt('Reason for declining (optional)') ?? undefined;
    setBusy(id);
    try {
      await post(`/api/v1/organisation/sign-requests/${id}/reject`, { note });
      toast('Declined');
      refresh();
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy(null);
    }
  };
  const items: Json[] = q.data?.items ?? [];
  const pending = items.filter((r) => r.status === 'pending');
  const done = items.filter((r) => r.status !== 'pending');
  return (
    <Modal title="Signature requests" onClose={onClose} wide>
      {q.isLoading ? (
        <Spinner />
      ) : !items.length ? (
        <Empty title="No signature requests">When an accountant or CA uploads a document to be signed, it shows up here.</Empty>
      ) : (
        <div className="stack">
          {pending.length > 0 && (
            <label className="field">
              Sign with
              <select value={cert} onChange={(e) => setCert(e.target.value)}>
                <option value="">Choose a certificate…</option>
                {softCerts.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label} ({c.subjectCn ?? c.subject_cn})
                  </option>
                ))}
              </select>
              {!softCerts.length && <span className="muted small">No soft (.pfx) certificate is set up. Add one under Digital signatures (DSC) — a USB token can't sign uploads unattended.</span>}
            </label>
          )}
          {pending.map((r) => (
            <div key={r.id} className="panel" style={{ padding: 12 }}>
              <div className="spread" style={{ gap: 8 }}>
                <div>
                  <b>{r.name}</b> <span className="muted small">{r.requestedBy} · {fmtDate(r.createdAt)}</span>
                  {r.note && <div className="small" style={{ marginTop: 2 }}>{r.note}</div>}
                  {r.sourceUrl && (
                    <div style={{ marginTop: 4 }}>
                      <a className="small" href={r.sourceUrl} target="_blank" rel="noreferrer">
                        Open uploaded document
                      </a>
                    </div>
                  )}
                </div>
                <div style={{ whiteSpace: 'nowrap' }}>
                  <button className="btn primary sm" disabled={busy === r.id || !softCerts.length} onClick={() => sign(r.id)}>
                    Sign
                  </button>
                  <button className="btn ghost sm" disabled={busy === r.id} onClick={() => reject(r.id)}>
                    Decline
                  </button>
                </div>
              </div>
            </div>
          ))}
          {done.length > 0 && (
            <>
              <h4 style={{ margin: '8px 0 0' }}>Recently handled</h4>
              {done.map((r) => (
                <div key={r.id} className="small spread">
                  <span>
                    {r.name} — {r.requestedBy}
                  </span>
                  <span>
                    <span className={`chip ${r.status === 'signed' ? 'good' : 'warn'}`}>{r.status}</span>{' '}
                    {r.signedUrl && (
                      <a href={r.signedUrl} target="_blank" rel="noreferrer">
                        signed PDF
                      </a>
                    )}
                  </span>
                </div>
              ))}
            </>
          )}
        </div>
      )}
    </Modal>
  );
}

/** Shows the sign-in invite link after adding/inviting, and whether it was emailed. */
function InviteModal({ invite, onClose }: { invite: { url: string; emailed: boolean; name?: string }; onClose: () => void }) {
  const toast = useToast();
  return (
    <Modal
      title={`Invite${invite.name ? ` ${invite.name}` : ''}`}
      onClose={onClose}
      footer={
        <button className="btn primary" onClick={onClose}>
          Done
        </button>
      }
    >
      <div className="stack">
        {invite.emailed ? (
          <div className="notice">An email with this sign-in link has been sent. You can also copy it below to share directly.</div>
        ) : (
          <div className="notice warn">Email isn't set up on this workspace, so no mail was sent. Copy this link and send it to them — it lets them set a password and sign in. It's valid for 7 days.</div>
        )}
        <label className="field">
          Invite link
          <input readOnly value={invite.url} onFocus={(e) => e.currentTarget.select()} />
        </label>
        <div>
          <button
            className="btn sm"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(invite.url);
                toast('Link copied');
              } catch {
                toast('Select the link and copy it', true);
              }
            }}
          >
            Copy link
          </button>
        </div>
      </div>
    </Modal>
  );
}

function ProfessionalModal({ pro, meta, onClose, onSaved }: { pro: Json | null; meta: Json; onClose: () => void; onSaved: (res?: Json) => void }) {
  const toast = useToast();
  const [f, setF] = useState<Json>(
    pro
      ? { ...pro }
      : { fullName: '', email: '', kind: 'accountant', firm: '', membershipNo: '', phone: '', engagedFrom: '', engagedTo: '', notes: '' },
  );
  const [acc, setAcc] = useState<Access>(pro ? { modules: { ...(pro.access?.modules ?? {}) }, canFile: !!pro.access?.canFile } : emptyAccess());
  const [busy, setBusy] = useState(false);
  const set = (k: string, v: unknown) => setF((p) => ({ ...p, [k]: v }));
  const save = async () => {
    setBusy(true);
    try {
      const base = {
        fullName: f.fullName.trim(),
        kind: f.kind,
        firm: f.firm || null,
        membershipNo: f.membershipNo || null,
        phone: f.phone || null,
        engagedFrom: f.engagedFrom || null,
        engagedTo: f.engagedTo || null,
        notes: f.notes || null,
      };
      if (pro) {
        await patch(`/api/v1/organisation/professionals/${pro.id}`, base);
        onSaved();
      } else {
        const res = await post<Json>('/api/v1/organisation/professionals', { ...base, email: f.email.trim(), modules: acc.modules, canFile: acc.canFile });
        onSaved({ ...res, fullName: base.fullName });
      }
    } catch (e) {
      toast((e as Error).message, true);
      setBusy(false);
    }
  };
  return (
    <Modal
      title={pro ? `Edit ${pro.fullName}` : 'Add an accountant or CA'}
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy || !f.fullName.trim() || (!pro && !f.email.trim())} onClick={save}>
            {pro ? 'Save' : 'Add & invite'}
          </button>
        </>
      }
    >
      <div className="form-grid">
        <label className="field">
          Full name
          <input value={f.fullName} onChange={(e) => set('fullName', e.target.value)} autoFocus />
        </label>
        <label className="field">
          Email {pro && <span className="muted small">(cannot change)</span>}
          <input type="email" value={f.email} disabled={!!pro} onChange={(e) => set('email', e.target.value)} />
        </label>
        <label className="field">
          They are a
          <select value={f.kind} onChange={(e) => set('kind', e.target.value)}>
            {(meta.kinds as Json[]).map((k) => (
              <option key={k.key} value={k.key}>
                {k.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          Firm
          <input value={f.firm ?? ''} onChange={(e) => set('firm', e.target.value)} />
        </label>
        <label className="field">
          Membership / registration no.
          <input value={f.membershipNo ?? ''} onChange={(e) => set('membershipNo', e.target.value)} />
        </label>
        <label className="field">
          Phone
          <input value={f.phone ?? ''} onChange={(e) => set('phone', e.target.value)} />
        </label>
        <label className="field">
          Engaged from
          <input type="date" value={f.engagedFrom ?? ''} onChange={(e) => set('engagedFrom', e.target.value)} />
        </label>
        <label className="field">
          Engaged to
          <input type="date" value={f.engagedTo ?? ''} onChange={(e) => set('engagedTo', e.target.value)} />
        </label>
        <label className="field" style={{ gridColumn: '1 / -1' }}>
          Notes
          <textarea value={f.notes ?? ''} onChange={(e) => set('notes', e.target.value)} rows={2} />
        </label>
      </div>
      {!pro ? (
        <>
          <h4 style={{ margin: '12px 0 4px' }}>Access</h4>
          <AccessEditor meta={meta} value={acc} onChange={setAcc} />
        </>
      ) : (
        <div className="notice small">Use the “Access” button on the list to change what this person can see.</div>
      )}
    </Modal>
  );
}

function AccessModal({ pro, meta, onClose, onSaved }: { pro: Json; meta: Json; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [v, setV] = useState<Access>({ modules: { ...(pro.access?.modules ?? {}) }, canFile: !!pro.access?.canFile });
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      await put(`/api/v1/organisation/professionals/${pro.id}/access`, { modules: v.modules, canFile: v.canFile });
      onSaved();
    } catch (e) {
      toast((e as Error).message, true);
      setBusy(false);
    }
  };
  return (
    <Modal
      title={`Access — ${pro.fullName}`}
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy} onClick={save}>
            Save access
          </button>
        </>
      }
    >
      <AccessEditor meta={meta} value={v} onChange={setV} />
    </Modal>
  );
}

function RequestsModal({ meta, onClose, onDecided }: { meta: Json; onClose: () => void; onDecided: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['organisation', 'professional-requests'], queryFn: () => get<Json>('/api/v1/organisation/professional-requests') });
  const [busy, setBusy] = useState<string | null>(null);
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['organisation', 'professional-requests'] });
    onDecided();
  };
  const decide = async (id: string, approve: boolean) => {
    if (!approve && !confirm('Decline this request?')) return;
    setBusy(id);
    try {
      await post(`/api/v1/organisation/professional-requests/${id}/decide`, { approve });
      toast(approve ? 'Approved — access granted' : 'Declined');
      refresh();
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy(null);
    }
  };
  const items: Json[] = q.data?.items ?? [];
  const pending = items.filter((r) => r.status === 'pending');
  const decided = items.filter((r) => r.status !== 'pending');
  return (
    <Modal title="Access requests" onClose={onClose} wide>
      {q.isLoading ? (
        <Spinner />
      ) : !items.length ? (
        <Empty title="No requests">When an accountant or CA asks for more access, it shows up here for your approval.</Empty>
      ) : (
        <div className="stack">
          {pending.map((r) => (
            <div key={r.id} className="panel" style={{ padding: 12 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                <div>
                  <b>{r.fullName}</b> <span className="muted small">{r.kindLabel} · {fmtDate(r.createdAt)}</span>
                  <div style={{ marginTop: 4 }}>
                    <AccessChips access={r.requested} meta={meta} />
                  </div>
                  {r.note && <div className="small" style={{ marginTop: 4, whiteSpace: 'normal' }}>“{r.note}”</div>}
                </div>
                <div style={{ whiteSpace: 'nowrap' }}>
                  <button className="btn primary sm" disabled={busy === r.id} onClick={() => decide(r.id, true)}>
                    Approve
                  </button>
                  <button className="btn ghost sm" disabled={busy === r.id} onClick={() => decide(r.id, false)}>
                    Decline
                  </button>
                </div>
              </div>
            </div>
          ))}
          {decided.length > 0 && (
            <>
              <h4 style={{ margin: '8px 0 0' }}>Recently decided</h4>
              {decided.map((r) => (
                <div key={r.id} className="small" style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span>
                    {r.fullName} — <AccessChips access={r.requested} meta={meta} />
                  </span>
                  <span className={`chip ${r.status === 'approved' ? '' : 'warn'}`}>{r.status}</span>
                </div>
              ))}
            </>
          )}
        </div>
      )}
    </Modal>
  );
}
