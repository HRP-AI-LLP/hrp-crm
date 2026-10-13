import type { FieldDef, RecordDto } from '@synapse/shared';
import { objectPerm } from '@synapse/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { FieldInput, FieldValue } from '../components/fields';
import { Empty, Modal, ScoreRing, Spinner, useToast } from '../components/ui';
import { ApiError, del, get, patch, post } from '../lib/api';
import { useAuth } from '../lib/auth';
import { dateTime, relative } from '../lib/format';
import { useObject, usePipelines } from '../lib/hooks';
import { TaskList } from './Tasks';

interface Activity {
  id: string;
  kind: string;
  subject: string | null;
  body: string | null;
  direction: string | null;
  sentiment: string | null;
  occurred_at: string;
  actor_name: string | null;
}

const KIND_MARK: Record<string, string> = { note: 'N', call: 'C', email: '@', meeting: 'M', whatsapp: 'W', sms: 'S', stage_change: '→', system: '•', ai: 'AI', webhook: '⇄' };

export function RecordDetailPage() {
  const { object = '', id = '' } = useParams();
  const obj = useObject(object);
  const qc = useQueryClient();
  const toast = useToast();
  const nav = useNavigate();
  const { me } = useAuth();
  const [tab, setTab] = useState<'timeline' | 'tasks' | 'ai'>('timeline');
  const [converting, setConverting] = useState(false);
  const pipelines = usePipelines(object);
  const key = ['record', object, id];
  const { data: rec, isLoading, error } = useQuery({ queryKey: key, queryFn: () => get<RecordDto>(`/api/v1/records/${object}/${id}`) });

  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) => patch<RecordDto>(`/api/v1/records/${object}/${id}`, body, rec ? { 'if-match': String(rec.version) } : undefined),
    onSuccess: (r) => {
      qc.setQueryData(key, r);
      qc.invalidateQueries({ queryKey: ['records', object] });
      qc.invalidateQueries({ queryKey: ['timeline', object, id] });
    },
    onError: (e) => {
      if (e instanceof ApiError && e.status === 409) {
        toast('Someone else changed this record. Reloaded the latest version.', true);
        qc.invalidateQueries({ queryKey: key });
      } else toast(e instanceof ApiError && e.details?.[0] ? `${e.details[0].field}: ${e.details[0].message}` : (e as Error).message, true);
    },
  });

  if (isLoading || !obj) return <Spinner />;
  if (error || !rec) return <Empty title="This record is not available">It may have been deleted, or you may not have access to it.</Empty>;

  const perm = me ? objectPerm(me.permissions, object) : null;
  const canEdit = perm?.update !== 'none';
  const pipeline = pipelines.find((p) => p.id === rec.pipeline_id);
  const stageIdx = pipeline?.stages.findIndex((s) => s.id === rec.stage_id) ?? -1;
  const fields = obj.fields.filter((f) => !['full_name', 'pipeline_id', 'stage_id', 'ai_score'].includes(f.key));
  const insights = rec.ai_insights as { reasons?: string[]; nextAction?: string | null; model?: string | null } | null;

  return (
    <>
      <div className="page-head">
        <div className="row" style={{ gap: 14 }}>
          {object === 'lead' && <ScoreRing value={rec.ai_score as number | null} size="lg" />}
          <div>
            <div className="muted small">{obj.label}</div>
            <h1>{rec.title || 'Untitled'}</h1>
            <p className="small">Updated {relative(rec.updated_at)}</p>
          </div>
        </div>
        <div className="row">
          {object === 'lead' && !rec.converted_at && canEdit && (
            <button className="btn primary" onClick={() => setConverting(true)}>
              Convert lead
            </button>
          )}
          {perm?.delete !== 'none' && (
            <button
              className="btn danger"
              onClick={async () => {
                if (!window.confirm(`Delete this ${obj.label.toLowerCase()}? It disappears from lists; its history stays in the audit log.`)) return;
                await del(`/api/v1/records/${object}/${id}`);
                toast(`${obj.label} deleted`);
                qc.invalidateQueries({ queryKey: ['records', object] });
                nav(`/o/${object}`);
              }}
            >
              Delete
            </button>
          )}
        </div>
      </div>

      {pipeline && (
        <div className="panel" style={{ padding: 10, marginBottom: 20 }}>
          <div className="stage-track" role="group" aria-label={`${pipeline.name} stage`}>
            {pipeline.stages.map((s, i) => (
              <button
                key={s.id}
                className={`${i < stageIdx ? 'done' : ''} ${i === stageIdx ? 'current' : ''} ${s.category}`}
                aria-pressed={i === stageIdx}
                disabled={!canEdit || save.isPending}
                onClick={() => i !== stageIdx && save.mutate({ stage_id: s.id })}
                title={`${s.label} · ${s.probability}%`}
              >
                {s.label}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="record-grid">
        <section className="panel">
          <div className="panel-head">
            <h2>Details</h2>
          </div>
          <div className="fields">
            {fields.map((f) => (
              <EditableField key={f.key} field={f} record={rec} objectKey={object} editable={canEdit && !f.readOnly} onSave={(v) => save.mutateAsync({ [f.key]: v })} />
            ))}
          </div>
        </section>

        <section className="panel">
          <div className="tabs" role="tablist">
            {(['timeline', 'tasks', 'ai'] as const).map((t) => (
              <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)}>
                {t === 'timeline' ? 'Timeline' : t === 'tasks' ? 'Tasks' : 'Synapse AI'}
              </button>
            ))}
          </div>
          {tab === 'timeline' && <Timeline object={object} id={id} canLog={canEdit} />}
          {tab === 'tasks' && (
            <div className="panel-body">
              <TaskList relatedObject={object} relatedId={id} compact />
            </div>
          )}
          {tab === 'ai' && <AiPanel object={object} id={id} insights={insights} />}
        </section>
      </div>

      {converting && <ConvertModal leadId={id} company={String(rec.company ?? '')} onClose={() => setConverting(false)} />}
    </>
  );
}

function EditableField({ field, record, objectKey, editable, onSave }: { field: FieldDef; record: RecordDto; objectKey: string; editable: boolean; onSave: (v: unknown) => Promise<unknown> }) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState<unknown>(record[field.key]);
  const commit = async () => {
    if (JSON.stringify(val ?? null) !== JSON.stringify(record[field.key] ?? null)) {
      try {
        await onSave(val);
      } catch {
        setVal(record[field.key]);
      }
    }
    setEditing(false);
  };
  return (
    <div
      className={`fv${editable && !editing ? ' editable' : ''}`}
      onClick={() => {
        if (editable && !editing) {
          setVal(record[field.key]);
          setEditing(true);
        }
      }}
    >
      <span>{field.label}</span>
      {editing ? (
        <div
          onBlur={(e) => !e.currentTarget.contains(e.relatedTarget as Node) && commit()}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && field.type !== 'textarea') commit();
            if (e.key === 'Escape') setEditing(false);
          }}
        >
          <FieldInput field={field} objectKey={objectKey} value={val} onChange={setVal} />
        </div>
      ) : (
        <span className="val">
          <FieldValue field={field} record={record} />
        </span>
      )}
    </div>
  );
}

