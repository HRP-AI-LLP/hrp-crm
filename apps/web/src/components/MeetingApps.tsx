/**
 * My account → Meeting apps: connect my own Zoom, Google Meet and Microsoft Teams accounts (as many
 * as I use) like plugins. Calls can then be created on them, and their transcripts are fetched and
 * analysed after each call.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { del, get, patch, post } from '../lib/api';
import { relative } from '../lib/format';
import { useOAuthReturn } from '../lib/oauthReturn';
import { Spinner, useToast } from './ui';

type Json = Record<string, any>;
const APPS: { key: 'zoom' | 'gmeet' | 'msmeet'; provider: string; name: string; note: string }[] = [
  { key: 'zoom', provider: 'zoom_meet', name: 'Zoom', note: 'Cloud-recording transcripts (Pro plan or above, audio transcript switched on).' },
  { key: 'gmeet', provider: 'google_meet', name: 'Google Meet', note: 'Meet transcripts (Workspace editions with transcription).' },
  { key: 'msmeet', provider: 'ms_teams_meet', name: 'Microsoft Teams', note: 'Teams meeting transcripts (work or school account; your admin may need to approve).' },
];
const TOGGLES: [string, string][] = [
  ['autoFetch', 'Fetch transcripts after calls'],
  ['autoAnalyse', 'Write minutes automatically'],
  ['createTasks', 'Turn team actions into project tasks'],
  ['importAll', 'Also pick up meetings not scheduled in Synapse'],
];

export function MeetingAppsPanel({ returnTo = '/account' }: { returnTo?: '/account' | '/calls' }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { data } = useQuery({ queryKey: ['meeting-accounts'], queryFn: () => get<{ accounts: Json[]; available: Record<string, boolean> }>('/api/v1/meeting-accounts') });
  const reload = () => {
    qc.invalidateQueries({ queryKey: ['meeting-accounts'] });
    qc.invalidateQueries({ queryKey: ['meeting-choices'] });
  };
  useOAuthReturn(reload);
  const [busy, setBusy] = useState<string | null>(null);
  const act = async (key: string, fn: () => Promise<unknown>, ok?: string) => {
    setBusy(key);
    try {
      const r = await fn();
      if (ok) toast(ok);
      reload();
      return r;
    } catch (e) {
      toast((e as Error).message, true);
      return null;
    } finally {
      setBusy(null);
    }
  };
  const connect = (k: string) =>
    act(k, async () => {
      const r = await post<{ url: string }>(`/api/v1/integrations/oauth/${k}/start`, { returnTo });
      window.location.href = r.url;
    });
  return (
    <section className="panel" id="meeting-apps">
      <div className="panel-head">
        <h2>Meeting apps</h2>
        {data && data.accounts.length > 0 && <span className="chip good">{data.accounts.length} connected</span>}
      </div>
      <div className="panel-body stack">
        <p className="muted small" style={{ margin: 0 }}>
          Connect the accounts you hold calls on. Synapse creates the meeting when you schedule a project call, picks up the transcript afterwards, and writes the minutes with each person’s actions.
        </p>
        {!data ? (
          <Spinner />
        ) : (
          APPS.map((app) => {
            const mine = data.accounts.filter((a) => a.provider === app.provider);
            const can = data.available[app.provider];
            return (
              <div key={app.key} className="meet-app">
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <div>
                    <span className={`meet-badge ${app.provider}`}>{app.name}</span>
                    <div className="muted small">{app.note}</div>
                  </div>
                  <button className="btn small" disabled={!can || busy === app.key} title={can ? '' : 'Not set up for this workspace yet (the administrator adds the app keys)'} onClick={() => connect(app.key)}>
                    {mine.length ? 'Add another account' : 'Connect'}
                  </button>
                </div>
                {mine.map((a) => (
                  <div key={a.id} className="meet-account">
                    <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 6 }}>
                      <div>
                        <strong>{a.account}</strong>{' '}
                        <span className={`chip ${a.status === 'active' ? 'good' : 'bad'}`}>{a.status === 'active' ? 'Connected' : 'Reconnect'}</span>
                        <div className="muted small">
                          {a.lastSyncAt ? `Last checked ${relative(a.lastSyncAt)}` : 'Not checked yet'}
                          {a.lastError && <span className="bad-text"> · {a.lastError}</span>}
                        </div>
                      </div>
                      <div className="row" style={{ gap: 6 }}>
                        {a.status !== 'active' && (
                          <button className="btn small" onClick={() => connect(app.key)}>
                            Reconnect
                          </button>
                        )}
                        <button
                          className="btn small"
                          disabled={busy === a.id}
                          onClick={() =>
                            act(a.id, async () => {
                              const r = await post<{ found: number; added: number }>(`/api/v1/meeting-accounts/${a.id}/import`, {});
                              toast(r.added ? `${r.added} meeting${r.added > 1 ? 's' : ''} picked up` : `No new meetings with transcripts (${r.found} found)`);
                            })
                          }
                        >
                          {busy === a.id ? 'Checking…' : 'Pick up last 7 days'}
                        </button>
                        <button className="btn small danger" onClick={() => window.confirm(`Disconnect ${a.account}? Calls already recorded stay.`) && act(`x${a.id}`, () => del(`/api/v1/meeting-accounts/${a.id}`), 'Disconnected')}>
                          Disconnect
                        </button>
                      </div>
                    </div>
                    <div className="toggles">
                      {TOGGLES.map(([k, l]) => (
                        <label key={k} className="row small">
                          <input type="checkbox" checked={k === 'importAll' ? !!a.config?.[k] : a.config?.[k] !== false} onChange={(e) => act(`t${a.id}`, () => patch(`/api/v1/meeting-accounts/${a.id}`, { [k]: e.target.checked }))} /> {l}
                        </label>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            );
          })
        )}
      </div>
    </section>
  );
}
