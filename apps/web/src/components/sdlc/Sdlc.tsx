/**
 * AI delivery: a goal is planned into steps done by specialist agents (business analyst, architect,
 * UX, security, QA, DevOps, writer, project manager, developer); people review what matters. The
 * results — documents, diagrams, backlog, test cases, code — land in the project.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { del, get, post, put } from '../../lib/api';
import { relative } from '../../lib/format';
import { Guide } from '../admin/ConnectionKeys';
import { Empty, Modal, Spinner, useToast } from '../ui';
import { ArtifactModal, ArtifactPanel, DiagramView } from './Viewers';

type Json = Record<string, any>;
type Catalogue = { agents: Json[]; docTypes: Json[]; diagramTypes: Json[]; templates: Json[] };

const RUN_STATUS: Record<string, [string, string]> = {
  planning: ['planning…', 'info'],
  awaiting_plan: ['plan ready — check it', 'warn'],
  running: ['working…', 'info'],
  awaiting_review: ['needs your review', 'warn'],
  done: ['done', 'good'],
  failed: ['failed', 'bad'],
  cancelled: ['cancelled', ''],
};
const STEP_STATUS: Record<string, [string, string]> = {
  pending: ['to do', ''],
  running: ['working…', 'info'],
  awaiting_review: ['review', 'warn'],
  approved: ['approved', 'good'],
  skipped: ['skipped', ''],
  failed: ['failed', 'bad'],
};
const KIND_LABEL: Record<string, string> = { document: 'Document', diagram: 'Diagram', backlog: 'Backlog', test_cases: 'Test cases', code: 'Code' };

const useCatalogue = () => useQuery({ queryKey: ['sdlc-catalogue'], queryFn: () => get<Catalogue>('/api/v1/sdlc/catalogue'), staleTime: Infinity });
const useProjects = () => useQuery({ queryKey: ['projects', 'all-list'], queryFn: () => get<Json[]>('/api/v1/projects?status=active') });

function useAct() {
  const toast = useToast();
  const qc = useQueryClient();
  return async <T,>(fn: () => Promise<T>, ok?: string): Promise<T | null> => {
    try {
      const r = await fn();
      if (ok) toast(ok);
      qc.invalidateQueries({ queryKey: ['sdlc-run'] });
      qc.invalidateQueries({ queryKey: ['sdlc-runs'] });
      qc.invalidateQueries({ queryKey: ['sdlc-artifacts'] });
      return r;
    } catch (e) {
      toast((e as Error).message, true);
      return null;
    }
  };
}

type Section = 'runs' | 'library' | 'studio' | 'agents';

export function SdlcPage() {
  return (
    <div>
      <div className="page-head">
        <div>
          <h1>AI delivery</h1>
          <p>Specialist agents write the documents and diagrams, build the backlog and tests, and hand stories to the coding agent — you review what matters.</p>
        </div>
      </div>
      <SdlcPanel />
    </div>
  );
}

/** The whole thing, for every project (page) or one (project tab). */
export function SdlcPanel({ projectId }: { projectId?: string }) {
  const [params, setParams] = useSearchParams();
  const runId = params.get('run');
  const [section, setSection] = useState<Section>('runs');
  const setRun = (id: string | null) =>
    setParams(
      (p) => {
        const n = new URLSearchParams(p);
        if (id) n.set('run', id);
        else n.delete('run');
        return n;
      },
      { preventScrollReset: true },
    );
  if (runId && /^[0-9a-f-]{36}$/i.test(runId)) return <RunView id={runId} onBack={() => setRun(null)} />;
  return (
    <div className={projectId ? '' : 'panel'}>
      <div className="tabs" role="tablist">
        {(
          [
            ['runs', 'Runs'],
            ['library', 'Documents & diagrams'],
            ['studio', 'Diagram studio'],
            ['agents', 'Agents & formats'],
          ] as [Section, string][]
        ).map(([k, l]) => (
          <button key={k} type="button" role="tab" aria-selected={section === k} onClick={() => setSection(k)}>
            {l}
          </button>
        ))}
      </div>
      <div className={projectId ? '' : 'panel-body'} style={{ paddingTop: 14 }}>
        {section === 'runs' && <RunList projectId={projectId} onOpen={setRun} />}
        {section === 'library' && <Library projectId={projectId} onOpenRun={setRun} />}
        {section === 'studio' && <Studio projectId={projectId} />}
        {section === 'agents' && <AgentsInfo />}
      </div>
    </div>
  );
}

/* ───────────────────────── runs ───────────────────────── */

