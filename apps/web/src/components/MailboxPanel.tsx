import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api, del, get, patch, post, put } from '../lib/api';
import { relative } from '../lib/format';
import { useOAuthReturn } from '../lib/oauthReturn';
import { Spinner, useToast } from './ui';
import { SetUpKeysLink } from './admin/ConnectionKeys';

export type Mailbox = { id: string; provider: 'google' | 'microsoft'; account: string; status: string; lastSyncAt: string | null; lastError: string | null; primary?: boolean; config: { calendar?: boolean; ignore?: string[]; invites?: boolean } };
export interface IntegrationStatus {
  /** the primary mailbox: calendar mirroring and the default "From" */
  mailbox: Mailbox | null;
  mailboxes: Mailbox[];
  available: { google: boolean; microsoft: boolean; meta: boolean };
  telephony: boolean;
  payments: boolean;
  myPhone: string | null;
}

export function useIntegrationStatus() {
  return useQuery({ queryKey: ['integrations-status'], queryFn: () => get<IntegrationStatus>('/api/v1/integrations/status'), staleTime: 60_000 });
}

/** My account → "Email, calendar & calls": own mailboxes (several allowed) and own phone for click-to-call. */
export function MailboxPanel() {
  const qc = useQueryClient();
  const toast = useToast();
  const { data, isLoading } = useIntegrationStatus();
  const reload = () => qc.invalidateQueries({ queryKey: ['integrations-status'] });
  useOAuthReturn(reload);
  const [phone, setPhone] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => setPhone(data?.myPhone ?? ''), [data]);
  const act = async (fn: () => Promise<unknown>, ok?: string) => {
    setBusy(true);
    try {
      await fn();
      if (ok) toast(ok);
      reload();
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  };
  const connect = (p: 'google' | 'microsoft') =>
    act(async () => {
      const r = await post<{ url: string }>(`/api/v1/integrations/oauth/${p}/start`, { returnTo: '/account' });
      window.location.href = r.url;
    });
  if (isLoading || !data) return <Spinner />;
  const boxes = data.mailboxes ?? (data.mailbox ? [data.mailbox] : []);
  const canConnect = data.available.google || data.available.microsoft;
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Email, calendar &amp; calls</h2>
        {boxes.length > 0 && <span className="chip good">{boxes.length} mailbox{boxes.length === 1 ? '' : 'es'}</span>}
      </div>
      <div className="panel-body stack">
        {boxes.map((mb) => (
          <MailboxRow key={mb.id} mb={mb} many={boxes.length > 1} busy={busy} act={act} reconnect={() => connect(mb.provider)} />
        ))}
        {boxes.length > 0 && (
          <p className="muted small" style={{ margin: 0 }}>
            Mail with people who are contacts or open leads in SanchalanOS is added to their timeline — nothing else is read or stored. Email you send from SanchalanOS goes out from your primary mailbox unless you choose another in the composer.
          </p>
        )}
        {canConnect ? (
          <>
            {!boxes.length && (
              <p className="small" style={{ margin: 0 }}>
                Connect your mailbox: customer emails appear on their timelines automatically, you send from your own address, and meetings land in your calendar.
              </p>
            )}
            <div className="row">
              {data.available.google && (
                <button className="btn" disabled={busy} onClick={() => connect('google')}>
                  {boxes.length ? '+ Add another Gmail' : 'Connect Gmail'}
                </button>
              )}
              {data.available.microsoft && (
                <button className="btn" disabled={busy} onClick={() => connect('microsoft')}>
                  {boxes.length ? '+ Add another Outlook / Microsoft 365' : 'Connect Outlook / Microsoft 365'}
                </button>
              )}
            </div>
            {boxes.length > 0 && <p className="muted small" style={{ margin: 0 }}>To add a different account, sign out of the current one in the Google / Microsoft window (or use a private window) so you can pick the other address.</p>}
          </>
        ) : (
          !boxes.length && (
            <p className="muted small" style={{ margin: 0 }}>
              <SetUpKeysLink group="google">Gmail and Outlook sync are not set up yet.</SetUpKeysLink>
            </p>
          )
        )}
        <hr className="sep" />
        <label className="field">
          <span>My phone number {data.telephony ? '(rings first for click-to-call)' : '(used for click-to-call once your admin connects calling)'}</span>
          <div className="row" style={{ gap: 6 }}>
            <input type="tel" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+91 98100 00000" />
            <button className="btn sm" disabled={busy || phone === (data.myPhone ?? '')} onClick={() => act(() => put('/api/v1/me/phone', { phone: phone.trim() || null }), 'Phone saved')}>
              Save
            </button>
          </div>
        </label>
      </div>
    </section>
  );
}

