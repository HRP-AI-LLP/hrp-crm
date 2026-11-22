import { useQuery, useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useState } from 'react';
import { del, get, patch, post } from '../../lib/api';
import { relative } from '../../lib/format';
import { useUsers } from '../../lib/hooks';
import { Modal, Spinner, useToast } from '../ui';
import { Guide, SetUpKeysLink } from './ConnectionKeys';

type Json = Record<string, any>;
interface Item {
  id: string;
  provider: 'google' | 'microsoft' | 'razorpay' | 'exotel' | 'meta_leads' | 'google_leads';
  userId: string | null;
  userName: string | null;
  label: string | null;
  account: string;
  config: Json;
  status: 'active' | 'error' | 'disabled';
  lastSyncAt: string | null;
  lastEventAt: string | null;
  lastError: string | null;
  urls: Record<string, string>;
}

export function CopyField({ label, value }: { label: string; value: string }) {
  const toast = useToast();
  return (
    <label className="field">
      <span>{label}</span>
      <div className="row" style={{ gap: 6 }}>
        <input readOnly value={value} onFocus={(e) => e.target.select()} className="mono small" />
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
    </label>
  );
}

function StatusChip({ i }: { i: Item }) {
  const cls = i.status === 'active' ? 'good' : i.status === 'error' ? 'bad' : '';
  return (
    <span className={`chip ${cls}`} title={i.lastError ?? undefined}>
      {i.status === 'active' ? 'Connected' : i.status === 'error' ? 'Needs attention' : 'Off'}
    </span>
  );
}

function Card({ title, logo, intro, children, action, guide }: { title: string; logo: string; intro: ReactNode; children?: ReactNode; action?: ReactNode; guide?: string }) {
  return (
    <section className="integ-card">
      <div className="spread" style={{ alignItems: 'flex-start' }}>
        <div className="row" style={{ alignItems: 'flex-start', gap: 12 }}>
          <span className="integ-logo" aria-hidden="true">
            {logo}
          </span>
          <div>
            <h3>{title}</h3>
            <p className="muted small">{intro}</p>
          </div>
        </div>
        {action}
      </div>
      {children}
      {guide && <Guide id={guide} />}
    </section>
  );
}

function Activity({ i }: { i: Item }) {
  return (
    <span className="muted small">
      {i.lastEventAt ? `Last event ${relative(i.lastEventAt)}` : 'No events yet'}
      {i.lastError ? ` · ${i.lastError}` : ''}
    </span>
  );
}

