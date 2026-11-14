/**
 * The Copilot tab on a lead, contact, account or deal: scores, the agents that fit this record,
 * their latest results with sources, suggested field updates, action items, insights,
 * competitors (deals), call debriefs and "ask about this record".
 */
import { AGENTS } from '@synapse/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { get, post, upload } from '../../lib/api';
import { useMeta } from '../../lib/hooks';
import { relative } from '../../lib/format';
import { Spinner, useToast } from '../ui';
import { AgentOutput, type Json, type Run, ScoreBadge } from './AgentOutput';
import { ActionItems, AskBox, DealCompetitors, InsightList, Suggestions } from './Widgets';

export function CopilotPanel({ object, id, canEdit }: { object: string; id: string; canEdit: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { data: meta } = useMeta();
  const agents = AGENTS.filter((a) => a.subjects.includes(object as never));
  const scores = useQuery({ queryKey: ['scores', object, id], queryFn: () => get<{ items: Json[] }>(`/api/v1/intel/scores/${object}/${id}`) });
  const runs = useQuery({ queryKey: ['runs', object, id], queryFn: () => get<{ items: Run[] }>(`/api/v1/intel/runs?object=${object}&id=${id}&limit=12`) });
  const insights = useQuery({ queryKey: ['insights', object, id], queryFn: () => get<{ items: Json[] }>(`/api/v1/intel/insights?object=${object}&id=${id}`) });
  const enabled = useQuery({ queryKey: ['agents'], queryFn: () => get<{ items: Json[] }>('/api/v1/intel/agents'), staleTime: 300_000 });
  const [busy, setBusy] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [channel, setChannel] = useState<'email' | 'whatsapp'>('whatsapp');
  const [showFacts, setShowFacts] = useState(false);
  const facts = useQuery({ queryKey: ['context', object, id], queryFn: () => get<{ facts: Json[] }>(`/api/v1/intel/context/${object}/${id}`), enabled: showFacts });

  const run = async (key: string, extra: Json = {}) => {
    setBusy(key);
    try {
      const r = await post<Run>(`/api/v1/intel/agents/${key}/run`, { object, id, ...extra });
      setOpen(r.id);
      qc.invalidateQueries({ queryKey: ['runs', object, id] });
      qc.invalidateQueries({ queryKey: ['scores', object, id] });
      qc.invalidateQueries({ queryKey: ['suggestions', object, id] });
      qc.invalidateQueries({ queryKey: ['action-items'] });
      qc.invalidateQueries({ queryKey: ['insights', object, id] });
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy(null);
    }
  };

  const obj = meta?.objects.find((o) => o.key === object);
  const labels: Record<string, string> = Object.fromEntries((obj?.fields ?? []).map((f) => [f.key, f.label]));
  for (const p of meta?.pipelines ?? []) for (const s of p.stages) labels[`stage:${s.id}`] = s.label;
  const latestByAgent = new Map<string, Run>();
  for (const r of runs.data?.items ?? []) if (!latestByAgent.has(r.agent_key!)) latestByAgent.set(r.agent_key!, r);
  const isOff = (k: string) => enabled.data?.items.find((a) => a.key === k)?.enabled === false;

  return (
    <div className="panel-body stack">
      {(scores.data?.items.length ?? 0) > 0 && (
        <div className="row" style={{ flexWrap: 'wrap' }}>
          {scores.data!.items.map((s) => (
            <div key={s.kind} className="score-card">
              <ScoreBadge kind={s.kind} score={s.score} band={s.band} />
              <div className="small muted">{(s.factors as Json[]).slice(0, 3).map((f) => f.label).join(' · ') || 'No notable signals'}</div>
            </div>
          ))}
        </div>
      )}

      <AskBox object={object} id={id} placeholder={`Ask about this ${obj?.label.toLowerCase() ?? 'record'}…`} />

      <Suggestions object={object} id={id} labels={labels} />

      <div>
        <h3 style={{ marginBottom: 8 }}>Agents</h3>
        <div className="agent-grid">
          {agents.map((a) => {
            const last = latestByAgent.get(a.key);
            return (
              <div key={a.key} className={`agent-card${isOff(a.key) ? ' off' : ''}`}>
                <div className="spread">
                  <b>{a.label}</b>
                  {last && (
                    <button className="link-btn small" onClick={() => setOpen(open === last.id ? null : last.id)}>
                      {open === last.id ? 'Hide' : `Last run ${relative(last.started_at)}`}
                    </button>
                  )}
                </div>
                <p className="small muted">{a.description}</p>
                <div className="row">
                  {a.key === 'outreach' && (
                    <select value={channel} onChange={(e) => setChannel(e.target.value as 'email' | 'whatsapp')} aria-label="Channel" style={{ width: 'auto' }}>
                      <option value="whatsapp">WhatsApp</option>
                      <option value="email">Email</option>
                    </select>
                  )}
                  <button className="btn ai sm" disabled={!!busy || isOff(a.key)} onClick={() => run(a.key, a.key === 'outreach' ? { channel } : {})}>
                    {busy === a.key ? 'Working…' : isOff(a.key) ? 'Switched off' : last ? 'Run again' : 'Run'}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
        {open && runs.data?.items.find((r) => r.id === open) && (
          <div className="ai-box" style={{ marginTop: 10 }}>
            <AgentOutput run={runs.data.items.find((r) => r.id === open)!} />
          </div>
        )}
      </div>

      {object === 'deal' && <DealCompetitors dealId={id} canEdit={canEdit} />}

      <CallDebriefs object={object} id={id} canEdit={canEdit} />

      <div>
        <h3 style={{ marginBottom: 8 }}>Action items</h3>
        <ActionItems query={`scope=record&object=${object}&id=${id}&status=all`} relatedObject={object} relatedId={id} canAdd />
      </div>

      {(insights.data?.items.length ?? 0) > 0 && (
        <div>
          <h3 style={{ marginBottom: 8 }}>Insights</h3>
          <InsightList items={insights.data!.items} />
        </div>
      )}

      <details onToggle={(e) => setShowFacts((e.target as HTMLDetailsElement).open)}>
        <summary className="small">What Synapse knows about this record</summary>
        {showFacts && !facts.data ? (
          <Spinner />
        ) : (
          <ol className="facts small">
            {(facts.data?.facts ?? []).map((f) => (
              <li key={f.ref}>
                <span className="cite">{f.ref}</span> {f.text}
              </li>
            ))}
          </ol>
        )}
        <p className="small muted">Only what you can see is used. Agents cite these numbers so you can check every point.</p>
      </details>
    </div>
  );
}

/** Logged calls on this record: paste a transcript or upload the recording for a debrief. */
function CallDebriefs({ object, id, canEdit }: { object: string; id: string; canEdit: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const tl = useQuery({ queryKey: ['timeline', object, id], queryFn: () => get<{ items: Json[] }>(`/api/v1/records/${object}/${id}/timeline`) });
  const calls = (tl.data?.items ?? []).filter((a) => a.kind === 'call' && !a.metadata?.debriefRunId).slice(0, 5);
  const [active, setActive] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const done = () => {
    setActive(null);
    setText('');
    qc.invalidateQueries({ queryKey: ['timeline', object, id] });
    qc.invalidateQueries({ queryKey: ['runs', object, id] });
    qc.invalidateQueries({ queryKey: ['suggestions', object, id] });
    qc.invalidateQueries({ queryKey: ['action-items'] });
    toast('Call debriefed');
  };
  const go = async (file?: File) => {
    if (!active) return;
    setBusy(true);
    try {
      if (file) await upload(`/api/v1/intel/calls/${active}/transcribe`, new Blob([file], { type: file.type || 'audio/mpeg' }));
      else await post(`/api/v1/intel/agents/call_debrief/run`, { object: 'call', id: active, transcript: text });
      done();
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  };
  if (!canEdit || !calls.length) return null;
  return (
    <div>
      <h3 style={{ marginBottom: 8 }}>Calls to debrief</h3>
      {calls.map((c) => (
        <div key={c.id} className="comp-row">
          <div className="spread">
            <span>
              {c.subject ?? 'Call'} <span className="small muted">· {relative(c.occurred_at)}</span>
            </span>
            <button className="btn sm ai" onClick={() => setActive(active === c.id ? null : c.id)}>
              Debrief
            </button>
          </div>
          {active === c.id && (
            <div className="stack" style={{ gap: 6, marginTop: 6 }}>
              <textarea rows={4} value={text} onChange={(e) => setText(e.target.value)} placeholder="Paste the call transcript or your notes" aria-label="Call transcript" />
              <div className="row">
                <button className="btn sm primary" disabled={busy || text.trim().length < 20} onClick={() => go()}>
                  {busy ? 'Working…' : 'Debrief from text'}
                </button>
                <label className="btn sm">
                  Upload recording
                  <input type="file" accept="audio/*" hidden onChange={(e) => e.target.files?.[0] && go(e.target.files[0])} />
                </label>
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