function MailboxRow({ mb, many, busy, act, reconnect }: { mb: Mailbox; many: boolean; busy: boolean; act: (fn: () => Promise<unknown>, ok?: string) => Promise<void>; reconnect: () => void }) {
  const toast = useToast();
  const [ignore, setIgnore] = useState((mb.config.ignore ?? []).join(', '));
  useEffect(() => setIgnore((mb.config.ignore ?? []).join(', ')), [mb]);
  const base = `/api/v1/integrations/mailboxes/${mb.id}`;
  return (
    <div className="panel stack" style={{ padding: 12, gap: 8 }}>
      <div className="spread">
        <div>
          <b>{mb.provider === 'google' ? 'Gmail' : 'Outlook'}</b> · {mb.account} {many && mb.primary && <span className="chip info">primary</span>}{' '}
          <span className={`chip ${mb.status === 'active' ? 'good' : 'bad'}`}>{mb.status === 'active' ? 'Connected' : 'Reconnect needed'}</span>
          <div className="muted small">{mb.lastSyncAt ? `Last synced ${relative(mb.lastSyncAt)}` : 'Not synced yet'}</div>
          {mb.lastError && <div className="small" style={{ color: 'var(--bad)' }}>{mb.lastError}</div>}
        </div>
        <div className="row" style={{ flexWrap: 'wrap' }}>
          {many && !mb.primary && (
            <button className="btn sm ghost" disabled={busy} title="Default From address and the calendar your meetings go to" onClick={() => act(() => patch(base, { primary: true }), `${mb.account} is now your primary mailbox`)}>
              Make primary
            </button>
          )}
          {mb.status !== 'active' ? (
            <button className="btn primary sm" disabled={busy} onClick={reconnect}>
              Reconnect
            </button>
          ) : (
            <button
              className="btn sm"
              disabled={busy}
              onClick={() =>
                act(async () => {
                  const r = await post<{ fetched: number; logged: number }>(`${base}/sync`);
                  toast(r.logged ? `${r.logged} new email${r.logged > 1 ? 's' : ''} logged` : 'Up to date');
                })
              }
            >
              Sync now
            </button>
          )}
          <button className="btn ghost sm" disabled={busy} onClick={() => act(() => del(base), `${mb.account} disconnected`)}>
            Disconnect
          </button>
        </div>
      </div>
      {(mb.primary || !many) && (
        <label className="row">
          <span className="switch">
            <input type="checkbox" checked={mb.config.calendar !== false} onChange={(e) => act(() => patch(base, { calendar: e.target.checked }), 'Saved')} aria-label="Add my SanchalanOS meetings to my calendar" />
            <span />
          </span>
          Add my SanchalanOS meetings and site visits to this {mb.provider === 'google' ? 'Google' : 'Outlook'} calendar
        </label>
      )}
      <label className="field">
        <span>Never log mail with these addresses or domains</span>
        <div className="row" style={{ gap: 6 }}>
          <input value={ignore} onChange={(e) => setIgnore(e.target.value)} placeholder="e.g. family.com, accountant@firm.in" />
          <button className="btn sm" disabled={busy} onClick={() => act(() => patch(base, { ignore: ignore.split(/[\s,;]+/).map((x) => x.trim().replace(/^@/, '')).filter(Boolean) }), 'Saved')}>
            Save
          </button>
        </div>
      </label>
    </div>
  );
}

/** Places a click-to-call through the workspace's telephony provider. */
export async function placeCall(object: string, id: string, phone?: string | null) {
  return api<{ activityId: string; sid: string }>('/api/v1/telephony/call', { method: 'POST', body: { object, id, phone: phone ?? null } });
}