function RunList({ projectId, onOpen }: { projectId?: string; onOpen: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const { data, isLoading } = useQuery({
    queryKey: ['sdlc-runs', projectId ?? null],
    queryFn: () => get<{ items: Json[] }>(`/api/v1/sdlc/runs${projectId ? `?projectId=${projectId}` : ''}`),
    refetchInterval: (q) => ((q.state.data?.items ?? []).some((r) => r.status === 'running' || r.status === 'planning') ? 5000 : false),
  });
  return (
    <div className="stack">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <p className="small muted" style={{ margin: 0 }}>
          Describe what you want built; the agents plan it, write it and wait for you on the steps that matter.
        </p>
        <button type="button" className="btn primary" onClick={() => setOpen(true)}>
          New run
        </button>
      </div>
      {isLoading ? (
        <Spinner />
      ) : !data?.items.length ? (
        <Empty title="No runs yet" action={<button type="button" className="btn primary" onClick={() => setOpen(true)}>Start one</button>}>
          For example: “Fleet tracking for our transport clients — drivers start trips on a phone, managers see vehicles live, monthly GST invoices per client.”
        </Empty>
      ) : (
        <table className="data">
          <thead>
            <tr>
              <th>Run</th>
              {!projectId && <th>Project</th>}
              <th>Progress</th>
              <th>Status</th>
              <th>Started</th>
            </tr>
          </thead>
          <tbody>
            {data.items.map((r) => {
              const [label, tone] = RUN_STATUS[r.status] ?? [r.status, ''];
              return (
                <tr key={r.id} className="clickable" onClick={() => onOpen(r.id)}>
                  <td>
                    <b>{r.title}</b>
                    <div className="small muted">{r.artifacts} documents & diagrams</div>
                  </td>
                  {!projectId && <td>{r.project ?? <span className="muted">—</span>}</td>}
                  <td style={{ minWidth: 120 }}>
                    <div className="sd-bar">
                      <span style={{ width: `${r.steps ? (100 * r.done) / r.steps : 0}%` }} />
                    </div>
                    <span className="small muted">
                      {r.done} of {r.steps} steps
                    </span>
                  </td>
                  <td>
                    <span className={`chip ${tone}`}>{label}</span>
                  </td>
                  <td className="small muted">
                    {relative(r.created_at)}
                    {r.created_by_name ? ` · ${r.created_by_name}` : ''}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {open && <NewRun projectId={projectId} onClose={() => setOpen(false)} onCreated={onOpen} />}
    </div>
  );
}

function NewRun({ projectId, onClose, onCreated }: { projectId?: string; onClose: () => void; onCreated: (id: string) => void }) {
  const cat = useCatalogue();
  const projects = useProjects();
  const act = useAct();
  const [goal, setGoal] = useState('');
  const [project, setProject] = useState(projectId ?? '');
  const [template, setTemplate] = useState('ai');
  const [mode, setMode] = useState<'each' | 'key' | 'none'>('key');
  const [busy, setBusy] = useState(false);
  const tpl = cat.data?.templates.find((t) => t.key === template);
  const needsProject = !!tpl?.steps.some((s: Json) => ['backlog', 'test_cases', 'code'].includes(s.kind));
  const go = async () => {
    setBusy(true);
    const r = await act(() => post<{ id: string }>('/api/v1/sdlc/runs', { goal, projectId: project || null, template, reviewMode: mode }));
    setBusy(false);
    if (r) {
      onClose();
      onCreated(r.id);
    }
  };
  return (
    <Modal
      title="New AI delivery run"
      wide
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          <button type="button" className="btn primary" disabled={busy || goal.trim().length < 5 || (needsProject && !project)} onClick={go}>
            {busy ? 'Starting…' : template === 'ai' ? 'Plan it' : 'Show the plan'}
          </button>
        </>
      }
    >
      <div className="modal-body stack">
        <label className="field">
          <span>What should be built or documented?</span>
          <textarea rows={6} value={goal} onChange={(e) => setGoal(e.target.value)} placeholder="The business problem, who uses it, must-haves, constraints (budget, dates, integrations: Tally, GST portal, Razorpay, WhatsApp…)" autoFocus />
        </label>
        {!projectId && (
          <label className="field">
            <span>Project</span>
            <select value={project} onChange={(e) => setProject(e.target.value)}>
              <option value="">No project (documents and diagrams only)</option>
              {(projects.data ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="field">
          <span>Plan</span>
          <select value={template} onChange={(e) => setTemplate(e.target.value)}>
            <option value="ai">Let the AI plan it for this goal</option>
            {(cat.data?.templates ?? []).map((t) => (
              <option key={t.key} value={t.key}>
                {t.label}
              </option>
            ))}
          </select>
          {tpl && <small className="muted">{tpl.description} {tpl.steps.length} steps — you can change them before starting.</small>}
          {needsProject && !project && <small style={{ color: 'var(--bad)' }}>This plan creates backlog items, test cases and code: choose a project.</small>}
        </label>
        <div className="field">
          <span>When should the agents stop for you?</span>
          <div className="seg">
            {(
              [
                ['key', 'Key steps'],
                ['each', 'Every step'],
                ['none', 'Only before changing the project'],
              ] as const
            ).map(([k, l]) => (
              <button key={k} type="button" aria-pressed={mode === k} onClick={() => setMode(k)}>
                {l}
              </button>
            ))}
          </div>
          <small className="muted">Creating backlog items and test cases, and sending stories to the coding agent, always waits for your approval.</small>
        </div>
      </div>
    </Modal>
  );
}

function RunView({ id, onBack }: { id: string; onBack: () => void }) {
  const act = useAct();
  const { data, isLoading } = useQuery({
    queryKey: ['sdlc-run', id],
    queryFn: () => get<Json>(`/api/v1/sdlc/runs/${id}`),
    refetchInterval: (q) => (['planning', 'running'].includes(q.state.data?.run?.status) ? 3000 : false),
  });
  const [sel, setSel] = useState<string | null>(null);
  const [editPlan, setEditPlan] = useState(false);
  const steps: Json[] = data?.steps ?? [];
  // follow the work: the step waiting for review, else the running one, else the last done
  const auto = steps.find((s) => s.status === 'awaiting_review') ?? steps.find((s) => s.status === 'running' || s.status === 'failed') ?? [...steps].reverse().find((s) => s.status === 'approved') ?? steps[0];
  const current = steps.find((s) => s.id === sel) ?? auto;
  if (isLoading || !data) return <Spinner />;
  const run = data.run;
  const [label, tone] = RUN_STATUS[run.status] ?? [run.status, ''];
  const planning = run.status === 'awaiting_plan' || editPlan;
  return (
    <div className="stack">
      <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
        <div>
          <button type="button" className="link-btn small" onClick={onBack}>
            ← All runs
          </button>
          <h2 style={{ margin: '4px 0' }}>{run.title}</h2>
          <div className="row small" style={{ gap: 8, flexWrap: 'wrap' }}>
            <span className={`chip ${tone}`}>{label}</span>
            {run.project && <Link to={`/projects/${run.project_id}`}>{run.project}</Link>}
            <span className="muted">stops for you: {run.review_mode === 'each' ? 'every step' : run.review_mode === 'key' ? 'key steps' : 'before changing the project'}</span>
          </div>
        </div>
        {data.canAct && (
          <div className="row" style={{ gap: 6 }}>
            {run.status === 'failed' && (
              <button type="button" className="btn primary" onClick={() => act(() => post(`/api/v1/sdlc/runs/${id}/start`), 'Trying again')}>
                Try again
              </button>
            )}
            {['awaiting_review', 'done', 'failed'].includes(run.status) && !editPlan && (
              <button type="button" className="btn" onClick={() => setEditPlan(true)}>
                Add / change steps
              </button>
            )}
            {!['done', 'cancelled'].includes(run.status) && (
              <button type="button" className="btn ghost" onClick={() => confirm('Stop this run? Finished documents stay.') && act(() => post(`/api/v1/sdlc/runs/${id}/cancel`), 'Stopped')}>
                Stop
              </button>
            )}
            <button
              type="button"
              className="btn ghost"
              onClick={async () => {
                if (!confirm('Delete this run with its documents and diagrams? Backlog items and test cases it created stay.')) return;
                if (await act(() => del(`/api/v1/sdlc/runs/${id}`), 'Deleted')) onBack();
              }}
            >
              Delete
            </button>
          </div>
        )}
      </div>
      <details className="sd-goal">
        <summary>Goal</summary>
        <div className="pre-wrap small">{run.goal}</div>
      </details>
      {run.error && run.status === 'failed' && <div className="notice" style={{ borderColor: 'var(--bad)' }}>{run.error}</div>}
      {run.status === 'planning' && (
        <div className="panel panel-body row" style={{ gap: 10 }}>
          <Spinner /> The delivery lead is planning the steps…
        </div>
      )}
      {planning && data.canAct ? (
        <PlanEditor run={run} steps={steps} onDone={() => setEditPlan(false)} />
      ) : (
        steps.length > 0 && (
          <div className="sd-run">
            <ol className="sd-steps">
              {steps.map((s) => {
                const [sl, st] = STEP_STATUS[s.status] ?? [s.status, ''];
                return (
                  <li key={s.id} className={current?.id === s.id ? 'active' : ''}>
                    <button type="button" onClick={() => setSel(s.id)}>
                      <span className={`sd-dot ${s.status}`} aria-hidden />
                      <span className="sd-step-text">
                        <b>{s.title}</b>
                        <span className="small muted">
                          {agentLabel(s.agent)} · {KIND_LABEL[s.kind]}
                        </span>
                      </span>
                      <span className={`chip ${st}`}>{sl}</span>
                    </button>
                  </li>
                );
              })}
            </ol>
            <div className="sd-detail">{current && <StepDetail key={`${current.id}-${current.status}-${current.attempts}`} step={current} data={data} />}</div>
          </div>
        )
      )}
    </div>
  );
}

const AGENT_LABELS: Record<string, string> = { ba: 'Business analyst', po: 'Product owner', architect: 'Architect', ux: 'UX designer', security: 'Security', qa: 'QA', devops: 'DevOps', writer: 'Technical writer', pm: 'Project manager', developer: 'Developer' };
const agentLabel = (k: string) => AGENT_LABELS[k] ?? k;

function ReviewBar({ step, output, children }: { step: Json; output?: Json | null; children?: ReactNode }) {
  const act = useAct();
  const [note, setNote] = useState('');
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const send = async (verdict: 'approve' | 'changes' | 'skip') => {
    setBusy(true);
    await act(
      () => post(`/api/v1/sdlc/steps/${step.id}/review`, { verdict, note: note.trim() || null, output: output ?? null }),
      verdict === 'approve' ? (step.kind === 'backlog' ? 'Created in the project' : step.kind === 'code' ? 'Sent to the coding agent' : 'Approved — next step') : verdict === 'changes' ? 'Sent back to the agent' : 'Skipped',
    );
    setBusy(false);
  };
  return (
    <div className="sd-review">
      {children}
      {asking ? (
        <div className="stack">
          <textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder="What should change? e.g. “Add GST e-invoicing and a TDS section; drop the mobile app for phase 1”" autoFocus />
          <div className="row" style={{ gap: 6 }}>
            <button type="button" className="btn primary" disabled={busy || !note.trim()} onClick={() => send('changes')}>Send to the agent</button>
            <button type="button" className="btn ghost" onClick={() => setAsking(false)}>Cancel</button>
          </div>
        </div>
      ) : (
        <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
          <button type="button" className="btn primary" disabled={busy} onClick={() => send('approve')}>
            {step.kind === 'backlog' ? 'Approve & create in the project' : step.kind === 'test_cases' ? 'Approve & add the test cases' : step.kind === 'code' ? 'Approve & send to the coding agent' : 'Approve'}
          </button>
          {step.kind !== 'code' && (
            <button type="button" className="btn" disabled={busy} onClick={() => setAsking(true)}>
              Request changes
            </button>
          )}
          <button type="button" className="btn ghost" disabled={busy} onClick={() => send('skip')}>
            Skip
          </button>
        </div>
      )}
    </div>
  );
}

function StepDetail({ step, data }: { step: Json; data: Json }) {
  const act = useAct();
  const arts: Json[] = (data.artifacts as Json[]).filter((a) => a.step_id === step.id);
  const main = arts.find((a) => a.kind === (step.kind === 'diagram' ? 'diagram' : 'document')) ?? arts[0];
  const figures = arts.filter((a) => a !== main);
  const [fig, setFig] = useState<string | null>(null);
  const reviewing = step.status === 'awaiting_review' && data.canAct;
  const [output, setOutput] = useState<Json | null>(step.output && Object.keys(step.output).length ? step.output : null);
  return (
    <div className="stack">
      <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 6 }}>
        <div>
          <h3 style={{ margin: 0 }}>{step.title}</h3>
          <div className="small muted">
            {agentLabel(step.agent)} · {KIND_LABEL[step.kind]}
            {step.attempts > 1 ? ` · attempt ${step.attempts}` : ''}
            {step.reviewer ? ` · reviewed by ${step.reviewer}` : ''}
          </div>
        </div>
        {data.canAct && step.status === 'pending' && (
          <button type="button" className="btn sm ghost" onClick={() => act(() => post(`/api/v1/sdlc/steps/${step.id}/review`, { verdict: 'skip' }), 'Skipped')}>
            Skip this step
          </button>
        )}
        {data.canAct && step.status === 'approved' && ['document', 'diagram'].includes(step.kind) && <RedoButton step={step} />}
      </div>
      {step.instructions && <div className="small muted">Focus: {step.instructions}</div>}
      {step.feedback && step.status !== 'approved' && <div className="notice small">Your note: {step.feedback}</div>}
      {step.status === 'pending' && <div className="muted">Waiting for the steps before it.</div>}
      {step.status === 'running' && (
        <div className="row" style={{ gap: 10 }}>
          <Spinner /> {agentLabel(step.agent)} is working on it…
        </div>
      )}
      {step.status === 'failed' && <div className="notice" style={{ borderColor: 'var(--bad)' }}>{step.error}</div>}
      {reviewing && <ReviewBar step={step} output={output} />}
      {main && <ArtifactPanel id={main.id} />}
      {figures.length > 0 && (
        <div className="small">
          Figures:{' '}
          {figures.map((f, i) => (
            <button key={f.id} type="button" className="link-btn" onClick={() => setFig(f.id)}>
              {i ? ', ' : ''}
              {f.title}
            </button>
          ))}
        </div>
      )}
      {fig && <ArtifactModal id={fig} onClose={() => setFig(null)} />}
      {step.kind === 'backlog' && output && <BacklogView output={output} editable={reviewing} onChange={setOutput} />}
      {step.kind === 'test_cases' && output && <TestsView output={output} editable={reviewing} onChange={setOutput} />}
      {step.kind === 'code' && <CodeView step={step} projectId={data.run.project_id} />}
    </div>
  );
}

function RedoButton({ step }: { step: Json }) {
  const act = useAct();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  if (!open)
    return (
      <button type="button" className="btn sm" onClick={() => setOpen(true)}>
        Ask for changes
      </button>
    );
  return (
    <div className="row" style={{ gap: 6 }}>
      <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="What should change?" style={{ minWidth: 260 }} autoFocus />
      <button type="button" className="btn sm primary" disabled={!note.trim()} onClick={() => act(() => post(`/api/v1/sdlc/steps/${step.id}/review`, { verdict: 'changes', note }), 'The agent will redo it (and the steps after it)').then(() => setOpen(false))}>
        Redo
      </button>
    </div>
  );
}

function BacklogView({ output, editable, onChange }: { output: Json; editable: boolean; onChange: (o: Json) => void }) {
  const created: Json[] = output.created ?? [];
  if (created.length)
    return (
      <div className="stack">
        <b>Created in the project</b>
        <ul className="sd-list">
          {created.map((c) => (
            <li key={c.id}>
              <span className="chip">{c.type}</span> <b>{c.key}</b> {c.name}
            </li>
          ))}
        </ul>
      </div>
    );
  const set = (ei: number, si: number | null, patch: Json) => {
    const epics = (output.epics as Json[]).map((e, i) => (i !== ei ? e : si === null ? { ...e, ...patch } : { ...e, stories: e.stories.map((s: Json, j: number) => (j === si ? { ...s, ...patch } : s)) }));
    onChange({ ...output, epics });
  };
  return (
    <div className="stack">
      {editable && <p className="small muted" style={{ margin: 0 }}>Untick anything you don't want; names and points can be changed before creating.</p>}
      {(output.epics as Json[]).map((e, ei) => (
        <div key={ei} className={`sd-epic ${e.skip ? 'off' : ''}`}>
          <div className="row" style={{ gap: 8 }}>
            {editable && <input type="checkbox" checked={!e.skip} onChange={(ev) => set(ei, null, { skip: !ev.target.checked })} aria-label="Include epic" />}
            <span className="chip info">epic</span>
            {editable ? <input className="grow" value={e.name} onChange={(ev) => set(ei, null, { name: ev.target.value })} /> : <b>{e.name}</b>}
          </div>
          {e.description && <div className="small muted">{e.description}</div>}
          <ul className="sd-list">
            {(e.stories as Json[]).map((s, si) => (
              <li key={si} className={s.skip ? 'off' : ''}>
                <div className="row" style={{ gap: 8 }}>
                  {editable && <input type="checkbox" checked={!s.skip} onChange={(ev) => set(ei, si, { skip: !ev.target.checked })} aria-label="Include story" />}
                  <span className="chip">{s.type ?? 'story'}</span>
                  {editable ? <input className="grow" value={s.name} onChange={(ev) => set(ei, si, { name: ev.target.value })} /> : <b>{s.name}</b>}
                  {editable ? (
                    <input type="number" min={0} max={100} value={s.points ?? ''} onChange={(ev) => set(ei, si, { points: ev.target.value ? Number(ev.target.value) : null })} style={{ width: 64 }} title="Story points" />
                  ) : (
                    s.points != null && <span className="small muted">{s.points} pts</span>
                  )}
                </div>
                {s.acceptance?.length > 0 && (
                  <ul className="small muted">
                    {s.acceptance.map((a: string, k: number) => (
                      <li key={k}>{a}</li>
                    ))}
                  </ul>
                )}
                {s.tasks?.length > 0 && <div className="small muted">Tasks: {s.tasks.map((t: Json) => `${t.name}${t.hours ? ` (${t.hours} h)` : ''}`).join(' · ')}</div>}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

function TestsView({ output, editable, onChange }: { output: Json; editable: boolean; onChange: (o: Json) => void }) {
  const cases: Json[] = output.cases ?? [];
  const created: Json[] = output.created ?? [];
  return (
    <div className="stack">
      {created.length > 0 && <b>{created.length} test cases added to the project's test plans</b>}
      <table className="data">
        <thead>
          <tr>
            {editable && <th />}
            <th>Test case</th>
            <th>Steps</th>
            <th>Covers</th>
          </tr>
        </thead>
        <tbody>
          {cases.map((c, i) => (
            <tr key={i} className={c.skip ? 'off' : ''}>
              {editable && (
                <td>
                  <input type="checkbox" checked={!c.skip} onChange={(e) => onChange({ ...output, cases: cases.map((x, j) => (j === i ? { ...x, skip: !e.target.checked } : x)) })} aria-label="Include" />
                </td>
              )}
              <td>
                <b>{c.title}</b>
                <div className="small muted">
                  {c.suite ?? ''} {c.priority ? `· ${c.priority}` : ''}
                </div>
              </td>
              <td className="small">
                <ol style={{ margin: 0, paddingLeft: 18 }}>
                  {(c.steps as Json[]).map((s, k) => (
                    <li key={k}>
                      {s.action}
                      {s.expected ? <span className="muted"> → {s.expected}</span> : null}
                    </li>
                  ))}
                </ol>
              </td>
              <td className="small">{(c.covers ?? []).join(', ')}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CodeView({ step, projectId }: { step: Json; projectId: string | null }) {
  const out = step.output ?? {};
  const queued: Json[] = out.queued ?? [];
  const items: Json[] = out.items ?? [];
  return (
    <div className="stack">
      {queued.length ? (
        <>
          <b>Sent to the coding agent</b>
          <ul className="sd-list">
            {queued.map((q) => (
              <li key={q.id}>
                <b>{q.key}</b> {q.name}
              </li>
            ))}
          </ul>
          <p className="small muted">
            Claude Code or Codex picks them up over MCP, implements and tests each, then asks you to verify before committing — follow it in {projectId ? <Link to={`/projects/${projectId}?s_project=agent`}>Project → Coding agent</Link> : 'the project\'s Coding agent tab'}.
          </p>
        </>
      ) : items.length ? (
        <>
          <b>These will go to the coding agent</b>
          <ul className="sd-list">
            {items.map((q) => (
              <li key={q.id}>
                <b>{q.key}</b> {q.name}
              </li>
            ))}
          </ul>
        </>
      ) : (
        step.status !== 'pending' && <p className="muted">No stories yet: the backlog step creates them.</p>
      )}
    </div>
  );
}

/* ───────────────────────── plan ───────────────────────── */

function PlanEditor({ run, steps, onDone }: { run: Json; steps: Json[]; onDone: () => void }) {
  const cat = useCatalogue();
  const act = useAct();
  const locked = steps.filter((s) => s.status !== 'pending');
  const [rows, setRows] = useState<Json[]>(() =>
    steps.filter((s) => s.status === 'pending').map((s) => ({ agent: s.agent, kind: s.kind, title: s.title, docType: s.doc_type, diagramType: s.diagram_type, instructions: s.instructions ?? '', needsReview: s.needs_review })),
  );
  const [mode, setMode] = useState(run.review_mode as string);
  const [busy, setBusy] = useState(false);
  const set = (i: number, patch: Json) => setRows((r) => r.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const move = (i: number, d: number) =>
    setRows((r) => {
      const n = [...r];
      const [x] = n.splice(i, 1);
      n.splice(Math.max(0, Math.min(n.length, i + d)), 0, x!);
      return n;
    });
  const docLabel = useMemo(() => Object.fromEntries((cat.data?.docTypes ?? []).map((d) => [d.key, d.label])), [cat.data]);
  const save = async (start: boolean) => {
    setBusy(true);
    const ok = await act(async () => {
      await put(`/api/v1/sdlc/runs/${run.id}/plan`, { steps: rows.map((r) => ({ ...r, instructions: r.instructions || null })), reviewMode: mode });
      if (start) await post(`/api/v1/sdlc/runs/${run.id}/start`);
      return true;
    }, start ? 'Started' : 'Plan saved');
    setBusy(false);
    if (ok) onDone();
  };
  if (!cat.data) return <Spinner />;
  return (
    <div className="panel">
      <div className="panel-head">
        <b>{run.status === 'awaiting_plan' ? 'The plan — change anything, then start' : 'Steps still to do'}</b>
        <div className="seg">
          {(
            [
              ['key', 'Stop on key steps'],
              ['each', 'Every step'],
              ['none', 'Only before changes'],
            ] as const
          ).map(([k, l]) => (
            <button key={k} type="button" aria-pressed={mode === k} onClick={() => setMode(k)}>
              {l}
            </button>
          ))}
        </div>
      </div>
      <div className="panel-body stack">
        {locked.length > 0 && <div className="small muted">Done or in review: {locked.map((s) => s.title).join(' · ')}</div>}
        <table className="data sd-plan">
          <thead>
            <tr>
              <th>#</th>
              <th>Agent</th>
              <th>Makes</th>
              <th>Title & focus</th>
              <th title="Wait for a person after this step">Review</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                <td className="muted">{locked.length + i + 1}</td>
                <td>
                  <select value={r.agent} onChange={(e) => set(i, { agent: e.target.value })}>
                    {cat.data.agents.map((a) => (
                      <option key={a.key} value={a.key}>
                        {a.name}
                      </option>
                    ))}
                  </select>
                </td>
                <td>
                  <select value={r.kind} onChange={(e) => set(i, { kind: e.target.value })}>
                    {Object.entries(KIND_LABEL).map(([k, l]) => (
                      <option key={k} value={k} disabled={!run.project_id && ['backlog', 'test_cases', 'code'].includes(k)}>
                        {l}
                      </option>
                    ))}
                  </select>
                  {r.kind === 'document' && (
                    <select value={r.docType ?? 'custom'} onChange={(e) => set(i, { docType: e.target.value, title: r.title === (docLabel[r.docType] ?? '') ? docLabel[e.target.value] : r.title })}>
                      {cat.data.docTypes.map((d) => (
                        <option key={d.key} value={d.key}>
                          {d.label}
                        </option>
                      ))}
                    </select>
                  )}
                  {r.kind === 'diagram' && (
                    <select value={r.diagramType ?? 'architecture'} onChange={(e) => set(i, { diagramType: e.target.value })}>
                      {cat.data.diagramTypes.map((d) => (
                        <option key={d.key} value={d.key}>
                          {d.label}
                        </option>
                      ))}
                    </select>
                  )}
                </td>
                <td>
                  <input value={r.title} onChange={(e) => set(i, { title: e.target.value })} style={{ width: '100%' }} />
                  <input value={r.instructions ?? ''} onChange={(e) => set(i, { instructions: e.target.value })} placeholder="Focus (optional)" className="small" style={{ width: '100%', marginTop: 4 }} />
                </td>
                <td>
                  <input
                    type="checkbox"
                    checked={['backlog', 'test_cases', 'code'].includes(r.kind) || (mode === 'each' ? true : mode === 'none' ? false : !!r.needsReview)}
                    disabled={['backlog', 'test_cases', 'code'].includes(r.kind) || mode !== 'key'}
                    onChange={(e) => set(i, { needsReview: e.target.checked })}
                    aria-label="Review"
                  />
                </td>
                <td className="nowrap">
                  <button type="button" className="btn sm ghost" onClick={() => move(i, -1)} disabled={!i} aria-label="Up">↑</button>
                  <button type="button" className="btn sm ghost" onClick={() => move(i, 1)} disabled={i === rows.length - 1} aria-label="Down">↓</button>
                  <button type="button" className="btn sm ghost" onClick={() => setRows((x) => x.filter((_, j) => j !== i))} aria-label="Remove">✕</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 6 }}>
          <div className="row" style={{ gap: 6 }}>
            <button type="button" className="btn sm" onClick={() => setRows((x) => [...x, { agent: 'ba', kind: 'document', docType: 'custom', title: 'Document', instructions: '', needsReview: true }])}>
              + Document
            </button>
            <button type="button" className="btn sm" onClick={() => setRows((x) => [...x, { agent: 'architect', kind: 'diagram', diagramType: 'architecture', title: 'Diagram', instructions: '', needsReview: false }])}>
              + Diagram
            </button>
          </div>
          <div className="row" style={{ gap: 6 }}>
            {run.status !== 'awaiting_plan' && (
              <button type="button" className="btn ghost" onClick={onDone}>
                Cancel
              </button>
            )}
            <button type="button" className="btn" disabled={busy || !rows.length} onClick={() => save(false)}>
              Save plan
            </button>
            <button type="button" className="btn primary" disabled={busy || !rows.length} onClick={() => save(true)}>
              {run.status === 'awaiting_plan' ? 'Start' : 'Save & continue'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ───────────────────────── library ───────────────────────── */

function Library({ projectId, onOpenRun }: { projectId?: string; onOpenRun: (id: string) => void }) {
  const [kind, setKind] = useState('');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [write, setWrite] = useState(false);
  const { data, isLoading } = useQuery({
    queryKey: ['sdlc-artifacts', projectId ?? null, kind, q],
    queryFn: () => get<{ items: Json[] }>(`/api/v1/sdlc/artifacts?${new URLSearchParams({ ...(projectId ? { projectId } : {}), ...(kind ? { kind } : {}), ...(q ? { q } : {}) })}`),
  });
  return (
    <div className="stack">
      <div className="row" style={{ gap: 8, flexWrap: 'wrap', justifyContent: 'space-between' }}>
        <div className="row" style={{ gap: 8 }}>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search titles" />
          <select value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="">Documents and diagrams</option>
            <option value="document">Documents</option>
            <option value="diagram">Diagrams</option>
          </select>
        </div>
        <button type="button" className="btn primary" onClick={() => setWrite(true)}>
          Write a document
        </button>
      </div>
      {isLoading ? (
        <Spinner />
      ) : !data?.items.length ? (
        <Empty title="Nothing here yet">Documents and diagrams from runs, the diagram studio and coding agents appear here.</Empty>
      ) : (
        <table className="data">
          <thead>
            <tr>
              <th>Title</th>
              <th>Kind</th>
              {!projectId && <th>Project</th>}
              <th>From</th>
              <th>Updated</th>
            </tr>
          </thead>
          <tbody>
            {data.items.map((a) => (
              <tr key={a.id} className="clickable" onClick={() => setOpen(a.id)}>
                <td>
                  <b>{a.title}</b> {a.status === 'approved' && <span className="chip good">approved</span>}
                </td>
                <td className="small">{a.kind === 'diagram' ? `Diagram · ${a.subtype.replace(/_/g, ' ')}` : `Document · ${a.subtype.replace(/_/g, ' ')}`}</td>
                {!projectId && <td className="small">{a.project ?? '—'}</td>}
                <td className="small">
                  {a.run_id ? (
                    <button
                      type="button"
                      className="link-btn"
                      onClick={(e) => {
                        e.stopPropagation();
                        onOpenRun(a.run_id);
                      }}
                    >
                      {a.run}
                    </button>
                  ) : (
                    <span className="muted">by hand / studio</span>
                  )}
                </td>
                <td className="small muted">
                  v{a.version} · {relative(a.updated_at)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {open && <ArtifactModal id={open} onClose={() => setOpen(null)} />}
      {write && <WriteDoc projectId={projectId} onClose={() => setWrite(false)} onRun={onOpenRun} onOpen={setOpen} />}
    </div>
  );
}

function WriteDoc({ projectId, onClose, onRun, onOpen }: { projectId?: string; onClose: () => void; onRun: (id: string) => void; onOpen: (id: string) => void }) {
  const cat = useCatalogue();
  const projects = useProjects();
  const act = useAct();
  const [docType, setDocType] = useState('brd');
  const [prompt, setPrompt] = useState('');
  const [title, setTitle] = useState('');
  const [project, setProject] = useState(projectId ?? '');
  const [blank, setBlank] = useState(false);
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    if (blank) {
      const r = await act(() => post<{ id: string }>('/api/v1/sdlc/artifacts', { kind: 'document', title: title || 'Untitled', subtype: docType, projectId: project || null }));
      setBusy(false);
      if (r) {
        onClose();
        onOpen(r.id);
      }
      return;
    }
    const r = await act(() => post<{ runId: string }>('/api/v1/sdlc/documents/generate', { prompt, docType, title: title || null, projectId: project || null }), 'The agent is writing it');
    setBusy(false);
    if (r) {
      onClose();
      onRun(r.runId);
    }
  };
  return (
    <Modal
      title="Write a document"
      wide
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          <button type="button" className="btn primary" disabled={busy || (!blank && prompt.trim().length < 5)} onClick={go}>
            {blank ? 'Create' : 'Write it'}
          </button>
        </>
      }
    >
      <div className="modal-body stack">
        <div className="seg">
          <button type="button" aria-pressed={!blank} onClick={() => setBlank(false)}>The AI writes it</button>
          <button type="button" aria-pressed={blank} onClick={() => setBlank(true)}>Blank, I'll write it</button>
        </div>
        <div className="grid-2">
          <label className="field">
            <span>Kind</span>
            <select value={docType} onChange={(e) => setDocType(e.target.value)}>
              {(cat.data?.docTypes ?? []).map((d) => (
                <option key={d.key} value={d.key}>
                  {d.label}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Title (optional)</span>
            <input value={title} onChange={(e) => setTitle(e.target.value)} />
          </label>
        </div>
        {!projectId && (
          <label className="field">
            <span>Project</span>
            <select value={project} onChange={(e) => setProject(e.target.value)}>
              <option value="">None</option>
              {(projects.data ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
        )}
        {!blank && (
          <label className="field">
            <span>What is it about?</span>
            <textarea rows={6} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="The system, the audience, what must be covered. The agent adds the diagrams the document needs." />
          </label>
        )}
      </div>
    </Modal>
  );
}

/* ───────────────────────── studio ───────────────────────── */

function Studio({ projectId }: { projectId?: string }) {
  const cat = useCatalogue();
  const projects = useProjects();
  const toast = useToast();
  const qc = useQueryClient();
  const [mode, setMode] = useState<'ai' | 'mermaid'>('ai');
  const [prompt, setPrompt] = useState('');
  const [type, setType] = useState('auto');
  const [project, setProject] = useState(projectId ?? '');
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [made, setMade] = useState<string | null>(null);
  const [preview, setPreview] = useState<Json | null>(null);
  useEffect(() => setMade(null), [mode]);
  const go = async () => {
    setBusy(true);
    try {
      if (mode === 'ai') {
        const r = await post<Json>('/api/v1/sdlc/diagrams/generate', { prompt, type, projectId: project || null, title: title || null });
        setMade(r.id);
        setPreview(null);
      } else {
        const r = await post<{ id: string }>('/api/v1/sdlc/artifacts', { kind: 'diagram', title: title || 'Diagram', mermaid: prompt, projectId: project || null });
        setMade(r.id);
      }
      qc.invalidateQueries({ queryKey: ['sdlc-artifacts'] });
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  };
  const examples = [
    'Architecture of a GST e-invoicing integration: our ERP, the IRP via a GSP, Tally sync, retries, and where the IRN and QR are stored',
    'ER diagram for a school fee system: students, guardians, classes, fee plans, instalments, receipts, concessions',
    'Sequence of UPI payment collection with Razorpay: checkout, webhook, verifying the signature, marking the invoice paid',
    'User journey of a dealer placing a reorder on WhatsApp',
    'Deployment on Cloudflare Workers with Neon Postgres, R2, Queues and a GitHub Actions pipeline',
  ];
  return (
    <div className="sd-studio">
      <div className="stack">
        <div className="seg">
          <button type="button" aria-pressed={mode === 'ai'} onClick={() => setMode('ai')}>Describe it</button>
          <button type="button" aria-pressed={mode === 'mermaid'} onClick={() => setMode('mermaid')}>Paste Mermaid</button>
        </div>
        <label className="field">
          <span>{mode === 'ai' ? 'What should the diagram show?' : 'Mermaid source'}</span>
          <textarea rows={mode === 'ai' ? 7 : 14} value={prompt} onChange={(e) => setPrompt(e.target.value)} className={mode === 'mermaid' ? 'dg-code' : ''} spellCheck={mode === 'ai'} />
        </label>
        {mode === 'ai' && !prompt && (
          <div className="small muted">
            Try:{' '}
            {examples.map((e, i) => (
              <button key={i} type="button" className="link-btn" style={{ display: 'block', textAlign: 'left' }} onClick={() => setPrompt(e)}>
                {e}
              </button>
            ))}
          </div>
        )}
        <div className="grid-2">
          {mode === 'ai' && (
            <label className="field">
              <span>Kind</span>
              <select value={type} onChange={(e) => setType(e.target.value)}>
                <option value="auto">Pick for me</option>
                {(cat.data?.diagramTypes ?? []).map((d) => (
                  <option key={d.key} value={d.key}>
                    {d.label}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="field">
            <span>Title (optional)</span>
            <input value={title} onChange={(e) => setTitle(e.target.value)} />
          </label>
          {!projectId && (
            <label className="field">
              <span>Project</span>
              <select value={project} onChange={(e) => setProject(e.target.value)}>
                <option value="">None</option>
                {(projects.data ?? []).map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
        <div className="row" style={{ gap: 6 }}>
          <button type="button" className="btn primary" disabled={busy || prompt.trim().length < 3} onClick={go}>
            {busy ? 'Drawing…' : mode === 'ai' ? 'Draw it' : 'Save'}
          </button>
          {busy && <span className="small muted">The architect agent is drawing — usually 10–30 seconds.</span>}
        </div>
      </div>
      <div className="sd-studio-out">
        {made ? <ArtifactPanel id={made} /> : preview ? <DiagramView artifact={preview} canEdit={false} /> : <Empty title="Your diagram appears here">Download it as PNG, JPG, SVG, Mermaid or draw.io — or open it in draw.io to keep editing.</Empty>}
      </div>
    </div>
  );
}

/* ───────────────────────── agents ───────────────────────── */

function AgentsInfo() {
  const cat = useCatalogue();
  if (!cat.data) return <Spinner />;
  return (
    <div className="stack">
      <Guide id="ai_delivery" label="How AI delivery works" />
      <div className="sd-agents">
        {cat.data.agents.map((a) => (
          <div key={a.key} className="sd-agent">
            <b>{a.name}</b>
            <span className="small muted">{a.does}</span>
            <span className="small">{cat.data.docTypes.filter((d) => d.agent === a.key).map((d) => d.label).join(' · ')}</span>
          </div>
        ))}
      </div>
      <div className="grid-2">
        <div>
          <h4>Diagrams</h4>
          <p className="small muted">Editable shapes in draw.io: {cat.data.diagramTypes.filter((d) => d.editable).map((d) => d.label).join(', ')}.</p>
          <p className="small muted">As pictures (Mermaid): {cat.data.diagramTypes.filter((d) => !d.editable).map((d) => d.label).join(', ')}.</p>
          <p className="small muted">Every diagram downloads as PNG, JPG, SVG, Mermaid (.mmd) and draw.io (.drawio), and opens in diagrams.net.</p>
        </div>
        <div>
          <h4>Ready-made plans</h4>
          <ul className="small">
            {cat.data.templates.map((t) => (
              <li key={t.key}>
                <b>{t.label}</b> — {t.steps.length} steps
              </li>
            ))}
          </ul>
          <h4>For coding agents</h4>
          <p className="small muted">
            Claude Code and Codex connected over MCP (Project → Coding agent) read these documents (<code>project_documents</code>, <code>read_document</code>) before implementing, and can draw and save diagrams too (<code>render_diagram</code>, <code>save_diagram</code>, <code>save_document</code>).
          </p>
        </div>
      </div>
    </div>
  );
}
