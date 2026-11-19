/**
 * One work item, Jira / Azure DevOps style: key and type, workflow moves, details panel (assignee,
 * reporter, priority, severity, points, hours, sprint, release, parent / epic, components, labels,
 * custom fields), children, relations, code (branches, commits, PRs, builds), tests, comments with
 * @mentions, watchers and the full change history. Also the "Create item" dialog.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { del, get, patch, post, put } from '../../lib/api';
import { date } from '../../lib/format';
import { Empty, Modal, Spinner, useToast } from '../ui';

export type Json = Record<string, any>;

export const TYPES: [string, string, string][] = [
  ['epic', 'Epic', '⚡'],
  ['feature', 'Feature', '🧩'],
  ['story', 'Story', '📗'],
  ['bug', 'Bug', '🐞'],
  ['task', 'Task', '☑️'],
  ['spike', 'Spike', '🔬'],
  ['chore', 'Chore', '🧹'],
  ['subtask', 'Sub-task', '↳'],
];
export const typeIcon = (t: string) => TYPES.find((x) => x[0] === t)?.[2] ?? '☑️';
export const typeLabel = (t: string) => TYPES.find((x) => x[0] === t)?.[1] ?? t;
export const CAT_CLS: Record<string, string> = { todo: '', open: '', in_progress: 'info', review: 'warn', blocked: 'bad', done: 'good', cancelled: '' };
export const PRIORITIES = ['urgent', 'high', 'medium', 'low', 'none'];
const PRI_ICON: Record<string, string> = { urgent: '⏫', high: '🔺', medium: '▪️', low: '🔽', none: '·' };
export const priIcon = (p: string) => PRI_ICON[p] ?? '';
/** which parent types each type may have (mirrors the API) */
export const PARENTS: Record<string, string[]> = {
  epic: [],
  feature: ['epic'],
  story: ['epic', 'feature'],
  bug: ['epic', 'feature'],
  spike: ['epic', 'feature'],
  task: ['epic', 'feature', 'story', 'bug', 'task', 'spike', 'chore'],
  chore: ['epic', 'feature', 'story', 'bug', 'task', 'spike', 'chore'],
  subtask: ['story', 'bug', 'task', 'spike', 'chore', 'feature'],
};
export const CHILD_TYPES: Record<string, string[]> = Object.fromEntries(TYPES.map(([t]) => [t, TYPES.map((x) => x[0]).filter((c) => PARENTS[c]!.includes(t))]));

export function StateChip({ label, category }: { label: string; category: string }) {
  return <span className={`chip ${CAT_CLS[category] ?? ''}`}>{label}</span>;
}

export function useWorkSetup(projectId: string) {
  return useQuery({ queryKey: ['work', projectId, 'setup'], queryFn: () => get<Json>(`/api/v1/projects/${projectId}/work/setup`), staleTime: 30_000 });
}
export function usePlanning(projectId: string) {
  return useQuery({ queryKey: ['agile', projectId], queryFn: () => get<Json>(`/api/v1/projects/${projectId}/agile`), staleTime: 30_000 });
}
export function useProject(projectId: string) {
  return useQuery({ queryKey: ['project', projectId], queryFn: () => get<Json>(`/api/v1/projects/${projectId}`), staleTime: 30_000 });
}
/** People who can be assigned: the manager and members. */
export function useTeam(projectId: string): [string, string][] {
  const { data } = useProject(projectId);
  return useMemo(() => {
    if (!data) return [];
    const m = new Map<string, string>();
    if (data.project.owner_id) m.set(data.project.owner_id, data.project.manager ?? 'Manager');
    for (const x of data.members as Json[]) if (x.role !== 'viewer') m.set(x.user_id, x.full_name);
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [data]);
}

export function useInvalidateWork(projectId: string) {
  const qc = useQueryClient();
  return () => {
    for (const k of [['work', projectId], ['project', projectId], ['agile', projectId]]) qc.invalidateQueries({ queryKey: k });
  };
}

/* ───────────────────────── text with @mentions ───────────────────────── */

export function MentionText({ text }: { text: string }) {
  const parts: ReactNode[] = [];
  const re = /@\[([^\]]+)\]\([0-9a-f-]{36}\)/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    parts.push(text.slice(last, m.index));
    parts.push(
      <strong key={m.index} className="mention">
        @{m[1]}
      </strong>,
    );
    last = (m.index ?? 0) + m[0].length;
  }
  parts.push(text.slice(last));
  return <span style={{ whiteSpace: 'pre-wrap' }}>{parts}</span>;
}

