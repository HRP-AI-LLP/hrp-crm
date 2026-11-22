/**
 * Project → Coding agent: Claude Code or Codex on a developer's machine works this project's stories,
 * tasks and bugs over MCP. New and changed items queue for it; it implements and tests them, then
 * waits here for a person to verify — Approve (commit & push), Request changes, or Stop.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { get, post, put } from '../../lib/api';
import { dateTime, relative } from '../../lib/format';
import { Markdown } from '../Markdown';
import { Guide } from '../admin/ConnectionKeys';
import { Modal, Spinner, useToast } from '../ui';

type Json = Record<string, any>;
const TYPES = ['story', 'task', 'bug', 'subtask', 'spike', 'improvement'];
const STATUS: Record<string, [string, string]> = {
  queued: ['queued', ''],
  claimed: ['picked up', 'info'],
  working: ['working', 'info'],
  testing: ['testing', 'info'],
  awaiting_review: ['needs your review', 'warn'],
  approved: ['approved — pushing', 'good'],
  changes_requested: ['changes requested', 'warn'],
  committed: ['committed', 'good'],
  pushed: ['pushed', 'good'],
  released: ['released', 'good'],
  failed: ['failed', 'bad'],
  cancelled: ['stopped', ''],
};

function JobModal({ jobId, manage, onClose }: { jobId: string; manage: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const { data, refetch } = useQuery({ queryKey: ['agent-job', jobId], queryFn: () => get<Json>(`/api/v1/agent/jobs/${jobId}`), refetchInterval: 15_000 });
  const act = async (verdict: 'approve' | 'changes' | 'cancel') => {
    setBusy(true);
    try {
      await post(`/api/v1/agent/jobs/${jobId}/review`, { verdict, note: note.trim() || null });
      toast(verdict === 'approve' ? 'Approved: the agent will commit and push' : verdict === 'changes' ? 'Sent back to the agent' : 'Stopped');
      setNote('');
      refetch();
      qc.invalidateQueries({ queryKey: ['agent'] });
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  };
  if (!data) return null;
  const j = data.job;
  const [label, tone] = STATUS[j.status] ?? [j.status, ''];
  return (
    <Modal title={`${j.key} ${j.name}`} wide onClose={onClose}>
      <div className="modal-body stack">
        <div className="row small" style={{ gap: 8, flexWrap: 'wrap' }}>
          <span className={`chip ${tone}`}>{label}</span>
          {j.agent && <span className="muted">by {j.agent}</span>}
          {j.branch && (
            <span>
              branch <code>{j.branch}</code>
            </span>
          )}
          {j.commit_sha && (
            <span>
              commit <code>{String(j.commit_sha).slice(0, 10)}</code>
            </span>
          )}
          {j.pr_url && (
            <a href={j.pr_url} target="_blank" rel="noreferrer">
              Pull request ↗
            </a>
          )}
        </div>
        {j.summary && (
          <section className="panel" style={{ padding: 10 }}>
            <b className="small">What the agent did</b>
            <Markdown source={j.summary} />
          </section>
        )}
        {j.how_to_verify && (
          <section className="panel" style={{ padding: 10 }}>
            <b className="small">How to verify</b>
            <Markdown source={j.how_to_verify} />
          </section>
        )}
        {j.test_report && (
          <details className="panel" style={{ padding: 10 }}>
            <summary className="small">
              <b>Tests</b>
            </summary>
            <pre className="asst-json">{j.test_report}</pre>
          </details>
        )}
        {manage && j.status === 'awaiting_review' && (
          <section className="panel stack" style={{ padding: 10, borderColor: 'var(--accent)' }}>
            <b>Your verdict</b>
            <p className="small muted" style={{ margin: 0 }}>
              Check it out locally (branch <code>{j.branch}</code>) or on the preview, then approve — the agent commits, pushes{j.pr_url ? '' : ', opens a pull request'} and runs the release — or say what to change.
            </p>
            <textarea rows={3} placeholder="Notes for the agent (required to request changes)" value={note} onChange={(e) => setNote(e.target.value)} />
            <div className="row" style={{ gap: 6 }}>
              <button className="btn primary" disabled={busy} onClick={() => act('approve')}>
                Approve — commit & push
              </button>
              <button className="btn" disabled={busy || !note.trim()} onClick={() => act('changes')}>
                Request changes
              </button>
              <button className="btn ghost" disabled={busy} onClick={() => act('cancel')}>
                Stop
              </button>
            </div>
          </section>
        )}
        {manage && !['awaiting_review', 'released', 'failed', 'cancelled'].includes(j.status) && (
          <button className="btn sm ghost" style={{ alignSelf: 'flex-start' }} disabled={busy} onClick={() => act('cancel')}>
            Stop this job
          </button>
        )}
        <h3 style={{ margin: 0 }}>Timeline</h3>
        <ol className="stack" style={{ gap: 6, paddingLeft: 18, margin: 0 }}>
          {(data.events as Json[]).map((e) => (
            <li key={e.id} className="small">
              <b>{e.stage.replace(/_/g, ' ')}</b> <span className="muted">· {e.actor} · {dateTime(e.at)}</span>
              {e.message && <div style={{ whiteSpace: 'pre-wrap' }}>{String(e.message).slice(0, 2000)}</div>}
            </li>
          ))}
        </ol>
      </div>
    </Modal>
  );
}

function Connect({ open }: { open: boolean }) {
  return (
    <div className="stack" style={{ gap: 6 }}>
      <b>Connect Claude Code or Codex</b>
      <Guide id="coding_agent_claude" open={open} />
      <Guide id="coding_agent_codex" />
      <Guide id="coding_agent_runner" />
    </div>
  );
}

export function CodingAgent({ id, manage }: { id: string; manage: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { data, refetch } = useQuery({ queryKey: ['agent', id], queryFn: () => get<Json>(`/api/v1/projects/${id}/agent`), refetchInterval: 20_000 });
  const [s, setS] = useState<Json | null>(null);
  const [job, setJob] = useState<string | null>(() => new URLSearchParams(window.location.search).get('job'));
  const [busy, setBusy] = useState(false);
  useEffect(() => setS(null), [data]);
  if (!data) return <Spinner />;
  const cfg = s ?? data.settings;
  const change = (p: Json) => setS({ ...cfg, ...p });
  const save = async () => {
    setBusy(true);
    try {
      await put(`/api/v1/projects/${id}/agent/settings`, cfg);
      toast('Coding agent settings saved');
      refetch();
      qc.invalidateQueries({ queryKey: ['agent', id] });
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  };
  const jobs = data.jobs as Json[];
  const review = jobs.filter((j) => j.status === 'awaiting_review');
  return (
    <div className="stack">
      <p className="small muted" style={{ margin: 0 }}>
        Claude Code or Codex on a developer's machine implements this project's work items. Each one is built and tested locally, then waits for a person to verify it here before anything is committed or pushed.
      </p>
      {review.length > 0 && (
        <div className="notice">
          <b>{review.length}</b> waiting for your review:{' '}
          {review.map((j) => (
            <button key={j.id} className="link-btn" onClick={() => setJob(j.id)}>
              {j.work_key}-{j.task_number} {j.name}
            </button>
          ))}
        </div>
      )}
      <section className="panel stack" style={{ padding: 12 }}>
        <label className="row" style={{ gap: 8 }}>
          <span className="switch">
            <input type="checkbox" disabled={!manage} checked={cfg.enabled} onChange={(e) => change({ enabled: e.target.checked })} aria-label="Send work items to the coding agent" />
            <span />
          </span>
          <b>Send this project's work items to the coding agent</b>
        </label>
        <div className="row small" style={{ gap: 12, flexWrap: 'wrap' }}>
          <span className="muted">Item types:</span>
          {TYPES.map((t) => (
            <label key={t} className="row" style={{ gap: 4 }}>
              <input type="checkbox" disabled={!manage} checked={cfg.workTypes.includes(t)} onChange={(e) => change({ workTypes: e.target.checked ? [...cfg.workTypes, t] : cfg.workTypes.filter((x: string) => x !== t) })} />
              {t}
            </label>
          ))}
        </div>
        <div className="row small" style={{ gap: 16, flexWrap: 'wrap' }}>
          <label className="row" style={{ gap: 4 }}>
            <input type="checkbox" disabled={!manage} checked={cfg.onCreate} onChange={(e) => change({ onCreate: e.target.checked })} /> when created
          </label>
          <label className="row" style={{ gap: 4 }}>
            <input type="checkbox" disabled={!manage} checked={cfg.onUpdate} onChange={(e) => change({ onUpdate: e.target.checked })} /> when the title or description changes, or it is reopened
          </label>
          <label className="row" style={{ gap: 4 }} title="Off: a person always verifies the work before it is committed and pushed">
            <input type="checkbox" disabled={!manage} checked={cfg.autoPush} onChange={(e) => change({ autoPush: e.target.checked })} /> push without review (not recommended)
          </label>
        </div>
        <div className="grid-2" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 10 }}>
          <label className="field">
            Local folder on the developer's machine
            <input disabled={!manage} placeholder="e.g. fleet-app (cloned from the linked repo if missing)" value={cfg.localFolder ?? ''} onChange={(e) => change({ localFolder: e.target.value })} />
          </label>
          <label className="field">
            Release command (after push)
            <input disabled={!manage} placeholder="e.g. pnpm deploy:prod, or gh workflow run deploy.yml" value={cfg.releaseCommand ?? ''} onChange={(e) => change({ releaseCommand: e.target.value })} />
          </label>
        </div>
        <label className="field">
          Instructions for the agent (stack, build and test commands, conventions)
          <textarea disabled={!manage} rows={4} placeholder={'pnpm install\npnpm test\nBranches: sanchalan/<KEY>-<short-title>. Keep changes small; add tests.'} value={cfg.instructions ?? ''} onChange={(e) => change({ instructions: e.target.value })} />
        </label>
        {manage && (
          <div className="row">
            <button className="btn primary" disabled={busy || !s || !cfg.workTypes.length} onClick={save}>
              Save
            </button>
          </div>
        )}
      </section>
      <Connect open={!jobs.length} />
      <h3 style={{ margin: 0 }}>Jobs</h3>
      {!jobs.length ? (
        <p className="small muted">No jobs yet. Switch it on, then create a story, task or bug — or use “Send to coding agent” on any item.</p>
      ) : (
        <table className="data">
          <tbody>
            {jobs.map((j) => {
              const [label, tone] = STATUS[j.status] ?? [j.status, ''];
              return (
                <tr key={j.id} style={{ cursor: 'pointer' }} onClick={() => setJob(j.id)}>
                  <td className="small">
                    {j.work_key}-{j.task_number}
                  </td>
                  <td>
                    {j.name}
                    <div className="small muted">
                      {j.work_type} · {j.reason.replace(/_/g, ' ')}
                      {j.revision > 1 ? ` · edited ${j.revision - 1}×` : ''}
                      {j.agent ? ` · ${j.agent}` : ''}
                    </div>
                  </td>
                  <td>
                    <span className={`chip ${tone}`}>{label}</span>
                  </td>
                  <td className="small muted">{relative(j.updated_at)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {job && <JobModal jobId={job} manage={manage} onClose={() => setJob(null)} />}
    </div>
  );
}

/** "Send to coding agent" on a work item. */
export function SendToAgent({ projectId, taskId }: { projectId: string; taskId: string }) {
  const toast = useToast();
  return (
    <button
      className="btn sm ghost"
      title="Queue this item for Claude Code / Codex (Project → Coding agent)"
      onClick={async () => {
        try {
          await post(`/api/v1/projects/${projectId}/agent/queue`, { taskId });
          toast('Queued for the coding agent');
        } catch (e) {
          toast((e as Error).message, true);
        }
      }}
    >
      🤖 Send to coding agent
    </button>
  );
}
