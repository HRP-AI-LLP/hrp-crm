/**
 * Project → Coding agent: Claude Code or Codex on a developer's machine works this project's stories,
 * tasks and bugs over MCP. New and changed items queue for it; it implements and tests them, then
 * waits here for a person to verify — Approve (commit & push), Request changes, or Stop.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { del, get, post, put } from '../../lib/api';
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

/**
 * One repository, one project: a key that works only for this project's coding agent, and the command
 * that ties the repository folder on the developer's machine to it.
 */
function RepoKeys({ projectId }: { projectId: string }) {
  const toast = useToast();
  const { data, refetch } = useQuery({ queryKey: ['agent', projectId, 'keys'], queryFn: () => get<{ items: Json[] }>(`/api/v1/projects/${projectId}/agent/keys`) });
  const [made, setMade] = useState<Json | null>(null);
  const [busy, setBusy] = useState(false);
  const url = `${window.location.origin}/api/v1/mcp`;
  const pin = made ? (made.project.key ?? made.project.id) : '';
  const cmd = made ? `claude mcp add --scope local --transport http sanchalan ${url} --header "Authorization: Bearer ${made.key}" --header "X-Sanchalan-Project: ${pin}"` : '';
  const json = made
    ? JSON.stringify({ mcpServers: { sanchalan: { type: 'http', url, headers: { Authorization: 'Bearer ${SANCHALAN_API_KEY}', 'X-Sanchalan-Project': pin } } } }, null, 2)
    : '';
  const desktop = made ? desktopConfig(url, `Bearer ${made.key}`, pin) : '';
  const copy = (t: string) => navigator.clipboard?.writeText(t).then(() => toast('Copied'), () => undefined);
  const live = (data?.items ?? []).filter((k) => !k.revoked_at);
  return (
    <section className="panel stack" style={{ padding: 12 }}>
      <div className="row" style={{ justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
        <div>
          <b>Link a repository on your computer to this project</b>
          <div className="small muted">
            One repository, one project: Claude Code in that folder sees, picks up, reads and changes this project's items only — never another project's — even if you can open others.
          </div>
        </div>
        <button
          className="btn primary"
          disabled={busy}
          onClick={async () => {
            const name = window.prompt('Name the key (e.g. the computer or the repository)', 'Claude Code');
            if (!name?.trim()) return;
            setBusy(true);
            try {
              setMade(await post<Json>(`/api/v1/projects/${projectId}/agent/keys`, { name: name.trim() }));
              refetch();
            } catch (e) {
              toast((e as Error).message, true);
            } finally {
              setBusy(false);
            }
          }}
        >
          Make a key for the repository
        </button>
      </div>
      {made && (
        <div className="stack" style={{ gap: 8 }}>
          <div className="notice small">The key is shown only now. It works only for this project's coding agent.</div>
          <div className="small">
            <b>1. In a terminal, inside the repository folder</b> (the setting is kept for that folder only):
          </div>
          <pre className="code-block" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all', margin: 0 }}>{cmd}</pre>
          <div className="row" style={{ gap: 6 }}>
            <button className="btn sm" onClick={() => copy(cmd)}>
              Copy the command
            </button>
          </div>
          <div className="small">
            <b>Or, for everyone on the team:</b> commit this as <code>.mcp.json</code> in the repository's root; each developer sets their own key in the <code>SANCHALAN_API_KEY</code> environment variable (<code>setx SANCHALAN_API_KEY "syn_…"</code> on Windows, then restart Claude):
          </div>
          <pre className="code-block" style={{ margin: 0 }}>{json}</pre>
          <div className="row" style={{ gap: 6 }}>
            <button className="btn sm" onClick={() => copy(json)}>
              Copy .mcp.json
            </button>
          </div>
          <div className="small">
            <b>Or, for the Claude desktop app</b> (its sessions use their own settings, not Claude Code’s): Settings → Developer → <b>Edit Config</b>, put this at the <b>top level</b> of <code>claude_desktop_config.json</code> (next to <code>"preferences"</code>, not inside it), save, then <b>Quit</b> Claude from the tray icon and open it again:
          </div>
          <pre className="code-block" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all', margin: 0 }}>{desktop}</pre>
          <div className="row" style={{ gap: 6 }}>
            <button className="btn sm" onClick={() => copy(desktop)}>
              Copy for the desktop app
            </button>
          </div>
          <div className="notice small">Keep the key to yourself: do not paste it into chats, mails or tickets. If it was shared, revoke it below and make a new one.</div>
        </div>
      )}
      <HowToStart />
      {live.length > 0 && (
        <table className="data small">
          <thead>
            <tr>
              <th>Key</th>
              <th>Made by</th>
              <th>Last used</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {live.map((k) => (
              <tr key={k.id}>
                <td>
                  {k.name} <span className="muted">{k.prefix}</span>
                </td>
                <td>{k.user_name}</td>
                <td>{k.last_used_at ? relative(k.last_used_at) : 'never'}</td>
                <td style={{ textAlign: 'right' }}>
                  <button
                    className="link-btn small"
                    onClick={async () => {
                      if (!confirm(`Revoke “${k.name}”? Claude Code using it stops working on this project.`)) return;
                      try {
                        await del(`/api/v1/projects/${projectId}/agent/keys/${k.id}`);
                        refetch();
                      } catch (e) {
                        toast((e as Error).message, true);
                      }
                    }}
                  >
                    Revoke
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

/** The "sanchalan" entry of claude_desktop_config.json: the desktop app reaches the server through mcp-remote. */
function desktopConfig(url: string, auth: string, pin: string) {
  return JSON.stringify(
    {
      mcpServers: {
        sanchalan: {
          command: 'npx',
          args: ['-y', 'mcp-remote', url, '--header', 'Authorization:${SANCHALAN_AUTH}', '--header', `X-Sanchalan-Project:${pin}`],
          env: { SANCHALAN_AUTH: auth },
        },
      },
    },
    null,
    2,
  );
}

const ASK_WORK = 'Queue the open bugs and tasks on the SanchalanOS board and fix them one by one. For each, request a review and wait for my approval before committing.';
const ASK_BUILD = 'Look at this repository and tell me, in a few lines, how to build it, run it and run its tests on Windows.';

/** After the key: where to talk to Claude Code, and what to say. */
function HowToStart() {
  const toast = useToast();
  const copy = (t: string) => navigator.clipboard?.writeText(t).then(() => toast('Copied'), () => undefined);
  const Ask = ({ text }: { text: string }) => (
    <div className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
      <div className="code-block" style={{ flex: 1, whiteSpace: 'pre-wrap', margin: 0 }}>
        {text}
      </div>
      <button className="btn sm" onClick={() => copy(text)}>
        Copy
      </button>
    </div>
  );
  return (
    <details className="small">
      <summary style={{ cursor: 'pointer' }}>
        <b>How to start working with Claude Code</b>
      </summary>
      <ol style={{ margin: '8px 0 0', paddingLeft: 18, display: 'grid', gap: 8 }}>
        <li>
          <b>Choose where Claude works</b> — the two keep separate settings:
          <ul style={{ margin: '4px 0 0', paddingLeft: 18, display: 'grid', gap: 4 }}>
            <li>
              <b>Claude Code in a terminal</b> (simplest): run the <code>claude mcp add …</code> command shown when you make the key, inside the repository folder. Then, each time: go to that folder (<code>cd</code>) and type <code>claude</code>. The
              connection is kept for that folder only.
            </li>
            <li>
              <b>The Claude desktop app</b> (its chats and Cowork sessions linked to your computer): they do <i>not</i> read the <code>claude mcp add</code> setting. Add SanchalanOS to the app instead — Settings → Developer → <b>Edit Config</b> opens{' '}
              <code>claude_desktop_config.json</code>; paste the block shown when you make the key (“Copy for the desktop app”) at the <b>top level</b> of the file, next to <code>"preferences"</code> and not inside it; keep <code>Bearer </code> and the
              whole key on one line; save; <b>Quit</b> Claude from the tray icon (closing the window is not enough) and open it again. It needs Node.js (for <code>npx</code>); the first start takes about 20 seconds.
            </li>
          </ul>
        </li>
        <li>
          <b>Start a new session</b> in that folder (a session gets its tools when it starts: one opened before the setup never sees them). Check it is connected (optional): in Claude Code type <code>/mcp</code> — “sanchalan” should be connected; in the desktop
          app, Settings → Developer lists “sanchalan” as running. <code>/mcp</code> only shows the connection; the work is asked for in plain words, next. The key’s <b>Last used</b> below changes from “never” once it connects.
        </li>
        <li>
          <b>Ask in the chat, as a normal message:</b>
          <Ask text={ASK_WORK} />
          The first time it uses a SanchalanOS tool, Claude Code asks for permission: allow it.
        </li>
        <li>
          <b>Review each fix here</b>, under Jobs below (or on the item): Approve — it commits and pushes — or Request changes with a note; Claude carries on from there.
        </li>
        <li>
          <b>Build and test commands (optional).</b> The instructions box above can stay empty: Claude works out how to build and test from the repository. To save it the trouble each time, ask it once and paste its answer into the instructions box:
          <Ask text={ASK_BUILD} />
        </li>
        <li>
          <b>If it does not connect</b>
          <ul style={{ margin: '4px 0 0', paddingLeft: 18, display: 'grid', gap: 4 }}>
            <li>“None exist” / no SanchalanOS tools: the session was opened before the setup — start a new one. In the desktop app, check Settings → Developer shows “sanchalan”; if it is not listed, the block is not at the top level of the file (or the file has a JSON mistake), or the app was not fully quit.</li>
            <li>
              “Invalid or revoked API key”, or in the desktop log “Dynamic Client Registration rejected (HTTP 405)”: the key was refused — revoked, still the placeholder, or mistyped. Make a new key here and paste it whole, after <code>Bearer </code>.
            </li>
            <li>“This repository is linked to the project … only”: the key or X-Sanchalan-Project names another project — use this project’s key.</li>
            <li>Nothing gets queued: the board has no open bugs, tasks or stories of the item types ticked above — add them to the board (or ask Claude to file them with create_work_item), then ask again.</li>
            <li>The desktop app’s log for it: Settings → Developer → sanchalan → Open logs.</li>
          </ul>
        </li>
      </ol>
    </details>
  );
}

function Connect({ open }: { open: boolean }) {
  return (
    <div className="stack" style={{ gap: 6 }}>
      <b>Connect Claude Code or Codex</b>
      <Guide id="coding_agent_claude" open={open} />
      <Guide id="coding_agent_desktop" />
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
          Instructions for the agent (optional: stack, build and test commands, conventions — left empty, Claude works them out from the repository)
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
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <button
          className="btn"
          disabled={busy}
          title={`Every open ${cfg.workTypes.join(', ')} on the board (not done or cancelled) that the agent does not have yet. Bugs first.`}
          onClick={async () => {
            if (!confirm(`Send every open ${cfg.workTypes.join(' / ')} on this project's board to the coding agent?`)) return;
            setBusy(true);
            try {
              const r = await post<Json>(`/api/v1/projects/${id}/agent/queue-open`, { workTypes: cfg.workTypes });
              toast(r.queued ? `${r.queued} item${r.queued === 1 ? '' : 's'} sent to the coding agent` : 'Nothing new to send: every open item is with the agent already');
              refetch();
            } catch (e) {
              toast((e as Error).message, true);
            } finally {
              setBusy(false);
            }
          }}
        >
          Send all open items on the board
        </button>
        <span className="small muted">Or ask Claude Code: “queue the open bugs of this project and fix them one by one”.</span>
      </div>
      <RepoKeys projectId={id} />
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