export function MentionBox({ team, value, onChange, placeholder, rows = 3 }: { team: [string, string][]; value: string; onChange: (v: string) => void; placeholder?: string; rows?: number }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [q, setQ] = useState<string | null>(null);
  const [pick, setPick] = useState(0);
  const hits = q === null ? [] : team.filter(([, n]) => n.toLowerCase().includes(q.toLowerCase())).slice(0, 6);
  const update = (v: string) => {
    onChange(v);
    const pos = ref.current?.selectionStart ?? v.length;
    const m = /@([\w .]{0,30})$/.exec(v.slice(0, pos));
    setQ(m && !/\]\(/.test(m[0]) ? m[1]! : null);
    setPick(0);
  };
  const choose = (id: string, name: string) => {
    const el = ref.current!;
    const pos = el.selectionStart ?? value.length;
    const before = value.slice(0, pos).replace(/@([\w .]{0,30})$/, `@[${name}](${id}) `);
    const next = before + value.slice(pos);
    onChange(next);
    setQ(null);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(before.length, before.length);
    });
  };
  return (
    <div className="mention-box">
      <textarea
        ref={ref}
        rows={rows}
        value={value}
        placeholder={placeholder ?? 'Comment — type @ to mention someone'}
        onChange={(e) => update(e.target.value)}
        onKeyDown={(e) => {
          if (!hits.length) return;
          if (e.key === 'ArrowDown') (e.preventDefault(), setPick((pick + 1) % hits.length));
          else if (e.key === 'ArrowUp') (e.preventDefault(), setPick((pick - 1 + hits.length) % hits.length));
          else if (e.key === 'Enter' || e.key === 'Tab') (e.preventDefault(), choose(hits[pick]![0], hits[pick]![1]));
          else if (e.key === 'Escape') setQ(null);
        }}
      />
      {hits.length > 0 && (
        <div className="mention-pop" role="listbox">
          {hits.map(([id, n], i) => (
            <button key={id} type="button" role="option" aria-selected={i === pick} className={i === pick ? 'on' : ''} onMouseDown={(e) => (e.preventDefault(), choose(id, n))}>
              {n}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/* ───────────────────────── the item view ───────────────────────── */

const FIELD_NAMES: Record<string, string> = {
  status: 'Status', state: 'State', name: 'Summary', priority: 'Priority', assignees: 'Assignee', work_type: 'Type', story_points: 'Story points', sprint_id: 'Sprint', release_id: 'Release',
  epic_id: 'Epic', parent_id: 'Parent', due_date: 'Due', component_ids: 'Components', severity: 'Severity', resolution: 'Resolution', remaining_hours: 'Remaining', estimate_hours: 'Estimate',
  tags: 'Labels', description: 'Description', created: 'Created',
};
const LINK_ICON: Record<string, string> = { pr: '⤴', commit: '●', branch: '⑂', build: '⚙', doc: '📄', design: '🎨', other: '🔗' };

export function WorkItemModal({ projectId, id, onClose, onOpen }: { projectId: string; id: string; onClose: () => void; onOpen?: (id: string) => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const invalidate = useInvalidateWork(projectId);
  const { data: d, isLoading, error } = useQuery({ queryKey: ['work', projectId, 'item', id], queryFn: () => get<Json>(`/api/v1/projects/${projectId}/work/items/${id}`) });
  const { data: setup } = useWorkSetup(projectId);
  const { data: plan } = usePlanning(projectId);
  const team = useTeam(projectId);
  const [tab, setTab] = useState<'comments' | 'history' | 'code' | 'tests'>('comments');
  const [commentText, setComment] = useState('');
  const [editDesc, setEditDesc] = useState<string | null>(null);
  const [title, setTitle] = useState<string | null>(null);
  const [move, setMove] = useState<Json | null>(null);
  const [addChild, setAddChild] = useState(false);
  const [rel, setRel] = useState({ kind: 'relates', key: '' });
  const [busy, setBusy] = useState(false);
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['work', projectId, 'item', id] });
    invalidate();
  };
  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    setBusy(true);
    try {
      const r = await fn();
      if (ok) toast(ok);
      refresh();
      return r ?? true;
    } catch (e) {
      toast((e as Error).message, true);
      return null;
    } finally {
      setBusy(false);
    }
  };
  const save = (body: Json, ok?: string) => run(() => patch(`/api/v1/projects/${projectId}/work/items/${id}`, body), ok);
  if (isLoading || !d)
    return (
      <Modal title="Work item" onClose={onClose} xl>
        <div className="modal-body">{error ? <Empty title="Not found">{(error as Error).message}</Empty> : <Spinner />}</div>
      </Modal>
    );
  const it = d.item as Json;
  const can = d.level !== 'view';
  const people = new Map<string, string>([...team, ...Object.entries(d.people as Record<string, string>)]);
  const fields = ((setup?.fields ?? []) as Json[]).filter((f) => !f.work_types.length || f.work_types.includes(it.workType));
  const components = (setup?.components ?? []) as Json[];
  const sprints = ((plan?.sprints ?? []) as Json[]).filter((s) => s.status !== 'closed' || s.id === it.sprintId);
  const releases = (plan?.releases ?? []) as Json[];
  const epics = (plan?.epics ?? []) as Json[];
  const doMove = async (m: Json) => {
    if (m.require.some((r: string) => r === 'comment' || r === 'resolution') || (m.require.includes('assignee') && !it.assignees.length)) return setMove(m);
    await run(() => post(`/api/v1/projects/${projectId}/work/items/${id}/transition`, { to: m.to }), `Moved to ${m.label}`);
  };
  return (
    <Modal
      title={`${typeIcon(it.workType)} ${it.key}`}
      onClose={onClose}
      xl
      footer={
        <div className="row" style={{ justifyContent: 'space-between', width: '100%' }}>
          <span className="muted small">
            Created {date(it.createdAt)} · updated {date(it.updatedAt)}
            {it.externalKey && <> · synced from {it.externalUrl ? <a href={it.externalUrl} target="_blank" rel="noreferrer">{it.externalKey}</a> : it.externalKey}</>}
          </span>
          <span className="row" style={{ gap: 6 }}>
            <button className="btn small" onClick={() => run(() => put(`/api/v1/projects/${projectId}/work/items/${id}/watch`, { on: !d.watching }), d.watching ? 'Stopped watching' : 'Watching')}>
              {d.watching ? '👁 Watching' : 'Watch'} · {d.watchers.length}
            </button>
            <button
              className="btn small"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(`${location.origin}/projects/${projectId}?item=${id}`);
                  toast('Link copied');
                } catch {
                  toast('Copy failed', true);
                }
              }}
            >
              Copy link
            </button>
          </span>
        </div>
      }
    >
      <div className="modal-body work-item" data-export="off">
        <div className="wi-main stack">
          <div>
            {title === null ? (
              <h2 className="wi-title" onClick={() => can && setTitle(it.name)} title={can ? 'Click to edit' : ''}>
                {it.name}
              </h2>
            ) : (
              <input className="wi-title-input" autoFocus value={title} onChange={(e) => setTitle(e.target.value)} onBlur={async () => (title.trim() && title !== it.name ? await save({ name: title.trim() }) : null, setTitle(null))} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />
            )}
            <div className="row" style={{ gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
              <StateChip label={it.stateLabel} category={it.category} />
              {it.resolution && <span className="chip">{it.resolution}</span>}
              {can &&
                (d.workflow.moves as Json[]).map((m) => (
                  <button key={m.to} className={`btn small${m.category === 'done' ? ' primary' : ''}`} disabled={busy} onClick={() => doMove(m)}>
                    {m.label} →
                  </button>
                ))}
              <span className="muted small">{d.workflow.name} workflow</span>
            </div>
          </div>

          <div>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <h3 className="section-label">Description</h3>
              {can && editDesc === null && (
                <button className="link-btn small" onClick={() => setEditDesc(it.description ?? '')}>
                  Edit
                </button>
              )}
            </div>
            {editDesc === null ? (
              it.description ? <div className="wi-desc">{it.description}</div> : <p className="muted small">No description.</p>
            ) : (
              <div className="stack">
                <textarea rows={8} value={editDesc} onChange={(e) => setEditDesc(e.target.value)} autoFocus placeholder="Acceptance criteria, steps to reproduce, notes…" />
                <div className="row" style={{ gap: 6 }}>
                  <button className="btn primary small" onClick={async () => (await save({ description: editDesc || null }, 'Saved')) && setEditDesc(null)}>
                    Save
                  </button>
                  <button className="btn small" onClick={() => setEditDesc(null)}>
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>

          {(d.children.length > 0 || CHILD_TYPES[it.workType]!.length > 0) && (
            <div>
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <h3 className="section-label">
                  Child items {d.children.length > 0 && `· ${d.children.filter((c: Json) => ['done', 'cancelled'].includes(c.status)).length}/${d.children.length} done`}
                </h3>
                {can && CHILD_TYPES[it.workType]!.length > 0 && (
                  <button className="link-btn small" onClick={() => setAddChild(true)}>
                    + Add child
                  </button>
                )}
              </div>
              {d.children.length > 0 && <Progress done={d.children.filter((c: Json) => c.status === 'done').length} total={d.children.length} />}
              <ItemList items={d.children} people={people} onOpen={onOpen} />
            </div>
          )}

          <div>
            <h3 className="section-label">Linked items</h3>
            <ul className="wi-rel">
              {(d.relations as Json[]).map((r) => (
                <li key={r.id}>
                  <span className="muted small">{r.label}</span> <button className="link-btn" onClick={() => (r.item.projectId === projectId ? onOpen?.(r.item.id) : window.open(`/projects/${r.item.projectId}?item=${r.item.id}`, '_blank'))}>{typeIcon(r.item.workType)} {r.item.key}</button> {r.item.name}{' '}
                  <span className={`chip ${CAT_CLS[r.item.status] ?? ''}`}>{r.item.status.replace('_', ' ')}</span>
                  {can && (
                    <button className="link-btn small" aria-label="Remove link" onClick={() => run(() => del(`/api/v1/projects/${projectId}/work/items/${id}/relations/${r.id}`))}>
                      ✕
                    </button>
                  )}
                </li>
              ))}
            </ul>
            {can && (
              <div className="row" style={{ gap: 6 }}>
                <select value={rel.kind} onChange={(e) => setRel({ ...rel, kind: e.target.value })} aria-label="Link type">
                  {[['relates', 'relates to'], ['blocks', 'blocks'], ['duplicates', 'duplicates'], ['clones', 'clones'], ['causes', 'causes'], ['tests', 'tests']].map(([k, l]) => (
                    <option key={k} value={k}>
                      {l}
                    </option>
                  ))}
                </select>
                <input value={rel.key} onChange={(e) => setRel({ ...rel, key: e.target.value })} placeholder="KEY-12" style={{ width: 120 }} aria-label="Item key" />
                <button className="btn small" disabled={!rel.key.trim()} onClick={async () => (await run(() => post(`/api/v1/projects/${projectId}/work/items/${id}/relations`, rel), 'Linked')) && setRel({ ...rel, key: '' })}>
                  Link
                </button>
              </div>
            )}
          </div>

          <div>
            <div className="seg">
              {(
                [
                  ['comments', `Comments · ${d.comments.length}`],
                  ['history', 'History'],
                  ['code', `Code · ${d.links.length}`],
                  ['tests', `Tests · ${d.tests.length}`],
                ] as const
              ).map(([k, l]) => (
                <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>
                  {l}
                </button>
              ))}
            </div>
            {tab === 'comments' && (
              <div className="stack" style={{ marginTop: 10 }}>
                {(d.comments as Json[]).map((c) => (
                  <div key={c.id} className="wi-comment">
                    <div className="small">
                      <strong>{c.full_name ?? 'Someone'}</strong> <span className="muted">{new Date(c.created_at).toLocaleString()}</span>
                    </div>
                    <MentionText text={c.body} />
                  </div>
                ))}
                {can && (
                  <>
                    <MentionBox team={team} value={commentText} onChange={setComment} />
                    <div>
                      <button className="btn small primary" disabled={!commentText.trim() || busy} onClick={async () => (await run(() => post(`/api/v1/projects/${projectId}/work/items/${id}/comments`, { body: commentText.trim() }))) && setComment('')}>
                        Comment
                      </button>
                    </div>
                  </>
                )}
              </div>
            )}
            {tab === 'history' && (
              <ul className="wi-history">
                {(d.history as Json[]).map((h) => (
                  <li key={h.id}>
                    <span className="muted small">{new Date(h.at).toLocaleString()}</span> <strong>{h.actor}</strong>{' '}
                    {h.field === 'created' ? (
                      'created the item'
                    ) : (
                      <>
                        changed <strong>{FIELD_NAMES[h.field] ?? h.field}</strong>
                        {h.field !== 'description' && (
                          <>
                            {' '}
                            {h.from ? <span className="hist-old">{h.from}</span> : <span className="muted">none</span>} → {h.to ? <span className="hist-new">{h.to}</span> : <span className="muted">none</span>}
                          </>
                        )}
                      </>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {tab === 'code' && (
              <div className="stack" style={{ marginTop: 10 }}>
                <div className="callout small">
                  Mention <code className="mono">{it.key}</code> in a branch, commit or pull request and it links here. Branch:{' '}
                  <code className="mono">{d.branchName}</code>{' '}
                  <button className="link-btn small" onClick={() => navigator.clipboard.writeText(`git checkout -b ${d.branchName}`).then(() => toast('Command copied'), () => toast('Copy failed', true))}>
                    Copy git command
                  </button>
                </div>
                {!d.links.length ? (
                  <p className="muted small">No code linked yet.</p>
                ) : (
                  <table className="data compact">
                    <tbody>
                      {(d.links as Json[]).map((l) => (
                        <tr key={l.id}>
                          <td style={{ width: 24 }} title={l.kind}>
                            {LINK_ICON[l.kind] ?? '🔗'}
                          </td>
                          <td style={{ whiteSpace: 'normal' }}>
                            <a href={l.url} target="_blank" rel="noreferrer">
                              {l.title || l.url}
                            </a>
                            <div className="muted small">
                              {l.kind}
                              {l.repo && ` · ${l.repo}`}
                              {l.author && ` · ${l.author}`}
                              {l.source !== 'manual' && ` · ${l.source === 'github' ? 'GitHub' : 'Azure DevOps'}`}
                            </div>
                          </td>
                          <td>{l.status && <span className={`chip ${l.status === 'merged' || l.status === 'succeeded' ? 'good' : l.status === 'failed' ? 'bad' : l.status === 'open' || l.status === 'running' ? 'info' : ''}`}>{l.status}</span>}</td>
                          <td className="muted small nowrap">{date(l.occurred_at ?? l.created_at)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            )}
            {tab === 'tests' && (
              <div style={{ marginTop: 10 }}>
                {!d.tests.length ? (
                  <p className="muted small">No test cases cover this item. Add them under Tests.</p>
                ) : (
                  <table className="data compact">
                    <tbody>
                      {(d.tests as Json[]).map((t) => (
                        <tr key={t.id}>
                          <td className="nowrap">TC-{t.case_number}</td>
                          <td style={{ whiteSpace: 'normal' }}>{t.title}</td>
                          <td>{t.last_result ? <span className={`chip ${t.last_result === 'passed' ? 'good' : t.last_result === 'failed' ? 'bad' : 'warn'}`}>{t.last_result}</span> : <span className="muted small">not run</span>}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            )}
          </div>
        </div>

        <aside className="wi-side">
          <Detail label="Type">
            <select disabled={!can} value={it.workType} onChange={(e) => save({ workType: e.target.value }, 'Type changed')}>
              {TYPES.map(([k, l, i]) => (
                <option key={k} value={k}>
                  {i} {l}
                </option>
              ))}
            </select>
          </Detail>
          <Detail label="Assignee">
            <select disabled={!can} value={it.assignees[0] ?? ''} onChange={(e) => save({ assignees: e.target.value ? [e.target.value] : [] })}>
              <option value="">Unassigned</option>
              {team.map(([uid, n]) => (
                <option key={uid} value={uid}>
                  {n}
                </option>
              ))}
            </select>
          </Detail>
          <Detail label="Reporter">
            <select disabled={!can} value={it.reporterId ?? ''} onChange={(e) => save({ reporterId: e.target.value || null })}>
              <option value="">—</option>
              {[...people.entries()].map(([uid, n]) => (
                <option key={uid} value={uid}>
                  {n}
                </option>
              ))}
            </select>
          </Detail>
          <Detail label="Priority">
            <select disabled={!can} value={it.priority} onChange={(e) => save({ priority: e.target.value })}>
              {PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {priIcon(p)} {p}
                </option>
              ))}
            </select>
          </Detail>
          {it.workType === 'bug' && (
            <Detail label="Severity">
              <select disabled={!can} value={it.severity ?? ''} onChange={(e) => save({ severity: e.target.value || null })}>
                <option value="">—</option>
                {['blocker', 'critical', 'major', 'minor'].map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </Detail>
          )}
          <Detail label="Story points">
            <NumInput disabled={!can} value={it.storyPoints} onSave={(v) => save({ storyPoints: v })} />
          </Detail>
          <Detail label="Hours">
            <div className="row" style={{ gap: 4 }}>
              <NumInput disabled={!can} value={it.estimateHours} onSave={(v) => save({ estimateHours: v })} title="Original estimate" />
              <NumInput disabled={!can} value={it.remainingHours} onSave={(v) => save({ remainingHours: v })} title="Remaining" />
            </div>
            <span className="muted small">estimate · remaining · {it.loggedHours} h logged</span>
          </Detail>
          {it.workType !== 'epic' && (
            <Detail label="Sprint">
              <select disabled={!can} value={it.sprintId ?? ''} onChange={(e) => save({ sprintId: e.target.value || null })}>
                <option value="">Backlog</option>
                {sprints.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                    {s.status === 'active' ? ' (active)' : ''}
                  </option>
                ))}
              </select>
            </Detail>
          )}
          <Detail label="Release">
            <select disabled={!can} value={it.releaseId ?? ''} onChange={(e) => save({ releaseId: e.target.value || null })}>
              <option value="">—</option>
              {releases.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                  {r.version ? ` (${r.version})` : ''}
                </option>
              ))}
            </select>
          </Detail>
          {it.workType !== 'epic' && (
            <Detail label="Parent">
              <ParentPicker projectId={projectId} type={it.workType} value={d.parent} disabled={!can} selfId={id} onPick={(pid) => save({ parentId: pid }, pid ? 'Moved under the parent' : 'Removed from the parent')} />
            </Detail>
          )}
          {it.workType !== 'epic' && !it.parentId && (
            <Detail label="Epic">
              <select disabled={!can} value={it.epicId ?? ''} onChange={(e) => save({ epicId: e.target.value || null })}>
                <option value="">—</option>
                {epics.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.name}
                  </option>
                ))}
              </select>
            </Detail>
          )}
          {d.epic && it.parentId && (
            <Detail label="Epic">
              <button className="link-btn" onClick={() => onOpen?.(d.epic.id)}>
                ⚡ {d.epic.key} {d.epic.name}
              </button>
            </Detail>
          )}
          <Detail label="Components">
            <MultiPick disabled={!can} options={components.map((c) => [c.id, c.name])} value={it.componentIds} onChange={(v) => save({ componentIds: v })} />
          </Detail>
          <Detail label="Labels">
            <Labels disabled={!can} value={it.tags} onChange={(v) => save({ tags: v })} />
          </Detail>
          <Detail label="Start · due">
            <div className="row" style={{ gap: 4 }}>
              <input type="date" disabled={!can} value={it.startDate ?? ''} onChange={(e) => save({ startDate: e.target.value || null })} aria-label="Start" />
              <input type="date" disabled={!can} value={it.dueDate ?? ''} onChange={(e) => save({ dueDate: e.target.value || null })} aria-label="Due" />
            </div>
          </Detail>
          {fields.map((f) => (
            <Detail key={f.id} label={`${f.label}${f.required ? ' *' : ''}`}>
              <CustomInput f={f} disabled={!can} value={it.custom?.[f.key]} team={team} onSave={(v) => save({ custom: { [f.key]: v } })} />
            </Detail>
          ))}
          <Detail label="Watchers">
            <div className="small">{(d.watchers as Json[]).map((w) => w.full_name).join(', ') || '—'}</div>
            {can && (
              <select value="" onChange={(e) => e.target.value && run(() => put(`/api/v1/projects/${projectId}/work/items/${id}/watch`, { on: true, userId: e.target.value }), 'Watcher added')} aria-label="Add watcher">
                <option value="">+ Add watcher</option>
                {team
                  .filter(([uid]) => !(d.watchers as Json[]).some((w) => w.user_id === uid))
                  .map(([uid, n]) => (
                    <option key={uid} value={uid}>
                      {n}
                    </option>
                  ))}
              </select>
            )}
          </Detail>
        </aside>
      </div>
      {move && <MoveDialog m={move} item={it} team={team} onClose={() => setMove(null)} onMove={async (b) => (await run(() => post(`/api/v1/projects/${projectId}/work/items/${id}/transition`, { to: move.to, ...b }), `Moved to ${move.label}`)) && setMove(null)} />}
      {addChild && (
        <CreateItemModal
          projectId={projectId}
          defaults={{ workType: CHILD_TYPES[it.workType]!.includes('subtask') ? (it.workType === 'feature' ? 'story' : 'subtask') : CHILD_TYPES[it.workType]![0], parentId: id, parentKey: `${it.key} ${it.name}`, sprintId: it.sprintId }}
          onClose={() => setAddChild(false)}
          onCreated={() => (setAddChild(false), refresh())}
        />
      )}
    </Modal>
  );
}

function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="wi-detail">
      <div className="wi-label">{label}</div>
      <div>{children}</div>
    </div>
  );
}

export function Progress({ done, total }: { done: number; total: number }) {
  const pct = total ? Math.round((done / total) * 100) : 0;
  return (
    <div className="wi-progress" title={`${done} of ${total} done`} aria-label={`${pct}% done`}>
      <span style={{ width: `${pct}%` }} />
    </div>
  );
}

export function ItemList({ items, people, onOpen }: { items: Json[]; people?: Map<string, string>; onOpen?: (id: string) => void }) {
  if (!items.length) return null;
  return (
    <table className="data compact">
      <tbody>
        {items.map((c) => (
          <tr key={c.id} className="click" onClick={() => onOpen?.(c.id)}>
            <td className="nowrap" style={{ width: 110 }}>
              {typeIcon(c.workType)} {c.key}
            </td>
            <td style={{ whiteSpace: 'normal' }}>{c.name}</td>
            <td className="small">{(c.assignees as string[]).map((a) => people?.get(a) ?? '').filter(Boolean).join(', ')}</td>
            <td>
              <span className={`chip ${CAT_CLS[c.status] ?? ''}`}>{c.status.replace('_', ' ')}</span>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function NumInput({ value, onSave, disabled, title }: { value: number | null; onSave: (v: number | null) => void; disabled?: boolean; title?: string }) {
  const [v, setV] = useState(value === null || value === undefined ? '' : String(value));
  useEffect(() => setV(value === null || value === undefined ? '' : String(value)), [value]);
  return (
    <input
      inputMode="decimal"
      title={title}
      aria-label={title}
      disabled={disabled}
      value={v}
      style={{ width: 72 }}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => {
        const n = v.trim() === '' ? null : Number(v);
        if (n !== null && !Number.isFinite(n)) return setV(value === null ? '' : String(value));
        if (n !== value) onSave(n);
      }}
    />
  );
}

function MultiPick({ options, value, onChange, disabled }: { options: [string, string][]; value: string[]; onChange: (v: string[]) => void; disabled?: boolean }) {
  return (
    <div className="row" style={{ gap: 4, flexWrap: 'wrap' }}>
      {value.map((v) => (
        <span key={v} className="chip">
          {options.find((o) => o[0] === v)?.[1] ?? '—'}
          {!disabled && (
            <button className="link-btn" aria-label="Remove" onClick={() => onChange(value.filter((x) => x !== v))}>
              {' '}
              ✕
            </button>
          )}
        </span>
      ))}
      {!disabled && options.some((o) => !value.includes(o[0])) && (
        <select value="" onChange={(e) => e.target.value && onChange([...value, e.target.value])} aria-label="Add">
          <option value="">+ Add</option>
          {options
            .filter((o) => !value.includes(o[0]))
            .map(([k, l]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
        </select>
      )}
      {!options.length && <span className="muted small">None set up</span>}
    </div>
  );
}

function Labels({ value, onChange, disabled }: { value: string[]; onChange: (v: string[]) => void; disabled?: boolean }) {
  const [t, setT] = useState('');
  return (
    <div className="row" style={{ gap: 4, flexWrap: 'wrap' }}>
      {value.map((v) => (
        <span key={v} className="chip">
          {v}
          {!disabled && (
            <button className="link-btn" aria-label={`Remove ${v}`} onClick={() => onChange(value.filter((x) => x !== v))}>
              {' '}
              ✕
            </button>
          )}
        </span>
      ))}
      {!disabled && (
        <input
          value={t}
          placeholder="+ label"
          style={{ width: 90 }}
          onChange={(e) => setT(e.target.value.replace(/\s/g, '-'))}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && t.trim()) {
              e.preventDefault();
              onChange([...new Set([...value, t.trim().toLowerCase()])]);
              setT('');
            }
          }}
          aria-label="Add label"
        />
      )}
    </div>
  );
}

function CustomInput({ f, value, onSave, disabled, team }: { f: Json; value: unknown; onSave: (v: unknown) => void; disabled?: boolean; team: [string, string][] }) {
  const [v, setV] = useState<string>(value === undefined || value === null ? '' : String(value));
  useEffect(() => setV(value === undefined || value === null ? '' : String(value)), [value]);
  if (f.type === 'select')
    return (
      <select disabled={disabled} value={v} onChange={(e) => onSave(e.target.value || null)}>
        <option value="">—</option>
        {(f.options as string[]).map((o) => (
          <option key={o}>{o}</option>
        ))}
      </select>
    );
  if (f.type === 'multiselect') return <MultiPick disabled={disabled} options={(f.options as string[]).map((o) => [o, o])} value={(value as string[]) ?? []} onChange={(x) => onSave(x)} />;
  if (f.type === 'checkbox') return <input type="checkbox" disabled={disabled} checked={!!value} onChange={(e) => onSave(e.target.checked)} />;
  if (f.type === 'user')
    return (
      <select disabled={disabled} value={v} onChange={(e) => onSave(e.target.value || null)}>
        <option value="">—</option>
        {team.map(([id, n]) => (
          <option key={id} value={id}>
            {n}
          </option>
        ))}
      </select>
    );
  return (
    <input
      type={f.type === 'date' ? 'date' : f.type === 'number' ? 'number' : 'text'}
      disabled={disabled}
      value={v}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => v !== String(value ?? '') && onSave(v === '' ? null : f.type === 'number' ? Number(v) : v)}
    />
  );
}

/** Search the project's items for a parent the item may sit under. */
export function ParentPicker({ projectId, type, value, onPick, disabled, selfId }: { projectId: string; type: string; value: Json | null; onPick: (id: string | null) => void; disabled?: boolean; selfId?: string }) {
  const [open, setOpen] = useState(false);
  const [s, setS] = useState('');
  const allowed = PARENTS[type] ?? [];
  const q = `type in (${allowed.join(', ') || 'none'}) AND status != cancelled${s.trim() ? ` AND text ~ ${JSON.stringify(s.trim())}` : ''} ORDER BY updated DESC`;
  const { data } = useQuery({ queryKey: ['work', projectId, 'parent-pick', q], enabled: open && allowed.length > 0, queryFn: () => get<Json>(`/api/v1/projects/${projectId}/work/query?limit=20&q=${encodeURIComponent(q)}`) });
  if (!allowed.length) return <span className="muted small">Top level</span>;
  return (
    <div className="stack" style={{ gap: 4 }}>
      {value ? (
        <span className="small">
          {typeIcon(value.workType)} {value.key} {value.name}
          {!disabled && (
            <button className="link-btn small" onClick={() => onPick(null)} aria-label="Remove parent">
              {' '}
              ✕
            </button>
          )}
        </span>
      ) : (
        <span className="muted small">None</span>
      )}
      {!disabled &&
        (open ? (
          <div className="stack" style={{ gap: 4 }}>
            <input autoFocus value={s} onChange={(e) => setS(e.target.value)} placeholder={`Find a ${allowed.join(' / ')}`} />
            <div className="pick-list" style={{ maxHeight: 160 }}>
              {((data?.items ?? []) as Json[])
                .filter((x) => x.id !== selfId)
                .map((x) => (
                  <button key={x.id} type="button" className="link-btn small" style={{ textAlign: 'left' }} onClick={() => (onPick(x.id), setOpen(false))}>
                    {typeIcon(x.workType)} {x.key} {x.name}
                  </button>
                ))}
              {data && !data.items.length && <span className="muted small">Nothing found</span>}
            </div>
          </div>
        ) : (
          <button className="link-btn small" onClick={() => setOpen(true)}>
            {value ? 'Change' : 'Set parent'}
          </button>
        ))}
    </div>
  );
}

function MoveDialog({ m, item, team, onClose, onMove }: { m: Json; item: Json; team: [string, string][]; onClose: () => void; onMove: (b: Json) => void }) {
  const [f, setF] = useState({ comment: '', resolution: m.category === 'done' ? 'Done' : m.category === 'cancelled' ? "Won't do" : '', assignee: item.assignees[0] ?? '' });
  const need = (r: string) => m.require.includes(r);
  return (
    <Modal
      title={`Move to ${m.label}`}
      onClose={onClose}
      footer={
        <button className="btn primary" disabled={(need('comment') && !f.comment.trim()) || (need('resolution') && !f.resolution.trim()) || (need('assignee') && !f.assignee)} onClick={() => onMove({ comment: f.comment.trim() || null, resolution: f.resolution.trim() || null, assignee: f.assignee || null })}>
          Move
        </button>
      }
    >
      <div className="modal-body stack">
        {need('assignee') && (
          <label className="field">
            Assignee
            <select value={f.assignee} onChange={(e) => setF({ ...f, assignee: e.target.value })}>
              <option value="">Choose…</option>
              {team.map(([id, n]) => (
                <option key={id} value={id}>
                  {n}
                </option>
              ))}
            </select>
          </label>
        )}
        {(need('resolution') || ['done', 'cancelled'].includes(m.category)) && (
          <label className="field">
            Resolution
            <select value={f.resolution} onChange={(e) => setF({ ...f, resolution: e.target.value })}>
              {['', 'Done', 'Fixed', "Won't do", "Won't fix", 'Duplicate', 'Cannot reproduce', 'Works as designed'].map((r) => (
                <option key={r} value={r}>
                  {r || '—'}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="field">
          Comment{need('comment') ? ' (required)' : ''}
          <textarea rows={3} value={f.comment} onChange={(e) => setF({ ...f, comment: e.target.value })} />
        </label>
      </div>
    </Modal>
  );
}

/* ───────────────────────── create ───────────────────────── */

export function CreateItemModal({ projectId, defaults = {}, onClose, onCreated }: { projectId: string; defaults?: Json; onClose: () => void; onCreated: (r: { id: string; key: string }) => void }) {
  const toast = useToast();
  const invalidate = useInvalidateWork(projectId);
  const { data: setup } = useWorkSetup(projectId);
  const { data: plan } = usePlanning(projectId);
  const team = useTeam(projectId);
  const [f, setF] = useState<Json>({ workType: 'story', priority: 'medium', name: '', description: '', assignee: '', storyPoints: '', sprintId: '', releaseId: '', componentIds: [], tags: '', custom: {}, severity: '', ...defaults });
  const [parent, setParent] = useState<Json | null>(defaults.parentId ? { id: defaults.parentId, key: defaults.parentKey ?? 'Parent', name: '', workType: '' } : null);
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const fields = ((setup?.fields ?? []) as Json[]).filter((x) => !x.work_types.length || x.work_types.includes(f.workType));
  const save = async (again: boolean) => {
    setBusy(true);
    try {
      const r = await post<{ id: string; key: string }>(`/api/v1/projects/${projectId}/work/items`, {
        name: f.name.trim(), workType: f.workType, priority: f.priority, description: f.description.trim() || null,
        assignees: f.assignee ? [f.assignee] : [], storyPoints: f.storyPoints === '' ? null : Number(f.storyPoints), sprintId: f.sprintId || null, releaseId: f.releaseId || null,
        parentId: parent?.id ?? null, componentIds: f.componentIds, tags: String(f.tags).split(/[\s,]+/).filter(Boolean).map((x: string) => x.toLowerCase()), custom: f.custom,
        severity: f.workType === 'bug' && f.severity ? f.severity : null,
      });
      toast(`${r.key} created`);
      invalidate();
      if (again) setF({ ...f, name: '', description: '' });
      else onCreated(r);
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title="Create work item"
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn" disabled={busy || !f.name.trim()} onClick={() => save(true)}>
            Create another
          </button>
          <button className="btn primary" disabled={busy || !f.name.trim()} onClick={() => save(false)}>
            Create
          </button>
        </>
      }
    >
      <div className="modal-body stack">
        <div className="grid2">
          <label className="field">
            Type
            <select value={f.workType} onChange={(e) => (setF({ ...f, workType: e.target.value }), parent && !(PARENTS[e.target.value] ?? []).length && setParent(null))}>
              {TYPES.map(([k, l, i]) => (
                <option key={k} value={k}>
                  {i} {l}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            Priority
            <select value={f.priority} onChange={(e) => setF({ ...f, priority: e.target.value })}>
              {PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {priIcon(p)} {p}
                </option>
              ))}
            </select>
          </label>
          <label className="field wide">
            Summary
            <input autoFocus value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && f.name.trim() && save(false)} placeholder={f.workType === 'bug' ? 'What is broken, where' : 'As a dispatcher I can see every truck on a map'} />
          </label>
          <label className="field wide">
            Description
            <textarea rows={4} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} placeholder={f.workType === 'bug' ? 'Steps to reproduce, expected and actual result' : 'Acceptance criteria'} />
          </label>
          <label className="field">
            Assignee
            <select value={f.assignee} onChange={(e) => setF({ ...f, assignee: e.target.value })}>
              <option value="">Unassigned</option>
              {team.map(([id, n]) => (
                <option key={id} value={id}>
                  {n}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            Story points
            <input inputMode="decimal" value={f.storyPoints} onChange={(e) => setF({ ...f, storyPoints: e.target.value })} />
          </label>
          {(PARENTS[f.workType] ?? []).length > 0 && (
            <div className="field wide">
              Parent{f.workType === 'subtask' ? ' (required)' : ''}
              <ParentPicker projectId={projectId} type={f.workType} value={parent} onPick={async (id) => setParent(id ? ((await get<Json>(`/api/v1/projects/${projectId}/work/items/${id}`)).item as Json) : null)} />
            </div>
          )}
          {f.workType === 'bug' && (
            <label className="field">
              Severity
              <select value={f.severity} onChange={(e) => setF({ ...f, severity: e.target.value })}>
                <option value="">—</option>
                {['blocker', 'critical', 'major', 'minor'].map((x) => (
                  <option key={x}>{x}</option>
                ))}
              </select>
            </label>
          )}
          {fields
            .filter((x) => x.required || more)
            .map((x) => (
              <label key={x.id} className="field">
                {x.label}
                {x.required ? ' *' : ''}
                <CustomInput f={x} value={f.custom[x.key]} team={team} onSave={(v) => setF((p: Json) => ({ ...p, custom: { ...p.custom, [x.key]: v } }))} />
              </label>
            ))}
        </div>
        <button className="link-btn small" onClick={() => setMore(!more)}>
          {more ? 'Fewer fields' : 'More fields: sprint, release, components, labels…'}
        </button>
        {more && (
          <div className="grid2">
            {f.workType !== 'epic' && (
              <label className="field">
                Sprint
                <select value={f.sprintId} onChange={(e) => setF({ ...f, sprintId: e.target.value })}>
                  <option value="">Backlog</option>
                  {((plan?.sprints ?? []) as Json[])
                    .filter((s) => s.status !== 'closed')
                    .map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                </select>
              </label>
            )}
            <label className="field">
              Release
              <select value={f.releaseId} onChange={(e) => setF({ ...f, releaseId: e.target.value })}>
                <option value="">—</option>
                {((plan?.releases ?? []) as Json[]).map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </select>
            </label>
            <div className="field">
              Components
              <MultiPick options={((setup?.components ?? []) as Json[]).map((c) => [c.id, c.name])} value={f.componentIds} onChange={(v) => setF({ ...f, componentIds: v })} />
            </div>
            <label className="field">
              Labels
              <input value={f.tags} onChange={(e) => setF({ ...f, tags: e.target.value })} placeholder="api, mobile" />
            </label>
          </div>
        )}
      </div>
    </Modal>
  );
}