export function IntegrationsTab() {
  const qc = useQueryClient();
  const toast = useToast();
  const users = useUsers();
  const { data, isLoading } = useQuery({ queryKey: ['admin-integrations'], queryFn: () => get<{ items: Item[]; available: { google: boolean; microsoft: boolean; meta: boolean } }>('/api/admin/integrations') });
  const [modal, setModal] = useState<null | 'razorpay' | 'exotel'>(null);
  const [exoEdit, setExoEdit] = useState<Item | undefined>(undefined);
  const [revealed, setRevealed] = useState<Record<string, string>>({});
  const reload = () => qc.invalidateQueries({ queryKey: ['admin-integrations'] });
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      toast(ok);
      reload();
      return true;
    } catch (e) {
      toast((e as Error).message, true);
      return false;
    }
  };
  if (isLoading || !data) return <Spinner />;
  const of = (p: Item['provider']) => data.items.filter((i) => i.provider === p && i.status !== 'disabled');
  const byDefault = (a: Item, b: Item) => Number(!!b.config.default) - Number(!!a.config.default);
  const rzps = of('razorpay').sort(byDefault);
  const exos = of('exotel').sort(byDefault);
  const defaultChip = (i: Item, list: Item[], what: string) =>
    list.length > 1 &&
    (i.config.default || list[0] === i ? (
      <span className="chip info">default</span>
    ) : (
      <button className="btn sm ghost" onClick={() => run(() => patch(`/api/admin/integrations/${i.id}`, { makeDefault: true }), `${i.account} now takes ${what}`)}>
        Make default
      </button>
    ));
  const pages = of('meta_leads');
  const gads = of('google_leads');
  const mailboxes = data.items.filter((i) => i.userId);
  const ownerSelect = (i: Item) => (
    <label className="field" style={{ maxWidth: 320 }}>
      <span>New leads go to</span>
      <select value={i.config.ownerId ?? ''} onChange={(e) => run(() => patch(`/api/admin/integrations/${i.id}`, { ownerId: e.target.value || null }), 'Saved')}>
        <option value="">Assignment rules (or the workspace owner)</option>
        {users.data?.items.map((u) => (
          <option key={u.id} value={u.id}>
            {u.full_name}
          </option>
        ))}
      </select>
    </label>
  );

  return (
    <div className="stack integ">
      <p className="muted" style={{ margin: 0 }}>
        Connect the services your team already uses. Credentials are encrypted for this workspace and never shown again after saving.
      </p>

      {/* --------------------------------------------------------------- payments */}
      <Card
        title="Razorpay — online payments"
        guide="razorpay"
        logo="₹"
        intro="Send payment links for invoices and order milestones (UPI, cards, net banking). Paid links record the receipt automatically."
        action={
          <button className={`btn ${rzps.length ? 'sm' : 'primary'}`} onClick={() => setModal('razorpay')}>
            {rzps.length ? '+ Add another account' : 'Connect Razorpay'}
          </button>
        }
      >
        {rzps.map((rzp) => (
          <div key={rzp.id} className="integ-body">
            <div className="spread">
              <div className="small">
                {rzp.label} · Key <code>{rzp.account}</code> · <Activity i={rzp} />
              </div>
              <div className="row">
                <StatusChip i={rzp} />
                {defaultChip(rzp, rzps, 'new payment links')}
                <button className="btn sm danger" onClick={() => run(() => del(`/api/admin/integrations/${rzp.id}`), 'Razorpay account disconnected')}>
                  Disconnect
                </button>
              </div>
            </div>
            <CopyField label="Webhook URL — add it in Razorpay Dashboard → Accounts & Settings → Webhooks" value={rzp.urls.webhook!} />
            <p className="muted small" style={{ margin: 0 }}>
              Use the same webhook secret you entered here and tick the events <code>payment_link.paid</code>, <code>payment_link.partially_paid</code>, <code>payment_link.cancelled</code> and <code>payment_link.expired</code>. To change keys, connect the account again with the new keys.
            </p>
          </div>
        ))}
        {rzps.length > 1 && <p className="muted small" style={{ margin: 0 }}>New payment links use the default account; payments on older links still arrive on their own account.</p>}
      </Card>

      {/* --------------------------------------------------------------- telephony */}
      <Card
        title="Exotel — calling"
        guide="exotel"
        logo="☎"
        intro="Click-to-call from any lead, contact or account: Exotel rings the salesperson's phone, then connects the customer from your ExoPhone. Calls, recordings and missed calls are logged automatically."
        action={
          <button className={`btn ${exos.length ? 'sm' : 'primary'}`} onClick={() => (setExoEdit(undefined), setModal('exotel'))}>
            {exos.length ? '+ Add another account' : 'Connect Exotel'}
          </button>
        }
      >
        {exos.map((exo) => (
          <div key={exo.id} className="integ-body">
            <div className="spread">
              <div className="small">
                SID <code>{exo.account}</code> · ExoPhone <code>{exo.config.callerId}</code> · recording {exo.config.record === false ? 'off' : 'on'} · <Activity i={exo} />
              </div>
              <div className="row">
                <StatusChip i={exo} />
                {defaultChip(exo, exos, 'outgoing calls')}
                <button className="btn sm" onClick={() => (setExoEdit(exo), setModal('exotel'))}>
                  Change
                </button>
                <button className="btn sm danger" onClick={() => run(() => del(`/api/admin/integrations/${exo.id}`), 'Exotel account disconnected')}>
                  Disconnect
                </button>
              </div>
            </div>
            <CopyField label="Incoming calls — add a Passthru applet with this URL at the end of your call flow (App Bazaar)" value={exo.urls.incoming!} />
            <div className="grid2">
              <label className="row">
                <input type="checkbox" checked={exo.config.createLeads !== false} onChange={(e) => run(() => patch(`/api/admin/integrations/${exo.id}`, { createLeads: e.target.checked }), 'Saved')} />
                Create a lead for unknown callers
              </label>
              <label className="row">
                <input type="checkbox" checked={exo.config.record !== false} onChange={(e) => run(() => patch(`/api/admin/integrations/${exo.id}`, { record: e.target.checked }), 'Saved')} />
                Record click-to-call calls
              </label>
              <label className="row">
                <input type="checkbox" checked={!!exo.config.allowInternational} onChange={(e) => run(() => patch(`/api/admin/integrations/${exo.id}`, { allowInternational: e.target.checked }), 'Saved')} />
                Allow international numbers (off protects against toll fraud)
              </label>
            </div>
            {ownerSelect(exo)}
            <p className="muted small" style={{ margin: 0 }}>
              Each salesperson adds their own mobile number in My account; that phone rings first. Missed calls create a high-priority call-back task for the record owner.
            </p>
          </div>
        ))}
      </Card>

      {/* --------------------------------------------------------------- Meta lead ads */}
      <Card
        title="Facebook & Instagram lead ads"
        guide="meta_leads"
        logo="f"
        intro="Every lead form submission on your pages becomes a lead within seconds — with the form answers, campaign and source — routed by your assignment rules."
        action={
          data.available.meta ? (
            <button
              className="btn primary"
              onClick={() =>
                run(async () => {
                  const r = await post<{ url: string }>('/api/v1/integrations/oauth/meta/start', { returnTo: '/settings' });
                  window.location.href = r.url;
                }, 'Opening Facebook…')
              }
            >
              {pages.length ? 'Add pages' : 'Connect with Facebook'}
            </button>
          ) : (
            <SetUpKeysLink group="meta" />
          )
        }
      >
        {pages.length > 0 && (
          <div className="integ-body">
            <table className="data">
              <tbody>
                {pages.map((p) => (
                  <tr key={p.id}>
                    <td>
                      <b>{p.label}</b>
                      <div className="muted small">Page {p.account}</div>
                    </td>
                    <td>
                      <StatusChip i={p} /> <Activity i={p} />
                    </td>
                    <td style={{ width: 280 }}>{ownerSelect(p)}</td>
                    <td>
                      <button className="btn sm danger" onClick={() => run(() => del(`/api/admin/integrations/${p.id}`), 'Page disconnected')}>
                        Disconnect
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* --------------------------------------------------------------- Google Ads lead forms */}
      <Card
        title="Google Ads lead forms"
        guide="google_leads"
        logo="G"
        intro="Leads from lead form assets in Search, YouTube, Discovery and Performance Max campaigns arrive instantly through a webhook."
        action={
          <button className="btn primary" onClick={() => run(async () => {
            const r = await post<{ id: string; key: string }>('/api/admin/integrations/google-leads', {});
            setRevealed((x) => ({ ...x, [r.id]: r.key }));
          }, 'Webhook created')}>
            {gads.length ? 'Add another' : 'Create webhook'}
          </button>
        }
      >
        {gads.map((g) => (
          <div key={g.id} className="integ-body">
            <div className="spread">
              <b>{g.label}</b>
              <span className="row">
                <StatusChip i={g} /> <Activity i={g} />
                <button className="btn sm danger" onClick={() => run(() => del(`/api/admin/integrations/${g.id}`), 'Webhook removed')}>
                  Remove
                </button>
              </span>
            </div>
            <CopyField label="Webhook URL — Google Ads → lead form → Export leads → Webhook integration" value={g.urls.webhook!} />
            {revealed[g.id] ? (
              <CopyField label="Key" value={revealed[g.id]!} />
            ) : (
              <button
                className="link"
                onClick={async () => {
                  const r = await get<{ key: string }>(`/api/admin/integrations/${g.id}/key`);
                  setRevealed((x) => ({ ...x, [g.id]: r.key }));
                }}
              >
                Show key
              </button>
            )}
            {ownerSelect(g)}
          </div>
        ))}
      </Card>

      {/* --------------------------------------------------------------- mailboxes */}
      <Card
        title="Gmail & Outlook"
        guide="mailbox"
        logo="@"
        intro="Each person connects their own mailbox in My account. Mail with your customers is logged on their timeline, mail sent from SanchalanOS goes from the person's own address, and meetings appear in their calendar."
      >
        <div className="integ-body">
          {!data.available.google && !data.available.microsoft && (
            <p className="muted small" style={{ margin: 0 }}>
              <SetUpKeysLink group="google">Gmail and Outlook are not set up yet (Google and Microsoft app keys).</SetUpKeysLink>
            </p>
          )}
          {mailboxes.length ? (
            <table className="data">
              <tbody>
                {mailboxes.map((m) => (
                  <tr key={m.id}>
                    <td>{m.userName}</td>
                    <td>
                      {m.provider === 'google' ? 'Gmail' : 'Outlook'} · <code>{m.account}</code>
                    </td>
                    <td>
                      <StatusChip i={m} /> <span className="muted small">{m.lastSyncAt ? `synced ${relative(m.lastSyncAt)}` : 'not synced yet'}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="muted small" style={{ margin: 0 }}>
              Nobody has connected a mailbox yet.
            </p>
          )}
        </div>
      </Card>

      {modal === 'razorpay' && <RazorpayModal onClose={() => setModal(null)} onDone={() => { setModal(null); reload(); }} />}
      {modal === 'exotel' && <ExotelModal current={exoEdit} onClose={() => setModal(null)} onDone={() => { setModal(null); reload(); }} />}
    </div>
  );
}

function RazorpayModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [f, setF] = useState({ keyId: '', keySecret: '', webhookSecret: '' });
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      await post('/api/admin/integrations/razorpay', f);
      toast('Razorpay connected');
      onDone();
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title="Connect Razorpay"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy || !f.keyId || !f.keySecret || f.webhookSecret.length < 8} onClick={save}>
            {busy ? 'Checking keys…' : 'Connect'}
          </button>
        </>
      }
    >
      <div className="modal-body" style={{ gridTemplateColumns: '1fr' }}>
        <div className="wide"><Guide id="razorpay" open /></div>
        <p className="muted small" style={{ margin: 0 }}>
          Razorpay Dashboard → Accounts & Settings → API Keys. Use test-mode keys (<code>rzp_test_…</code>) to try it first.
        </p>
        <label className="field">
          <span>Key ID</span>
          <input value={f.keyId} onChange={(e) => setF({ ...f, keyId: e.target.value })} placeholder="rzp_live_…" autoComplete="off" />
        </label>
        <label className="field">
          <span>Key secret</span>
          <input type="password" value={f.keySecret} onChange={(e) => setF({ ...f, keySecret: e.target.value })} autoComplete="off" />
        </label>
        <label className="field">
          <span>Webhook secret (choose one; enter the same in Razorpay's webhook settings)</span>
          <input type="password" value={f.webhookSecret} onChange={(e) => setF({ ...f, webhookSecret: e.target.value })} autoComplete="off" minLength={8} />
        </label>
      </div>
    </Modal>
  );
}

function ExotelModal({ current, onClose, onDone }: { current?: Item; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [f, setF] = useState({
    sid: current?.account ?? '',
    apiKey: '',
    apiToken: '',
    subdomain: (current?.config.subdomain as string) ?? 'api.exotel.com',
    callerId: (current?.config.callerId as string) ?? '',
  });
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      await post('/api/admin/integrations/exotel', { ...f, record: current?.config.record !== false, createLeads: current?.config.createLeads !== false, ownerId: current?.config.ownerId ?? null });
      toast('Exotel connected');
      onDone();
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title="Connect Exotel"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy || !f.sid || !f.apiKey || !f.apiToken || !f.callerId} onClick={save}>
            {busy ? 'Checking…' : 'Connect'}
          </button>
        </>
      }
    >
      <div className="modal-body">
        <div className="wide"><Guide id="exotel" open /></div>
        <p className="muted small wide" style={{ margin: 0 }}>
          Exotel dashboard → Settings → API settings. The ExoPhone is the number customers see.
        </p>
        <label className="field">
          <span>Account SID</span>
          <input value={f.sid} onChange={(e) => setF({ ...f, sid: e.target.value })} autoComplete="off" />
        </label>
        <label className="field">
          <span>Region</span>
          <select value={f.subdomain} onChange={(e) => setF({ ...f, subdomain: e.target.value })}>
            <option value="api.exotel.com">Singapore (api.exotel.com)</option>
            <option value="api.in.exotel.com">Mumbai (api.in.exotel.com)</option>
          </select>
        </label>
        <label className="field">
          <span>API key</span>
          <input value={f.apiKey} onChange={(e) => setF({ ...f, apiKey: e.target.value })} autoComplete="off" />
        </label>
        <label className="field">
          <span>API token</span>
          <input type="password" value={f.apiToken} onChange={(e) => setF({ ...f, apiToken: e.target.value })} autoComplete="off" />
        </label>
        <label className="field">
          <span>ExoPhone (caller ID)</span>
          <input value={f.callerId} onChange={(e) => setF({ ...f, callerId: e.target.value.replace(/[^\d+]/g, '') })} placeholder="08047112233" inputMode="tel" />
        </label>
      </div>
    </Modal>
  );
}
