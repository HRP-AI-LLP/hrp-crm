/**
 * New from an idea: describe it, add rules and any documents or pictures, and HRP AI sets up the
 * product — an in-house project, the full set of documents and diagrams, the backlog, test cases,
 * plans, the build by the coding agent, and the user manual.
 */
import { useQuery } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { get, post, put, upload } from '../../lib/api';
import { Modal, Spinner, useToast } from '../ui';

type Json = Record<string, any>;
const MAX = 25 * 1024 * 1024;

const KINDS: [string, string][] = [
  ['web_app', 'Web application'],
  ['saas', 'SaaS product'],
  ['mobile_app', 'Mobile app'],
  ['mobile_game', 'Mobile game'],
  ['desktop_app', 'Desktop app'],
  ['website', 'Website'],
  ['api_service', 'API / backend'],
  ['data_ai', 'Data / AI'],
  ['iot_embedded', 'IoT / embedded'],
  ['other', 'Other'],
];
const PLATFORMS: [string, string][] = [
  ['web', 'Web'],
  ['android', 'Android'],
  ['ios', 'iPhone / iPad'],
  ['windows', 'Windows'],
  ['macos', 'Mac'],
  ['linux', 'Linux'],
  ['api', 'API only'],
];
const DEFAULT_PLATFORMS: Record<string, string[]> = { mobile_app: ['android', 'ios'], mobile_game: ['android', 'ios'], desktop_app: ['windows'], api_service: ['api'] };
const RULE_HINTS = [
  'Hindi and English in the app',
  'All data stays in India (DPDP Act)',
  'GST invoices and INR everywhere',
  'Works offline on low-end Android phones',
  'At least 80% automated test coverage',
  'Open-source libraries only (MIT / Apache)',
];