function Timeline({ object, id, canLog }: { object: string; id: string; canLog: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [kind, setKind] = useState('note');
  const [body, setBody] = useState('');
  const { data, isLoading } = useQuery({ queryKey: ['timeline', object, id], queryFn: () => get<{ items: Activity[] }>(`/api/v1/records/${object}/${id}/timeline`) });
  const log = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!body.trim()) return;
    try {
      await post(`/api/v1/records/${object}/${id}/activities`, { kind, subject: kind === 'note' ? 'Note' : `Logged ${kind}`, body });
      setBody('');
      qc.invalidateQueries({ queryKey: ['timeline', object, id] });
    } catch (err) {
      toast((err as Error).message, true);
    }
  };
  return (
    <>
      {canLog && (
        <form className="panel-body stack" style={{ borderBottom: '1px solid var(--line-2)', gap: 8 }} onSubmit={log}>
          <textarea placeholder="Write a note, or log a call or meeting…" value={body} onChange={(e) => setBody(e.target.value)} aria-label="Activity" style={{ minHeight: 64 }} />
          <div className="spread">
            <select value={kind} onChange={(e) => setKind(e.target.value)} style={{ width: 'auto' }} aria-label="Activity type">
              <option value="note">Note</option>
              <option value="call">Call</option>
              <option value="meeting">Meeting</option>
              <option value="email">Email (logged)</option>
              <option value="whatsapp">WhatsApp (logged)</option>
            </select>
            <button className="btn primary sm" disabled={!body.trim()}>
              Add to timeline
            </button>
          </div>
        </form>
      )}
      {isLoading ? (
        <div className="panel-body">
          <Spinner />
        </div>
      ) : data?.items.length ? (
        <ul className="timeline">
          {data.items.map((a) => (
            <li key={a.id}>
              <span className="ico" aria-hidden="true">
                {KIND_MARK[a.kind] ?? '•'}
              </span>
              <div>
                <div className="spread">
                  <b>{a.subject ?? a.kind}</b>
                  <span className="muted small">{dateTime(a.occurred_at)}</span>
                </div>
                <div className="muted small">
                  {a.actor_name ?? (a.direction === 'in' ? 'Customer' : 'Automation')}
                  {a.sentiment ? ` · sentiment ${a.sentiment}` : ''}
                </div>
                {a.body && <div className="body">{a.body}</div>}
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <Empty title="No activity yet">Calls, notes, emails and stage changes will appear here.</Empty>
      )}
    </>
  );
}

function AiPanel({ object, id, insights }: { object: string; id: string; insights: { reasons?: string[]; nextAction?: string | null; model?: string | null } | null }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [summary, setSummary] = useState<{ summary: string; key_points: string[]; risks: string[] } | null>(null);
  const [actions, setActions] = useState<{ title: string; reason: string; priority: string; type: string; due_in_hours?: number }[] | null>(null);
  const [draft, setDraft] = useState<{ subject: string; body: string } | null>(null);
  const [intent, setIntent] = useState('Follow up on our last conversation and propose a call this week');

  const run = async <T,>(name: string, fn: () => Promise<T>, done: (r: T) => void) => {
    setBusy(name);
    try {
      done(await fn());
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="panel-body stack">
      {object === 'lead' && (
        <div className="ai-box">
          <div className="spread">
            <h3>Why this score</h3>
            <button className="btn ai sm" disabled={!!busy} onClick={() => run('score', () => post(`/api/ai/score/lead/${id}`), () => qc.invalidateQueries({ queryKey: ['record', object, id] }))}>
              {busy === 'score' ? 'Scoring…' : 'Rescore'}
            </button>
          </div>
          {insights?.reasons?.length ? (
            <ul>
              {insights.reasons.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          ) : (
            <p className="muted">Not scored yet.</p>
          )}
          {insights?.nextAction && (
            <p>
              <b>Suggested next step:</b> {insights.nextAction}
            </p>
          )}
          {insights?.model && <p className="muted small">Model: {insights.model}</p>}
        </div>
      )}

      <div className="row" style={{ flexWrap: 'wrap' }}>
        <button className="btn ai" disabled={!!busy} onClick={() => run('sum', () => post<typeof summary>(`/api/ai/summarize/${object}/${id}`), setSummary)}>
          {busy === 'sum' ? 'Summarising…' : 'Summarise this record'}
        </button>
        <button className="btn ai" disabled={!!busy} onClick={() => run('nba', () => post<{ actions: NonNullable<typeof actions> }>(`/api/ai/next-actions/${object}/${id}`), (r) => setActions(r.actions))}>
          {busy === 'nba' ? 'Thinking…' : 'Suggest next actions'}
        </button>
      </div>

      {summary && (
        <div className="ai-box">
          <h3>Summary</h3>
          <p>{summary.summary}</p>
          {summary.key_points.length > 0 && (
            <ul>
              {summary.key_points.map((k) => (
                <li key={k}>{k}</li>
              ))}
            </ul>
          )}
          {summary.risks.length > 0 && (
            <>
              <b>Risks</b>
              <ul>
                {summary.risks.map((k) => (
                  <li key={k}>{k}</li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}

      {actions && (
        <div className="ai-box">
          <h3>Next best actions</h3>
          <ul>
            {actions.map((a) => (
              <li key={a.title}>
                <div className="spread">
                  <b>{a.title}</b>
                  <button
                    className="btn sm"
                    onClick={async () => {
                      await post('/api/v1/tasks', { title: a.title, description: a.reason, priority: a.priority === 'high' ? 'high' : 'normal', dueAt: a.due_in_hours ? new Date(Date.now() + a.due_in_hours * 3600_000).toISOString() : null, relatedObject: object, relatedId: id });
                      toast('Task created');
                      qc.invalidateQueries({ queryKey: ['tasks'] });
                    }}
                  >
                    Make it a task
                  </button>
                </div>
                <div className="muted small">{a.reason}</div>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="stack" style={{ gap: 8 }}>
        <label className="field">
          Draft an email
          <input value={intent} onChange={(e) => setIntent(e.target.value)} />
        </label>
        <div>
          <button className="btn ai" disabled={!!busy || intent.length < 3} onClick={() => run('draft', () => post<{ subject: string; body: string }>(`/api/ai/draft-email/${object}/${id}`, { intent }), setDraft)}>
            {busy === 'draft' ? 'Drafting…' : 'Write draft'}
          </button>
        </div>
        {draft && (
          <div className="ai-box">
            <b>{draft.subject}</b>
            <p style={{ whiteSpace: 'pre-wrap' }}>{draft.body}</p>
            <button className="btn sm" onClick={() => navigator.clipboard.writeText(`Subject: ${draft.subject}\n\n${draft.body}`).then(() => toast('Draft copied'))}>
              Copy draft
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function ConvertModal({ leadId, company, onClose }: { leadId: string; company: string; onClose: () => void }) {
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const [createDeal, setCreateDeal] = useState(true);
  const [dealName, setDealName] = useState(company ? `${company} – opportunity` : '');
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try {
      const r = await post<{ contactId: string; dealId: string | null }>(`/api/v1/records/lead/${leadId}/convert`, { createDeal, dealName: dealName || undefined, amount: amount ? Number(amount) : undefined });
      toast('Lead converted');
      qc.invalidateQueries();
      nav(r.dealId ? `/o/deal/${r.dealId}` : `/o/contact/${r.contactId}`);
    } catch (e) {
      toast((e as Error).message, true);
      setBusy(false);
    }
  };
  return (
    <Modal
      title="Convert lead"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={go} disabled={busy}>
            {busy ? 'Converting…' : 'Convert lead'}
          </button>
        </>
      }
    >
      <div className="modal-body">
        <p className="wide muted">This creates a contact{company ? ` and the account “${company}”` : ''}, and keeps the lead's history linked.</p>
        <label className="row wide">
          <input type="checkbox" checked={createDeal} onChange={(e) => setCreateDeal(e.target.checked)} /> Also create a deal
        </label>
        {createDeal && (
          <>
            <label className="field">
              Deal name
              <input value={dealName} onChange={(e) => setDealName(e.target.value)} />
            </label>
            <label className="field">
              Amount (₹)
              <input type="number" value={amount} onChange={(e) => setAmount(e.target.value)} />
            </label>
          </>
        )}
      </div>
    </Modal>
  );
}
