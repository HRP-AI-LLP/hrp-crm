/**
 * Copilot: the daily workspace. Today's meetings with their brief and debrief status, what to do
 * first, action items from meetings and calls, the insights feed, Ask Synapse, and (for anyone
 * who can see more than their own deals) a pipeline review.
 */
import { objectPerm } from '@synapse/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { AgentOutput, type Json, type Run } from '../components/intel/AgentOutput';
import { MeetingModal } from '../components/intel/MeetingModal';
import { ActionItems, AskBox, InsightList } from '../components/intel/Widgets';
import { Spinner, useToast } from '../components/ui';
import { get, post } from '../lib/api';
import { useAuth } from '../lib/auth';

const time = (v: string) => new Date(v).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });

export function CopilotPage() {
  const { me } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const meeting = params.get('meeting');
  const q = useQuery({ queryKey: ['copilot'], queryFn: () => get<Json>('/api/v1/intel/copilot'), refetchInterval: 120_000 });
  const [itemTab, setItemTab] = useState<'active' | 'overdue' | 'done'>('active');
  const manager = !!me && objectPerm(me.permissions, 'deal').read !== 'own' && objectPerm(me.permissions, 'deal').read !== 'none';
  const review = useQuery({ queryKey: ['runs', 'team'], queryFn: () => get<{ items: Run[] }>('/api/v1/intel/runs?object=team&limit=1'), enabled: manager });
  const [busy, setBusy] = useState(false);
  const runReview = async () => {
    setBusy(true);
    try {
      await post('/api/v1/intel/agents/pipeline_review/run', {});
      qc.invalidateQueries({ queryKey: ['runs', 'team'] });
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  };
  const openMeeting = (id: string | null) => {
    const p = new URLSearchParams(params);
    if (id) p.set('meeting', id);
    else p.delete('meeting');
    setParams(p, { replace: true });
  };

  const hour = Number(new Date().toLocaleString('en-IN', { hour: 'numeric', hour12: false, timeZone: 'Asia/Kolkata' }));
  const greet = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  const d = q.data;
  const counts = d?.actionItems ?? {};
  return (
    <>
      <div className="page-head">
        <div>
          <h1>
            {greet}, {me?.user.fullName.split(' ')[0]}
          </h1>
          <p>Your meetings, follow-ups and what Synapse noticed, in one place.</p>
        </div>
      </div>
      <AskBox />
      {!d ? (
        <Spinner />
      ) : (
        <>
          <div className="cp-stats">
            <div className="cp-stat">
              <b>{d.meetings.length}</b>
              <span>meetings today</span>
              <small>{d.meetings.filter((m: Json) => new Date(m.starts_at).getTime() > Date.now()).length} upcoming</small>
            </div>
            <div className="cp-stat">
              <b>{(counts.open ?? 0) + (counts.in_progress ?? 0)}</b>
              <span>open action items</span>
              <small>{counts.in_progress ?? 0} in progress · {counts.ai ?? 0} from AI</small>
            </div>
            <div className={`cp-stat${counts.overdue ? ' bad' : ''}`}>
              <b>{counts.overdue ?? 0}</b>
              <span>overdue</span>
              <small>{counts.done_week ?? 0} done this week</small>
            </div>
            <div className="cp-stat">
              <b>{d.insights.length}</b>
              <span>insights</span>
              <small>{d.insights.filter((i: Json) => i.severity === 'risk').length} risks · {d.insights.filter((i: Json) => i.severity === 'opportunity').length} opportunities</small>
            </div>
          </div>

          <div className="cp-grid">
            <section className="panel">
              <div className="panel-head">
                <h2>Your meetings today</h2>
                <Link to="/calendar" className="small">
                  Calendar
                </Link>
              </div>
              <div className="panel-body">
                {d.meetings.length === 0 && <p className="muted small">No meetings today.</p>}
                {(d.meetings as Json[]).map((m) => {
                  const past = new Date(m.ends_at).getTime() < Date.now();
                  return (
                    <button key={m.id} className="meeting-row" onClick={() => openMeeting(m.id)}>
                      <span className="meeting-time">{time(m.starts_at)}</span>
                      <span className="grow">
                        <b>{m.title}</b>
                        <span className="small muted"> · {m.kind.replace('_', ' ')}</span>
                      </span>
                      {past ? <span className={`chip tiny ${m.debriefed ? 'good' : 'warn'}`}>{m.debriefed ? 'Debriefed' : 'Debrief'}</span> : <span className={`chip tiny ${m.prepped ? 'good' : 'info'}`}>{m.prepped ? 'Brief ready' : 'Prepare'}</span>}
                    </button>
                  );
                })}
              </div>
            </section>

            <section className="panel">
              <div className="panel-head">
                <h2>Do these first</h2>
              </div>
              <div className="panel-body">
                {d.focus.length === 0 && <p className="muted small">Nothing urgent. A good day to prospect.</p>}
                <ol className="focus-list">
                  {(d.focus as Json[]).map((f, i) =>
                    f.kind === 'meeting' ? (
                      <li key={i}>
                        <button className="link-btn" onClick={() => openMeeting(new URLSearchParams(f.link.split('?')[1]).get('meeting'))}>
                          {f.title}
                        </button>
                        <div className="small muted">{f.why}</div>
                      </li>
                    ) : (
                      <li key={i}>
                        <Link to={f.link}>{f.title}</Link>
                        <div className="small muted">{f.why}</div>
                      </li>
                    ),
                  )}
                </ol>
              </div>
            </section>

            <section className="panel">
              <div className="panel-head">
                <h2>Action items</h2>
                <div className="seg">
                  {(['active', 'overdue', 'done'] as const).map((t) => (
                    <button key={t} aria-pressed={itemTab === t} onClick={() => setItemTab(t)}>
                      {t === 'active' ? 'Open' : t === 'overdue' ? 'Overdue' : 'Done'}
                    </button>
                  ))}
                </div>
              </div>
              <div className="panel-body">
                <ActionItems query={`scope=mine&status=${itemTab}`} canAdd={itemTab === 'active'} empty={itemTab === 'overdue' ? 'Nothing overdue.' : itemTab === 'done' ? 'Nothing done yet.' : 'No open action items.'} />
              </div>
            </section>

            <section className="panel">
              <div className="panel-head">
                <h2>Insights</h2>
              </div>
              <div className="panel-body">
                <InsightList items={d.insights} />
              </div>
            </section>
          </div>

          {manager && (
            <section className="panel" style={{ marginTop: 16 }}>
              <div className="panel-head">
                <h2>Pipeline review</h2>
                <button className="btn ai sm" disabled={busy} onClick={runReview}>
                  {busy ? 'Reviewing…' : review.data?.items.length ? 'Run again' : 'Review the pipeline'}
                </button>
              </div>
              <div className="panel-body">{review.data?.items[0] ? <AgentOutput run={review.data.items[0]} /> : <p className="muted small">Inspects every open deal you can see: stalled and slipped deals, missing next steps, risk by owner, coaching notes.</p>}</div>
            </section>
          )}
        </>
      )}
      {meeting && <MeetingModal eventId={meeting} onClose={() => openMeeting(null)} />}
    </>
  );
}
