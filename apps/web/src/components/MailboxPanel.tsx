import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api, del, get, patch, post, put } from '../lib/api';
import { relative } from '../lib/format';
import { useOAuthReturn } from '../lib/oauthReturn';
import { Spinner, useToast } from './ui';
import { SetUpKeysLink } from './admin/ConnectionKeys';

export interface IntegrationStatus {
  mailbox: { id: string; provider: 'google' | 'microsoft'; account: string; status: string; lastSyncAt: string | null; lastError: string | null; config: { calendar?: boolean; ignore?: string[] } } | null;
  available: { google: boolean; microsoft: boolean; meta: boolean };
  telephony: boolean;
  payments: boolean;
  myPhone: string | null;
}

export function useIntegrationStatus() {
  return useQuery({ queryKey: ['integrations-status'], queryFn: () => get<IntegrationStatus>('/api/v1/integrations/status'), staleTime: 60_000 });
}

/** My account → "Email, calendar & calls": own mailbox and own phone for click-to-call. */
export function MailboxPanel() {
  const qc = useQueryClient();
  const toast = useToast();
  const { data, isLoading } = useIntegrationStatus();
  const reload = () => qc.invalidateQueries({ queryKey: ['integrations-status'] });
  useOAuthReturn(reload);
  const [phone, setPhone] = useState('');
  const [ignore, setIgnore] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setPhone(data?.myPhone ?? '');
    setIgnore((data?.mailbox?.config.ignore ?? []).join(', '));
  }, [data]);
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
  const mb = data.mailbox;
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Email, calendar &amp; calls</h2>
        {mb && <span className={`chip ${mb.status === 'active' ? 'good' : 'bad'}`}>{mb.status === 'active' ? 'Connected' : 'Reconnect needed'}</span>}
      </div>
      <div className="panel-body stack">
        {mb ? (
          <>
            <div className="spread">
              <div>
                <b>{mb.provider === 'google' ? 'Gmail' : 'Outlook'}</b> · {mb.account}
                <div className="muted small">{mb.lastSyncAt ? `Last synced ${relative(mb.lastSyncAt)}` : 'Not synced yet'}</div>
                {mb.lastError && <div className="small" style={{ color: 'var(--bad)' }}>{mb.lastError}</div>}
              </div>
              <div className="row">
                {mb.status !== 'active' ? (
                  <button className="btn primary sm" disabled={busy} onClick={() => connect(mb.provider)}>
                    Reconnect
                  </button>
                ) : (
                  <button
                    className="btn sm"
                    disabled={busy}
                    onClick={() =>
                      act(async () => {
                        const r = await post<{ fetched: number; logged: number }>('/api/v1/integrations/mailbox/sync');
                        toast(r.logged ? `${r.logged} new email${r.logged > 1 ? 's' : ''} logged` : 'Up to date');
                      })
                    }
                  >
                    Sync now
                  </button>
                )}
                <button className="btn ghost sm" disabled={busy} onClick={() => act(() => del('/api/v1/integrations/mailbox'), 'Mailbox disconnected')}>
                  Disconnect
                </button>
              </div>
            </div>
            <p className="muted small" style={{ margin: 0 }}>
              Mail with people who are contacts or open leads in SanchalanOS is added to their timeline — nothing else is read or stored. Email you send from SanchalanOS goes out from this address.
            </p>
            <label className="row">
              <span className="switch">
                <input type="checkbox" checked={mb.config.calendar !== false} onChange={(e) => act(() => patch('/api/v1/integrations/mailbox', { calendar: e.target.checked }), 'Saved')} aria-label="Add my SanchalanOS meetings to my calendar" />
                <span />
              </span>
              Add my SanchalanOS meetings and site visits to my {mb.provider === 'google' ? 'Google' : 'Outlook'} calendar
            </label>
            <label className="field">
              <span>Never log mail with these addresses or domains</span>
              <div className="row" style={{ gap: 6 }}>
                <input value={ignore} onChange={(e) => setIgnore(e.target.value)} placeholder="e.g. family.com, accountant@firm.in" />
                <button
                  className="btn sm"
                  disabled={busy}
                  onClick={() =>
                    act(
                      () => patch('/api/v1/integrations/mailbox', { ignore: ignore.split(/[\s,;]+/).map((x) => x.trim().replace(/^@/, '')).filter(Boolean) }),
                      'Saved',
                    )
                  }
                >
                  Save
                </button>
              </div>
            </label>
          </>
        ) : data.available.google || data.available.microsoft ? (
          <>
            <p className="small" style={{ margin: 0 }}>
              Connect your mailbox: customer emails appear on their timelines automatically, you send from your own address, and meetings land in your calendar.
            </p>
            <div className="row">
              {data.available.google && (
                <button className="btn" disabled={busy} onClick={() => connect('google')}>
                  Connect Gmail
                </button>
              )}
              {data.available.microsoft && (
                <button className="btn" disabled={busy} onClick={() => connect('microsoft')}>
                  Connect Outlook / Microsoft 365
                </button>
              )}
            </div>
          </>
        ) : (
          <p className="muted small" style={{ margin: 0 }}>
            <SetUpKeysLink group="google">Gmail and Outlook sync are not set up yet.</SetUpKeysLink>
          </p>
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

/** Places a click-to-call through the workspace's telephony provider. */
export async function placeCall(object: string, id: string, phone?: string | null) {
  return api<{ activityId: string; sid: string }>('/api/v1/telephony/call', { method: 'POST', body: { object, id, phone: phone ?? null } });
}