export function IdeaStudio({ onClose }: { onClose: () => void }) {
  const nav = useNavigate();
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [f, setF] = useState({ idea: '', name: '', productType: 'web_app', audience: '', stack: '', rules: '', reviewMode: 'key', build: true, workMode: 'batch' });
  const [platforms, setPlatforms] = useState<string[]>(['web']);
  const [files, setFiles] = useState<{ id: string; name: string }[]>([]);
  const [busy, setBusy] = useState<'' | 'upload' | 'start'>('');
  const set = (k: keyof typeof f, v: unknown) => setF((x) => ({ ...x, [k]: v }));

  const add = async (list: FileList | null) => {
    if (!list?.length) return;
    setBusy('upload');
    try {
      for (const file of Array.from(list)) {
        if (file.size > MAX) {
          toast(`${file.name} is over 25 MB`, true);
          continue;
        }
        const r = await upload<{ id: string; name: string }>(`/api/v1/sdlc/studio/files?name=${encodeURIComponent(file.name)}`, file);
        setFiles((x) => [...x, { id: r.id, name: r.name }]);
      }
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy('');
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const start = async () => {
    setBusy('start');
    try {
      const r = await post<{ projectId: string; name: string }>('/api/v1/sdlc/studio/start', {
        idea: f.idea.trim(),
        name: f.name.trim() || null,
        productType: f.productType,
        platforms,
        audience: f.audience.trim() || null,
        stack: f.stack.trim() || null,
        rules: f.rules.trim() || null,
        fileIds: files.map((x) => x.id),
        reviewMode: f.reviewMode,
        build: f.build,
        workMode: f.workMode,
      });
      toast(`${r.name} is set up — the AI team has started`);
      onClose();
      nav(`/projects/${r.projectId}`);
    } catch (e) {
      toast((e as Error).message, true);
      setBusy('');
    }
  };

  return (
    <Modal
      title="New product from an idea"
      wide
      onClose={onClose}
      footer={
        <button className="btn primary" disabled={f.idea.trim().length < 20 || !!busy} onClick={start}>
          {busy === 'start' ? 'Setting up…' : 'Create and start'}
        </button>
      }
    >
      <div className="modal-body stack">
        <p className="muted" style={{ margin: 0 }}>
          HRP AI turns the idea into a product: requirements (PRD, SRS), UX, architecture and diagrams, API and data design, security, coding standards, the backlog with every field filled,
          test cases, project and release plans, a runbook — then the coding agent builds it and the user manual is written. You review the key documents and the backlog on the way.
        </p>
        <label className="field">
          <span>The idea</span>
          <textarea rows={6} value={f.idea} onChange={(e) => set('idea', e.target.value)} placeholder="e.g. An app for small clinics: patients book a slot with a doctor, pay the fee by UPI and get WhatsApp reminders; the doctor sees the day's list and writes prescriptions." />
          <small className="muted" style={{ fontWeight: 400 }}>A few sentences is enough. Say who uses it and the main things they do.</small>
        </label>
        <div className="grid2">
          <label className="field">
            <span>Name (optional)</span>
            <input value={f.name} onChange={(e) => set('name', e.target.value)} placeholder="e.g. ClinicSlot" />
          </label>
          <label className="field">
            <span>What is being built</span>
            <select
              value={f.productType}
              onChange={(e) => {
                set('productType', e.target.value);
                setPlatforms(DEFAULT_PLATFORMS[e.target.value] ?? ['web']);
              }}
            >
              {KINDS.map(([k, l]) => (
                <option key={k} value={k}>
                  {l}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="field">
          <span>Runs on</span>
          <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
            {PLATFORMS.map(([k, l]) => {
              const on = platforms.includes(k);
              return (
                <button key={k} type="button" className={`btn sm${on ? ' primary' : ''}`} aria-pressed={on} onClick={() => setPlatforms((x) => (on ? x.filter((p) => p !== k) : [...x, k]))}>
                  {l}
                </button>
              );
            })}
          </div>
        </div>
        <div className="grid2">
          <label className="field">
            <span>Who it is for (optional)</span>
            <input value={f.audience} onChange={(e) => set('audience', e.target.value)} placeholder="e.g. clinics in tier-2 cities and their patients" />
          </label>
          <label className="field">
            <span>Preferred technology (optional)</span>
            <input value={f.stack} onChange={(e) => set('stack', e.target.value)} placeholder="Leave empty and the architect chooses, e.g. React + Node + PostgreSQL" />
          </label>
        </div>
        <label className="field">
          <span>Rules the AI must follow (optional)</span>
          <textarea rows={4} value={f.rules} onChange={(e) => set('rules', e.target.value)} placeholder="One per line: standards, must-haves, things to avoid, constraints." />
          <div className="row" style={{ flexWrap: 'wrap', gap: 6, marginTop: 4 }}>
            {RULE_HINTS.map((h) => (
              <button key={h} type="button" className="btn sm ghost" onClick={() => set('rules', f.rules.includes(h) ? f.rules : `${f.rules.trim() ? `${f.rules.trim()}\n` : ''}- ${h}`)}>
                + {h}
              </button>
            ))}
          </div>
        </label>
        <div className="field">
          <span>Documents and pictures (optional)</span>
          <small className="muted" style={{ fontWeight: 400 }}>A BRD, notes, sketches, screenshots of a similar app, sample data or formats, voice notes — the AI reads each one.</small>
          <div className="row" style={{ flexWrap: 'wrap', gap: 6, marginTop: 4 }}>
            {files.map((x) => (
              <span key={x.id} className="chip" style={{ fontWeight: 500 }}>
                📎 {x.name}
                <button type="button" className="btn ghost sm" style={{ height: 18, padding: "0 4px" }} aria-label={`Remove ${x.name}`} onClick={() => setFiles((l) => l.filter((y) => y.id !== x.id))}>
                  ✕
                </button>
              </span>
            ))}
            <button type="button" className="btn sm" disabled={busy === 'upload'} onClick={() => fileRef.current?.click()}>
              {busy === 'upload' ? 'Uploading…' : 'Add files'}
            </button>
            <input ref={fileRef} type="file" multiple hidden onChange={(e) => add(e.target.files)} />
          </div>
        </div>
        <div className="grid2">
          <label className="field">
            <span>You review</span>
            <select value={f.reviewMode} onChange={(e) => set('reviewMode', e.target.value)}>
              <option value="key">The key documents and the backlog (recommended)</option>
              <option value="each">Every step</option>
              <option value="none">Only the backlog and the build</option>
            </select>
          </label>
          <label className="field">
            <span>Building</span>
            <select value={f.build ? f.workMode : 'off'} onChange={(e) => (e.target.value === 'off' ? set('build', false) : setF((x) => ({ ...x, build: true, workMode: e.target.value })))}>
              <option value="batch">HRP AI builds everything in one go, then you review</option>
              <option value="one">HRP AI builds one item at a time, reviewed each time</option>
              <option value="off">Documents and backlog only — no build</option>
            </select>
          </label>
        </div>
        {f.build && (
          <small className="muted" style={{ fontWeight: 400 }}>
            The build runs in your coding tool (Claude Code) connected to this workspace — after creating, open the project → Coding agent → How to start.
          </small>
        )}
      </div>
    </Modal>
  );
}

/** A project's rules for the AI: every agent and the coding agent follow them. Also shows where an idea-started product stands. */
export function ProjectRules({ id }: { id: string }) {
  const toast = useToast();
  const { data, refetch } = useQuery({ queryKey: ['ai-rules', id], queryFn: () => get<{ rules: string | null; canEdit: boolean }>(`/api/v1/projects/${id}/ai-rules`) });
  const studio = useQuery({ queryKey: ['studio', id], queryFn: () => get<Json>(`/api/v1/sdlc/studio/${id}`), refetchInterval: 15000 });
  const [text, setText] = useState<string | null>(null);
  if (!data) return <Spinner />;
  const value = text ?? data.rules ?? '';
  const brief = studio.data?.project?.product_brief as Json | null;
  const run = studio.data?.run as Json | null;
  const steps = (run?.steps as Json[] | undefined) ?? [];
  const done = steps.filter((s) => s.status === 'approved' || s.status === 'skipped').length;
  const waiting = steps.find((s) => s.status === 'awaiting_review');
  const build = (studio.data?.build ?? {}) as Record<string, number>;
  return (
    <div className="stack">
      {brief && (
        <section className="callout info stack">
          <strong>Started from an idea</strong>
          <p style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{String(brief.idea ?? '').slice(0, 1200)}</p>
          {run && (
            <div className="muted">
              AI delivery: {done} of {steps.length} steps done · {run.run.status === 'running' ? 'working' : run.run.status === 'awaiting_plan' ? 'ready to start (AI delivery → Start)' : String(run.run.status).replace(/_/g, ' ')}
              {waiting ? ` · waiting for your review: ${waiting.title}` : ''}
              {Object.keys(build).length ? ` · build: ${Object.entries(build).map(([k, n]) => `${n} ${k.replace(/_/g, ' ')}`).join(', ')}` : ''}
            </div>
          )}
          <small className="muted" style={{ fontWeight: 400 }}>Open AI delivery to review each document; Coding agent to follow the build.</small>
        </section>
      )}
      <label className="field">
        <span>Rules for the AI on this project</span>
        <small className="muted" style={{ fontWeight: 400 }}>The AI delivery agents and the coding agent follow every rule: standards, must-haves, things to avoid, constraints. One per line.</small>
        <textarea rows={12} value={value} disabled={!data.canEdit} onChange={(e) => setText(e.target.value)} placeholder={'- Hindi and English in the app\n- All data stays in India\n- At least 80% test coverage'} />
      </label>
      {data.canEdit && (
        <div>
          <button
            className="btn primary"
            disabled={text === null || text === (data.rules ?? '')}
            onClick={async () => {
              try {
                await put(`/api/v1/projects/${id}/ai-rules`, { rules: value.trim() || null });
                setText(null);
                refetch();
                toast('Rules saved');
              } catch (e) {
                toast((e as Error).message, true);
              }
            }}
          >
            Save rules
          </button>
        </div>
      )}
    </div>
  );
}
