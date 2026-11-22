/** My calls across projects: upcoming, held, and meetings picked up from my meeting apps that are not yet filed on a project. */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { MeetingAppsPanel } from '../components/MeetingApps';
import { CallDetail, CallTable } from '../components/projects/ProjectCalls';
import { Empty, Spinner, useToast } from '../components/ui';
import { get, post } from '../lib/api';
import { useOAuthReturn } from '../lib/oauthReturn';
import { Guide } from '../components/admin/ConnectionKeys';

type Json = Record<string, any>;
type Scope = 'upcoming' | 'recent' | 'unassigned';

export function CallsPage() {
  const [params, setParams] = useSearchParams();
  const scope = (params.get('scope') as Scope) || 'upcoming';
  const open = params.get('call');
  const set = (k: string, v: string | null) =>
    setParams((p) => {
      const n = new URLSearchParams(p);
      if (v) n.set(k, v);
      else n.delete(k);
      return n;
    });
  const qc = useQueryClient();
  const toast = useToast();
  useOAuthReturn(() => qc.invalidateQueries({ queryKey: ['meeting-accounts'] }));
  const { data } = useQuery({ queryKey: ['my-calls', scope], queryFn: () => get<{ calls: Json[] }>(`/api/v1/calls?scope=${scope}`) });
  const { data: inbox } = useQuery({ queryKey: ['my-calls', 'unassigned'], queryFn: () => get<{ calls: Json[] }>('/api/v1/calls?scope=unassigned') });
  const [apps, setApps] = useState(false);
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Calls</h1>
          <p>Project calls with clients and the team — transcripts and minutes, with each person’s actions.</p>
          <Guide id="meeting_apps" label="How calls, meeting apps and transcripts work" />
        </div>
        <div className="row" style={{ gap: 6 }}>
          <button
            className="btn"
            onClick={async () => {
              try {
                const r = await post<Json>('/api/v1/calls/invites/sync', {});
                toast(!r.mailbox ? 'Connect Gmail or Outlook in My account to pick up call invites' : r.added ? `${r.added} call${r.added > 1 ? 's' : ''} added from your calendar${r.fromEmail ? ` and emailed invitations (${r.fromEmail})` : ''}` : `No new call invites (${r.found} seen)`, !r.mailbox);
                qc.invalidateQueries({ queryKey: ['my-calls'] });
              } catch (e) {
                toast((e as Error).message, true);
              }
            }}
          >
            Check my invites
          </button>
          <button className="btn" onClick={() => setApps(!apps)}>
            {apps ? 'Hide meeting apps' : 'Meeting apps'}
          </button>
        </div>
      </div>
      {apps && (
        <div style={{ marginBottom: 16 }}>
          <MeetingAppsPanel returnTo="/calls" />
        </div>
      )}
      <section className="panel">
        <div className="panel-head">
          <div className="seg">
            {(
              [
                ['upcoming', 'Upcoming'],
                ['recent', 'Held'],
                ['unassigned', `Not filed${inbox?.calls.length ? ` (${inbox.calls.length})` : ''}`],
              ] as const
            ).map(([k, l]) => (
              <button key={k} className={scope === k ? 'on' : ''} onClick={() => set('scope', k === 'upcoming' ? null : k)}>
                {l}
              </button>
            ))}
          </div>
        </div>
        <div className="panel-body">
          {!data ? (
            <Spinner />
          ) : !data.calls.length ? (
            <Empty title={scope === 'unassigned' ? 'Nothing to file' : scope === 'upcoming' ? 'No upcoming calls' : 'No calls held yet'}>
              {scope === 'unassigned' ? (
                'Meetings picked up from your Zoom, Google Meet or Teams accounts that SanchalanOS could not match to a project land here.'
              ) : (
                <>
                  Schedule calls from a project’s <strong>Calls</strong> section. <Link to="/projects">Open projects</Link>
                </>
              )}
            </Empty>
          ) : scope === 'unassigned' ? (
            <Unfiled calls={data.calls} onOpen={(id) => set('call', id)} />
          ) : (
            <CallTable calls={data.calls} onOpen={(id) => set('call', id)} showProject />
          )}
        </div>
      </section>
      {open && <CallDetail id={open} onClose={() => set('call', null)} />}
    </>
  );
}

function Unfiled({ calls, onOpen }: { calls: Json[]; onOpen: (id: string) => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const { data: projects } = useQuery({ queryKey: ['projects', 'mine', 'any'], queryFn: () => get<Json[]>('/api/v1/projects?mine=1') });
  const file = async (id: string, projectId: string) => {
    try {
      await post(`/api/v1/calls/${id}/assign`, { projectId });
      toast('Filed on the project');
      qc.invalidateQueries({ queryKey: ['my-calls'] });
    } catch (e) {
      toast((e as Error).message, true);
    }
  };
  return (
    <table className="data">
      <thead>
        <tr>
          <th>When</th>
          <th>Meeting</th>
          <th>App</th>
          <th>File on project</th>
        </tr>
      </thead>
      <tbody>
        {calls.map((c) => (
          <tr key={c.id}>
            <td className="nowrap">{new Date(c.startsAt).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</td>
            <td>
              <button className="link-btn" onClick={() => onOpen(c.id)}>
                {c.title}
              </button>
              {c.summary && <div className="muted small clamp2">{c.summary}</div>}
            </td>
            <td>{c.meeting ? <span className={`meet-badge ${c.meeting.provider}`}>{c.meeting.label}</span> : '—'}</td>
            <td>
              <select defaultValue="" onChange={(e) => e.target.value && file(c.id, e.target.value)} aria-label="Project">
                <option value="">Choose…</option>
                {(projects ?? []).map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
