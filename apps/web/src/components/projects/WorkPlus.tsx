/**
 * More of work management: automation rules, rich text with attachments, live updates, project
 * templates, email alerts, the GitHub App (repository picker, required check, branches), the
 * workspace's repository rule, and the sprint / time-in-status / release burn-up reports.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { del, get, post, put, upload } from '../../lib/api';
import { date } from '../../lib/format';
import { Chart } from '../charts';
import { Empty, Modal, Spinner, useToast } from '../ui';
import { type Json, MentionBox, typeIcon, TYPES, useTeam, useWorkSetup } from './WorkItem';
import { SetUpKeysLink } from '../admin/ConnectionKeys';

function useRun() {
  const toast = useToast();
  return async <T,>(fn: () => Promise<T>, ok?: string): Promise<T | null> => {
    try {
      const r = await fn();
      if (ok) toast(ok);
      return r;
    } catch (e) {
      toast((e as Error).message, true);
      return null;
    }
  };
}

/* ───────────────────────── live updates ───────────────────────── */

/**
 * Boards, backlogs and items refresh by themselves: a tiny "what changed" stamp is checked every few
 * seconds while the page is visible, and the work queries reload when it moves.
 */
export function useLiveWork(projectId: string, everyMs = 5000) {
  const qc = useQueryClient();
  const last = useRef<string | null>(null);
  useEffect(() => {
    let stop = false;
    let timer: number | undefined;
    const tick = async () => {
      if (stop) return;
      if (document.visibilityState === 'visible') {
        try {
          const r = await get<{ stamp: string }>(`/api/v1/projects/${projectId}/work/stamp`);
          if (last.current !== null && r.stamp !== last.current) for (const k of [['work', projectId], ['project', projectId], ['agile', projectId]]) qc.invalidateQueries({ queryKey: k });
          last.current = r.stamp;
        } catch {
          /* offline or signed out: try again later */
        }
      }
      timer = window.setTimeout(tick, everyMs);
    };
    void tick();
    const vis = () => document.visibilityState === 'visible' && (window.clearTimeout(timer), void tick());
    document.addEventListener('visibilitychange', vis);
    return () => {
      stop = true;
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', vis);
    };
  }, [projectId, everyMs, qc]);
}

/* ───────────────────────── rich text (Markdown) ───────────────────────── */

type Files = Map<string, Json>;

function inline(text: string, files: Files, k: string): ReactNode[] {
  // images, links, mentions, code, bold, italic, strike — in that order of precedence
  const re = /!\[([^\]]*)\]\((file:[0-9a-f-]{36}|https?:\/\/[^\s)]+)\)|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|@\[([^\]]+)\]\([0-9a-f-]{36}\)|`([^`]+)`|\*\*([^*]+)\*\*|~~([^~]+)~~|(?<![\w*])\*([^*\n]+)\*(?!\w)|(?<![\w_])_([^_\n]+)_(?!\w)|(https?:\/\/[^\s<]+[^\s<.,;:!?)])/g;
  const out: ReactNode[] = [];
  let last = 0;
  let i = 0;
  for (const m of text.matchAll(re)) {
    if (m.index! > last) out.push(text.slice(last, m.index));
    const key = `${k}-${i++}`;
    if (m[2] !== undefined) {
      const f = m[2].startsWith('file:') ? files.get(m[2].slice(5)) : null;
      const src = f ? f.url : m[2].startsWith('file:') ? null : m[2];
      out.push(src ? <img key={key} src={src} alt={m[1]} className="md-img" loading="lazy" /> : <span key={key} className="muted small">[image: {m[1] || 'removed'}]</span>);
    } else if (m[4] !== undefined)
      out.push(
        <a key={key} href={m[4]} target="_blank" rel="noreferrer noopener">
          {m[3]}
        </a>,
      );
    else if (m[5] !== undefined)
      out.push(
        <strong key={key} className="mention">
          @{m[5]}
        </strong>,
      );
    else if (m[6] !== undefined) out.push(<code key={key}>{m[6]}</code>);
    else if (m[7] !== undefined) out.push(<strong key={key}>{inline(m[7], files, key)}</strong>);
    else if (m[8] !== undefined) out.push(<s key={key}>{inline(m[8], files, key)}</s>);
    else if (m[9] !== undefined || m[10] !== undefined) out.push(<em key={key}>{inline(m[9] ?? m[10]!, files, key)}</em>);
    else if (m[11] !== undefined)
      out.push(
        <a key={key} href={m[11]} target="_blank" rel="noreferrer noopener">
          {m[11]}
        </a>,
      );
    last = m.index! + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** Safe Markdown: headings, lists, check lists, quotes, code, tables, images from the item's attachments. */
export function RichText({ text, files }: { text: string | null | undefined; files?: Json[] }) {
  const map = useMemo(() => new Map((files ?? []).map((f) => [f.id as string, f])), [files]);
  const blocks = useMemo(() => {
    const lines = String(text ?? '').replace(/\r/g, '').split('\n');
    const out: ReactNode[] = [];
    let i = 0;
    let n = 0;
    while (i < lines.length) {
      const l = lines[i]!;
      const key = `b${n++}`;
      if (/^```/.test(l)) {
        const body: string[] = [];
        i++;
        while (i < lines.length && !/^```/.test(lines[i]!)) body.push(lines[i++]!);
        i++;
        out.push(
          <pre key={key} className="md-code">
            <code>{body.join('\n')}</code>
          </pre>,
        );
        continue;
      }
      const h = /^(#{1,4})\s+(.*)$/.exec(l);
      if (h) {
        const Tag = (['h3', 'h4', 'h5', 'h6'] as const)[h[1]!.length - 1]!;
        out.push(<Tag key={key}>{inline(h[2]!, map, key)}</Tag>);
        i++;
        continue;
      }
      if (/^\s*([-*+]|\d+[.)])\s+/.test(l)) {
        const ordered = /^\s*\d/.test(l);
        const items: ReactNode[] = [];
        while (i < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i]!)) {
          const raw = lines[i]!.replace(/^\s*([-*+]|\d+[.)])\s+/, '');
          const task = /^\[([ xX])\]\s+(.*)$/.exec(raw);
          items.push(
            <li key={i} className={task ? 'md-task' : undefined}>
              {task ? (
                <>
                  <input type="checkbox" checked={task[1] !== ' '} readOnly disabled /> {inline(task[2]!, map, `${key}-${i}`)}
                </>
              ) : (
                inline(raw, map, `${key}-${i}`)
              )}
            </li>,
          );
          i++;
        }
        out.push(ordered ? <ol key={key}>{items}</ol> : <ul key={key}>{items}</ul>);
        continue;
      }
      if (/^>\s?/.test(l)) {
        const q: string[] = [];
        while (i < lines.length && /^>\s?/.test(lines[i]!)) q.push(lines[i++]!.replace(/^>\s?/, ''));
        out.push(<blockquote key={key}>{inline(q.join('\n'), map, key)}</blockquote>);
        continue;
      }
      if (/^\|.*\|\s*$/.test(l) && i + 1 < lines.length && /^\|[\s:|-]+\|\s*$/.test(lines[i + 1]!)) {
        const cells = (s: string) => s.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
        const head = cells(l);
        i += 2;
        const rows: string[][] = [];
        while (i < lines.length && /^\|.*\|\s*$/.test(lines[i]!)) rows.push(cells(lines[i++]!));
        out.push(
          <table key={key} className="data compact md-table">
            <thead>
              <tr>
                {head.map((c, j) => (
                  <th key={j}>{inline(c, map, `${key}h${j}`)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, ri) => (
                <tr key={ri}>
                  {r.map((c, j) => (
                    <td key={j}>{inline(c, map, `${key}-${ri}-${j}`)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>,
        );
        continue;
      }
      if (/^(-{3,}|\*{3,})\s*$/.test(l)) {
        out.push(<hr key={key} />);
        i++;
        continue;
      }
      if (!l.trim()) {
        i++;
        continue;
      }
      const para: string[] = [];
      while (i < lines.length && lines[i]!.trim() && !/^(```|#{1,4}\s|\s*([-*+]|\d+[.)])\s|>|\|)/.test(lines[i]!)) para.push(lines[i++]!);
      if (!para.length) para.push(lines[i++]!);
      out.push(
        <p key={key}>
          {para.map((p, j) => (
            <span key={j}>
              {j > 0 && <br />}
              {inline(p, map, `${key}-${j}`)}
            </span>
          ))}
        </p>,
      );
    }
    return out;
  }, [text, map]);
  return <div className="md">{blocks}</div>;
}

const TOOLS: [string, string, (sel: string) => [string, string, string]][] = [
  ['B', 'Bold', (s) => ['**', s || 'bold text', '**']],
  ['I', 'Italic', (s) => ['_', s || 'italic', '_']],
  ['H', 'Heading', (s) => ['\n### ', s || 'Heading', '\n']],
  ['•', 'Bulleted list', (s) => ['\n- ', s || 'item', '\n']],
  ['☐', 'Check list', (s) => ['\n- [ ] ', s || 'to do', '\n']],
  ['</>', 'Code', (s) => (s.includes('\n') ? ['\n```\n', s, '\n```\n'] : ['`', s || 'code', '`'])],
  ['🔗', 'Link', (s) => ['[', s || 'text', '](https://)']],
  ['❝', 'Quote', (s) => ['\n> ', s || 'quote', '\n']],
];

/**
 * Markdown editor with a toolbar, Write / Preview, @mentions, and images pasted or dropped in —
 * uploaded as attachments of the work item and shown inline.
 */
export function RichEditor({
  value,
  onChange,
  team,
  projectId,
  itemId,
  files,
  onUploaded,
  rows = 6,
  placeholder,
  autoFocus,
}: {
  value: string;
  onChange: (v: string) => void;
  team: [string, string][];
  projectId: string;
  itemId?: string | null;
  files?: Json[];
  onUploaded?: () => void;
  rows?: number;
  placeholder?: string;
  autoFocus?: boolean;
}) {
  const box = useRef<HTMLDivElement>(null);
  const pick = useRef<HTMLInputElement>(null);
  const [mode, setMode] = useState<'write' | 'preview'>('write');
  const [busy, setBusy] = useState<string | null>(null);
  const toast = useToast();
  const ta = () => box.current?.querySelector('textarea') ?? null;
  useEffect(() => {
    if (autoFocus) ta()?.focus();
  }, [autoFocus]);
  const wrap = (f: (sel: string) => [string, string, string]) => {
    const el = ta();
    if (!el) return;
    const s = el.selectionStart ?? value.length;
    const e = el.selectionEnd ?? value.length;
    const [a, mid, b] = f(value.slice(s, e));
    const next = value.slice(0, s) + a + mid + b + value.slice(e);
    onChange(next);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(s + a.length, s + a.length + mid.length);
    });
  };
  const insertAt = (text: string) => {
    const el = ta();
    const s = el?.selectionStart ?? value.length;
    onChange(value.slice(0, s) + text + value.slice(s));
  };
  const send = async (list: File[]) => {
    if (!itemId) return toast('Save the item first, then add pictures and files', true);
    for (const f of list) {
      if (f.size > 25 * 1024 * 1024) {
        toast(`${f.name} is over 25 MB`, true);
        continue;
      }
      setBusy(`Uploading ${f.name}…`);
      try {
        const name = f.name && f.name !== 'image.png' ? f.name : `pasted-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.png`;
        const r = await upload<Json>(`/api/v1/projects/${projectId}/work/items/${itemId}/files?name=${encodeURIComponent(name)}`, f);
        insertAt(f.type.startsWith('image/') ? `\n![${name}](file:${r.id})\n` : `[${name}](file:${r.id})`);
        onUploaded?.();
      } catch (e) {
        toast((e as Error).message, true);
      } finally {
        setBusy(null);
      }
    }
  };
  return (
    <div
      className="rich-editor"
      ref={box}
      onPaste={(e) => {
        const imgs = [...e.clipboardData.files].filter((f) => f.type.startsWith('image/'));
        if (imgs.length) (e.preventDefault(), void send(imgs));
      }}
      onDragOver={(e) => e.dataTransfer.types.includes('Files') && e.preventDefault()}
      onDrop={(e) => {
        if (!e.dataTransfer.files.length) return;
        e.preventDefault();
        void send([...e.dataTransfer.files]);
      }}
    >
      <div className="rich-bar" role="toolbar" aria-label="Formatting">
        <div className="seg small">
          <button type="button" className={mode === 'write' ? 'on' : ''} onClick={() => setMode('write')}>
            Write
          </button>
          <button type="button" className={mode === 'preview' ? 'on' : ''} onClick={() => setMode('preview')}>
            Preview
          </button>
        </div>
        {mode === 'write' &&
          TOOLS.map(([icon, label, f]) => (
            <button key={label} type="button" className="rich-tool" title={label} aria-label={label} onClick={() => wrap(f)}>
              {icon}
            </button>
          ))}
        {mode === 'write' && itemId && (
          <>
            <button type="button" className="rich-tool" title="Attach a picture or file" aria-label="Attach" onClick={() => pick.current?.click()}>
              📎
            </button>
            <input ref={pick} type="file" hidden multiple onChange={(e) => (void send([...(e.target.files ?? [])]), (e.target.value = ''))} />
          </>
        )}
        {busy && <span className="muted small">{busy}</span>}
      </div>
      {mode === 'write' ? (
        <MentionBox team={team} value={value} onChange={onChange} rows={rows} placeholder={placeholder ?? 'Markdown: **bold**, _italic_, - lists, - [ ] check lists, ``` code. Paste or drop pictures. Type @ to mention.'} />
      ) : (
        <div className="rich-preview">{value.trim() ? <RichText text={value} files={files} /> : <span className="muted small">Nothing to preview.</span>}</div>
      )}
    </div>
  );
}

/* ───────────────────────── attachments ───────────────────────── */

export function useItemFiles(projectId: string, itemId: string) {
  return useQuery({ queryKey: ['work', projectId, 'item', itemId, 'files'], queryFn: () => get<Json[]>(`/api/v1/projects/${projectId}/work/items/${itemId}/files`), staleTime: 4 * 60_000 });
}

const size = (b: number) => (b > 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);

export function Attachments({ projectId, itemId, can }: { projectId: string; itemId: string; can: boolean }) {
  const { data, refetch } = useItemFiles(projectId, itemId);
  const qc = useQueryClient();
  const pick = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const run = useRun();
  const toast = useToast();
  const send = async (list: File[]) => {
    setBusy(true);
    for (const f of list) {
      if (f.size > 25 * 1024 * 1024) {
        toast(`${f.name} is over 25 MB`, true);
        continue;
      }
      await run(() => upload(`/api/v1/projects/${projectId}/work/items/${itemId}/files?name=${encodeURIComponent(f.name)}`, f));
    }
    setBusy(false);
    refetch();
    qc.invalidateQueries({ queryKey: ['work', projectId, 'item', itemId] });
  };
  const files = data ?? [];
  if (!can && !files.length) return null;
  return (
    <div
      onDragOver={(e) => can && e.dataTransfer.types.includes('Files') && e.preventDefault()}
      onDrop={(e) => {
        if (!can || !e.dataTransfer.files.length) return;
        e.preventDefault();
        void send([...e.dataTransfer.files]);
      }}
    >
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h3 className="section-label">Attachments {files.length > 0 && `· ${files.length}`}</h3>
        {can && (
          <>
            <button className="link-btn small" disabled={busy} onClick={() => pick.current?.click()}>
              {busy ? 'Uploading…' : '+ Attach files'}
            </button>
            <input ref={pick} type="file" hidden multiple onChange={(e) => (void send([...(e.target.files ?? [])]), (e.target.value = ''))} />
          </>
        )}
      </div>
      {!files.length ? (
        <p className="muted small">Drop files here — screenshots, logs, specs (25 MB each).</p>
      ) : (
        <div className="attach-grid">
          {files.map((f) => (
            <div key={f.id} className="attach">
              {f.type.startsWith('image/') ? (
                <a href={f.url} target="_blank" rel="noreferrer">
                  <img src={f.url} alt={f.name} loading="lazy" />
                </a>
              ) : (
                <div className="attach-icon" aria-hidden="true">
                  {/pdf/.test(f.type) ? 'PDF' : (f.name.split('.').pop() ?? 'file').slice(0, 4).toUpperCase()}
                </div>
              )}
              <div className="attach-meta">
                <a href={f.downloadUrl} className="small" title={f.name}>
                  {f.name}
                </a>
                <div className="muted small">
                  {size(f.size)}
                  {f.uploader && ` · ${f.uploader}`}
                </div>
                {can && (
                  <button className="link-btn small" onClick={async () => window.confirm(`Remove ${f.name}?`) && (await run(() => del(`/api/v1/projects/${projectId}/work/items/${itemId}/files/${f.id}`), 'Removed')) !== null && (refetch(), qc.invalidateQueries({ queryKey: ['work', projectId, 'item', itemId] }))}>
                    Remove
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ───────────────────────── automation rules ───────────────────────── */

const TRIGGERS: [string, string][] = [
  ['created', 'An item is created'],
  ['state_changed', 'An item moves to another state'],
  ['field_changed', 'A field changes'],
  ['commented', 'Someone comments'],
  ['scheduled', 'Every day at a set hour'],
];
const FIELDS: [string, string][] = [['priority', 'Priority'], ['assignee', 'Assignee'], ['sprint', 'Sprint'], ['severity', 'Severity'], ['type', 'Type'], ['points', 'Story points'], ['labels', 'Labels'], ['due', 'Due date']];
const CATEGORY: [string, string][] = [['todo', 'To do'], ['in_progress', 'In progress'], ['review', 'Review'], ['blocked', 'Blocked'], ['done', 'Done'], ['cancelled', 'Cancelled']];
const ACTIONS: [string, string][] = [
  ['transition', 'Move to state'],
  ['set', 'Set a field'],
  ['assign', 'Assign'],
  ['comment', 'Add a comment'],
  ['notify', 'Notify people (app + email)'],
  ['chat', 'Post to Teams / Slack / Google Chat'],
  ['create_child', 'Create a child item'],
  ['watch', 'Add watchers'],
];
const SET_FIELDS: [string, string][] = [
  ['priority', 'Priority'],
  ['severity', 'Severity'],
  ['points', 'Story points'],
  ['sprint', 'Sprint (active / next)'],
  ['due_in_days', 'Due in … days'],
  ['add_label', 'Add label'],
  ['remove_label', 'Remove label'],
  ['add_component', 'Add component'],
  ['type', 'Type'],
];
const ASSIGN: [string, string][] = [['user', 'A person'], ['reporter', 'The reporter'], ['component_lead', 'The component lead'], ['round_robin', 'Round-robin across the team'], ['least_busy', 'Whoever has least open work'], ['unassign', 'Nobody (unassign)']];
const SMART = '{{key}} {{summary}} {{type}} {{state}} {{priority}} {{assignee}} {{reporter}} {{project}} {{link}} {{due}}';

function blankAction(type: string): Json {
  switch (type) {
    case 'transition':
      return { type, to: '' };
    case 'set':
      return { type, field: 'priority', value: 'high' };
    case 'assign':
      return { type, mode: 'least_busy', userId: null };
    case 'comment':
      return { type, body: '' };
    case 'notify':
      return { type, to: ['assignee'], userIds: [], title: '{{key}}: {{summary}}', body: '' };
    case 'chat':
      return { type, integrationId: '', message: '{{key}} {{summary}} — {{state}}' };
    case 'create_child':
      return { type, workType: 'subtask', name: '', assignToParent: true };
    default:
      return { type: 'watch', userIds: [] };
  }
}

function describeRule(r: Json, states: Map<string, string>): string {
  const c = r.trigger_config ?? {};
  const types = c.types?.length ? ` (${c.types.join(', ')})` : '';
  const when =
    r.trigger === 'created'
      ? `When an item${types} is created`
      : r.trigger === 'state_changed'
        ? `When an item${types} moves${c.fromState ? ` from ${states.get(c.fromState) ?? c.fromState}` : ''}${c.toState ? ` to ${states.get(c.toState) ?? c.toState}` : c.toCategory ? ` to ${CATEGORY.find((x) => x[0] === c.toCategory)?.[1] ?? c.toCategory}` : ''}`
        : r.trigger === 'field_changed'
          ? `When ${FIELDS.find((f) => f[0] === c.field)?.[1] ?? 'a field'} changes${c.to ? ` to ${c.to}` : ''}`
          : r.trigger === 'commented'
            ? 'When someone comments'
            : `Every day at ${String(c.hour ?? 9).padStart(2, '0')}:00`;
  const then = (r.actions as Json[]).map((a) => ACTIONS.find((x) => x[0] === a.type)?.[1].toLowerCase() ?? a.type).join(', ');
  return `${when}${r.condition ? ` and it matches “${r.condition}”` : ''} → ${then}`;
}

export function AutomationTab({ id, manage }: { id: string; manage: boolean }) {
  const { data, refetch } = useQuery({ queryKey: ['work', id, 'rules'], queryFn: () => get<Json>(`/api/v1/projects/${id}/work/rules`) });
  const { data: setup } = useWorkSetup(id);
  const [edit, setEdit] = useState<Json | null>(null);
  const run = useRun();
  if (!data || !setup) return <Spinner />;
  const states = new Map<string, string>();
  for (const w of setup.workflows?.length ? setup.workflows : [setup.defaultWorkflow]) for (const s of w.states) states.set(s.key, s.label);
  const can = data.canEdit && manage;
  return (
    <div className="stack">
      <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
        <div>
          <h2 style={{ margin: 0 }}>Automation</h2>
          <p className="muted small" style={{ margin: 0 }}>
            When something happens to a work item, and it matches a query, do things — move it, assign it, set fields, comment, notify, post to chat, create sub-tasks.
          </p>
        </div>
        {can && (
          <button className="btn primary" onClick={() => setEdit({ name: '', enabled: true, trigger: 'state_changed', triggerConfig: {}, condition: '', actions: [blankAction('assign')] })}>
            + New rule
          </button>
        )}
      </div>
      {!data.rules.length ? (
        <Empty title="No rules yet">Start from a template under Work setup, or add one: for example “when a bug is critical, assign the component lead and notify the watchers”.</Empty>
      ) : (
        <div className="stack" style={{ gap: 8 }}>
          {(data.rules as Json[]).map((r) => (
            <div key={r.id} className={`panel rule-card ${r.enabled ? '' : 'off'}`}>
              <div className="panel-body row" style={{ justifyContent: 'space-between', gap: 10, alignItems: 'flex-start' }}>
                <div style={{ minWidth: 0 }}>
                  <strong>{r.name}</strong> {!r.enabled && <span className="chip">Off</span>}
                  <div className="small">{describeRule(r, states)}</div>
                  <div className="muted small">
                    Ran {r.run_count} {r.run_count === 1 ? 'time' : 'times'}
                    {r.last_run_at && ` · last ${date(r.last_run_at)}`}
                    {r.last_error && <span className="bad-text"> · {r.last_error}</span>}
                  </div>
                </div>
                {can && (
                  <div className="row" style={{ gap: 6, flexShrink: 0 }}>
                    <label className="row small" style={{ gap: 4 }}>
                      <input type="checkbox" checked={r.enabled} onChange={async (e) => (await run(() => put(`/api/v1/projects/${id}/work/rules/${r.id}`, { name: r.name, enabled: e.target.checked, trigger: r.trigger, triggerConfig: r.trigger_config, condition: r.condition, actions: r.actions }))) !== null && refetch()} /> On
                    </label>
                    <button
                      className="btn small"
                      onClick={async () => {
                        const key = r.trigger === 'scheduled' ? '' : window.prompt('Run on which item? (key, e.g. FLEET-12)') ?? null;
                        if (key === null) return;
                        const out = await run(() => post<Json>(`/api/v1/projects/${id}/work/rules/${r.id}/run`, { key: key || null }));
                        if (out) refetch();
                      }}
                    >
                      Run now
                    </button>
                    <button className="btn small" onClick={() => setEdit({ id: r.id, name: r.name, enabled: r.enabled, trigger: r.trigger, triggerConfig: r.trigger_config ?? {}, condition: r.condition ?? '', actions: r.actions })}>
                      Edit
                    </button>
                    <button className="btn small danger" onClick={async () => window.confirm(`Delete the rule “${r.name}”?`) && (await run(() => del(`/api/v1/projects/${id}/work/rules/${r.id}`), 'Deleted')) !== null && refetch()}>
                      Delete
                    </button>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
      {(data.runs as Json[]).length > 0 && (
        <section>
          <h3 className="section-label">Recent runs</h3>
          <table className="data compact">
            <tbody>
              {(data.runs as Json[]).map((x) => (
                <tr key={x.id}>
                  <td className="small nowrap">{new Date(x.at).toLocaleString()}</td>
                  <td className="small">{(data.rules as Json[]).find((r) => r.id === x.rule_id)?.name ?? 'Rule'}</td>
                  <td className="mono small">{x.task_number ? `${x.work_key ?? ''}-${x.task_number}` : ''}</td>
                  <td>
                    <span className={`chip ${x.status === 'done' ? 'good' : 'bad'}`}>{x.status === 'done' ? 'Done' : 'Error'}</span>
                  </td>
                  <td className="small" style={{ whiteSpace: 'normal' }}>
                    {x.detail}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
      {edit && <RuleEditor projectId={id} rule={edit} states={states} onClose={() => setEdit(null)} onSaved={() => (setEdit(null), refetch())} />}
    </div>
  );
}

function RuleEditor({ projectId, rule, states, onClose, onSaved }: { projectId: string; rule: Json; states: Map<string, string>; onClose: () => void; onSaved: () => void }) {
  const [r, setR] = useState<Json>(rule);
  const team = useTeam(projectId);
  const { data: setup } = useWorkSetup(projectId);
  const { data: chats } = useQuery({ queryKey: ['chat-connections'], queryFn: () => get<Json>('/api/admin/integrations'), retry: false, staleTime: 60_000 });
  const chatList = ((chats?.items ?? []) as Json[]).filter((i) => ['teams', 'slack', 'gchat'].includes(i.provider));
  const run = useRun();
  const c = r.triggerConfig ?? {};
  const setC = (x: Json) => setR({ ...r, triggerConfig: { ...c, ...x } });
  const setA = (i: number, x: Json) => setR({ ...r, actions: (r.actions as Json[]).map((a, j) => (j === i ? { ...a, ...x } : a)) });
  const stateOpts = [...states.entries()];
  const save = async () => {
    const body = {
      name: r.name.trim(),
      enabled: r.enabled,
      trigger: r.trigger,
      triggerConfig: Object.fromEntries(Object.entries(c).filter(([, v]) => v !== '' && v !== null && !(Array.isArray(v) && !v.length))),
      condition: r.condition?.trim() || null,
      actions: (r.actions as Json[]).map((a) => (a.type === 'set' && ['points', 'due_in_days'].includes(a.field) ? { ...a, value: a.value === '' ? null : Number(a.value) } : a)),
    };
    const out = await run(() => (r.id ? put(`/api/v1/projects/${projectId}/work/rules/${r.id}`, body) : post(`/api/v1/projects/${projectId}/work/rules`, body)), 'Rule saved');
    if (out) onSaved();
  };
  return (
    <Modal
      title={r.id ? 'Edit rule' : 'New automation rule'}
      onClose={onClose}
      wide
      footer={
        <button className="btn primary" disabled={!r.name.trim() || !r.actions.length} onClick={save}>
          Save rule
        </button>
      }
    >
      <div className="modal-body stack">
        <label className="field">
          Name
          <input autoFocus value={r.name} onChange={(e) => setR({ ...r, name: e.target.value })} placeholder="Critical bugs go to the component lead" />
        </label>
        <fieldset className="rule-step">
          <legend>When</legend>
          <select value={r.trigger} onChange={(e) => setR({ ...r, trigger: e.target.value, triggerConfig: e.target.value === 'scheduled' ? { hour: 9 } : {} })} aria-label="Trigger">
            {TRIGGERS.map(([k, l]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </select>
          {r.trigger !== 'scheduled' && (
            <div className="row small" style={{ gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
              <span className="muted">Item types:</span>
              {TYPES.map(([t, l]) => (
                <label key={t} className="row" style={{ gap: 3 }}>
                  <input type="checkbox" checked={(c.types ?? []).includes(t)} onChange={(e) => setC({ types: e.target.checked ? [...(c.types ?? []), t] : (c.types ?? []).filter((x: string) => x !== t) })} /> {l}
                </label>
              ))}
              <span className="muted">(none ticked = all)</span>
            </div>
          )}
          {r.trigger === 'state_changed' && (
            <div className="grid2" style={{ marginTop: 6 }}>
              <label className="field">
                From state
                <select value={c.fromState ?? ''} onChange={(e) => setC({ fromState: e.target.value || null })}>
                  <option value="">Any</option>
                  {stateOpts.map(([k, l]) => (
                    <option key={k} value={k}>
                      {l}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                To state
                <select value={c.toState ? `s:${c.toState}` : c.toCategory ? `c:${c.toCategory}` : ''} onChange={(e) => setC({ toState: e.target.value.startsWith('s:') ? e.target.value.slice(2) : null, toCategory: e.target.value.startsWith('c:') ? e.target.value.slice(2) : null })}>
                  <option value="">Any</option>
                  <optgroup label="Any state that is…">
                    {CATEGORY.map(([k, l]) => (
                      <option key={k} value={`c:${k}`}>
                        {l}
                      </option>
                    ))}
                  </optgroup>
                  <optgroup label="Exactly">
                    {stateOpts.map(([k, l]) => (
                      <option key={k} value={`s:${k}`}>
                        {l}
                      </option>
                    ))}
                  </optgroup>
                </select>
              </label>
            </div>
          )}
          {r.trigger === 'field_changed' && (
            <div className="grid2" style={{ marginTop: 6 }}>
              <label className="field">
                Field
                <select value={c.field ?? ''} onChange={(e) => setC({ field: e.target.value || null })}>
                  <option value="">Any of them</option>
                  {FIELDS.map(([k, l]) => (
                    <option key={k} value={k}>
                      {l}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                Changed to (optional)
                <input value={c.to ?? ''} onChange={(e) => setC({ to: e.target.value || null })} placeholder="e.g. urgent" />
              </label>
            </div>
          )}
          {r.trigger === 'scheduled' && (
            <label className="field" style={{ marginTop: 6, maxWidth: 220 }}>
              Hour (IST)
              <select value={c.hour ?? 9} onChange={(e) => setC({ hour: Number(e.target.value) })}>
                {Array.from({ length: 24 }, (_, h) => (
                  <option key={h} value={h}>
                    {String(h).padStart(2, '0')}:00
                  </option>
                ))}
              </select>
            </label>
          )}
        </fieldset>
        <fieldset className="rule-step">
          <legend>If (optional)</legend>
          <input className="mono" value={r.condition ?? ''} onChange={(e) => setR({ ...r, condition: e.target.value })} placeholder={r.trigger === 'scheduled' ? 'Required: status != done and due < 0d' : 'type = bug and severity = critical'} />
          <div className="muted small">A work query (the same language as Queries). {r.trigger === 'scheduled' ? 'The rule runs on each item it finds (up to 200).' : 'The rule runs only for items it matches.'}</div>
        </fieldset>
        <fieldset className="rule-step">
          <legend>Then</legend>
          <div className="stack" style={{ gap: 8 }}>
            {(r.actions as Json[]).map((a, i) => (
              <div key={i} className="rule-action">
                <div className="row" style={{ gap: 6 }}>
                  <select value={a.type} onChange={(e) => setR({ ...r, actions: (r.actions as Json[]).map((x, j) => (j === i ? blankAction(e.target.value) : x)) })} aria-label="Action">
                    {ACTIONS.map(([k, l]) => (
                      <option key={k} value={k}>
                        {l}
                      </option>
                    ))}
                  </select>
                  <button type="button" className="link-btn small" onClick={() => setR({ ...r, actions: (r.actions as Json[]).filter((_, j) => j !== i) })}>
                    Remove
                  </button>
                </div>
                {a.type === 'transition' && (
                  <select value={a.to} onChange={(e) => setA(i, { to: e.target.value })} aria-label="State">
                    <option value="">Choose a state…</option>
                    {stateOpts.map(([k, l]) => (
                      <option key={k} value={k}>
                        {l}
                      </option>
                    ))}
                  </select>
                )}
                {a.type === 'set' && (
                  <div className="row" style={{ gap: 6 }}>
                    <select value={a.field} onChange={(e) => setA(i, { field: e.target.value, value: '' })} aria-label="Field">
                      {SET_FIELDS.map(([k, l]) => (
                        <option key={k} value={k}>
                          {l}
                        </option>
                      ))}
                    </select>
                    {a.field === 'priority' ? (
                      <select value={a.value ?? ''} onChange={(e) => setA(i, { value: e.target.value })} aria-label="Value">
                        {['low', 'medium', 'high', 'urgent'].map((p) => (
                          <option key={p}>{p}</option>
                        ))}
                      </select>
                    ) : a.field === 'severity' ? (
                      <select value={a.value ?? ''} onChange={(e) => setA(i, { value: e.target.value })} aria-label="Value">
                        {['minor', 'major', 'critical', 'blocker'].map((p) => (
                          <option key={p}>{p}</option>
                        ))}
                      </select>
                    ) : a.field === 'sprint' ? (
                      <select value={a.value ?? 'active'} onChange={(e) => setA(i, { value: e.target.value || null })} aria-label="Value">
                        <option value="active">The active sprint</option>
                        <option value="next">The next sprint</option>
                        <option value="">No sprint (backlog)</option>
                      </select>
                    ) : a.field === 'type' ? (
                      <select value={a.value ?? ''} onChange={(e) => setA(i, { value: e.target.value })} aria-label="Value">
                        {TYPES.map(([t, l]) => (
                          <option key={t} value={t}>
                            {l}
                          </option>
                        ))}
                      </select>
                    ) : a.field === 'add_component' ? (
                      <select value={a.value ?? ''} onChange={(e) => setA(i, { value: e.target.value })} aria-label="Value">
                        <option value="">Choose…</option>
                        {((setup?.components ?? []) as Json[]).map((x) => (
                          <option key={x.id} value={x.id}>
                            {x.name}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input value={a.value ?? ''} type={['points', 'due_in_days'].includes(a.field) ? 'number' : 'text'} onChange={(e) => setA(i, { value: e.target.value })} aria-label="Value" />
                    )}
                  </div>
                )}
                {a.type === 'assign' && (
                  <div className="row" style={{ gap: 6 }}>
                    <select value={a.mode} onChange={(e) => setA(i, { mode: e.target.value })} aria-label="Assign to">
                      {ASSIGN.map(([k, l]) => (
                        <option key={k} value={k}>
                          {l}
                        </option>
                      ))}
                    </select>
                    {a.mode === 'user' && (
                      <select value={a.userId ?? ''} onChange={(e) => setA(i, { userId: e.target.value || null })} aria-label="Person">
                        <option value="">Choose…</option>
                        {team.map(([uid, n]) => (
                          <option key={uid} value={uid}>
                            {n}
                          </option>
                        ))}
                      </select>
                    )}
                  </div>
                )}
                {a.type === 'comment' && <textarea rows={2} value={a.body} onChange={(e) => setA(i, { body: e.target.value })} placeholder="Moved to {{state}} — please verify the fix." />}
                {a.type === 'notify' && (
                  <div className="stack" style={{ gap: 4 }}>
                    <div className="row small" style={{ gap: 8, flexWrap: 'wrap' }}>
                      {(['assignee', 'reporter', 'watchers', 'manager'] as const).map((t) => (
                        <label key={t} className="row" style={{ gap: 3 }}>
                          <input type="checkbox" checked={a.to.includes(t)} onChange={(e) => setA(i, { to: e.target.checked ? [...a.to, t] : a.to.filter((x: string) => x !== t) })} /> {t === 'manager' ? 'project manager' : t}
                        </label>
                      ))}
                    </div>
                    <PeoplePick team={team} value={a.userIds ?? []} onChange={(v) => setA(i, { userIds: v })} label="Also notify" />
                    <input value={a.title ?? ''} onChange={(e) => setA(i, { title: e.target.value })} placeholder="Title" aria-label="Title" />
                    <textarea rows={2} value={a.body ?? ''} onChange={(e) => setA(i, { body: e.target.value })} placeholder="Message (optional)" aria-label="Message" />
                  </div>
                )}
                {a.type === 'chat' && (
                  <div className="stack" style={{ gap: 4 }}>
                    {chatList.length ? (
                      <select value={a.integrationId} onChange={(e) => setA(i, { integrationId: e.target.value })} aria-label="Channel">
                        <option value="">Choose a channel…</option>
                        {chatList.map((x) => (
                          <option key={x.id} value={x.id}>
                            {x.provider === 'teams' ? 'Teams' : x.provider === 'slack' ? 'Slack' : 'Google Chat'} · {x.label}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <span className="muted small">Connect Teams, Slack or Google Chat in Settings → Integrations (an admin can).</span>
                    )}
                    <input value={a.message} onChange={(e) => setA(i, { message: e.target.value })} aria-label="Message" />
                  </div>
                )}
                {a.type === 'create_child' && (
                  <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                    <select value={a.workType} onChange={(e) => setA(i, { workType: e.target.value })} aria-label="Type">
                      {TYPES.filter(([t]) => ['subtask', 'task', 'story', 'bug'].includes(t)).map(([t, l]) => (
                        <option key={t} value={t}>
                          {l}
                        </option>
                      ))}
                    </select>
                    <input style={{ flex: 1, minWidth: 160 }} value={a.name} onChange={(e) => setA(i, { name: e.target.value })} placeholder="Write tests for {{key}}" aria-label="Name" />
                    <label className="row small" style={{ gap: 3 }}>
                      <input type="checkbox" checked={!!a.assignToParent} onChange={(e) => setA(i, { assignToParent: e.target.checked })} /> same assignee
                    </label>
                  </div>
                )}
                {a.type === 'watch' && <PeoplePick team={team} value={a.userIds ?? []} onChange={(v) => setA(i, { userIds: v })} label="Watchers" />}
              </div>
            ))}
            {r.actions.length < 10 && (
              <div>
                <button type="button" className="btn small" onClick={() => setR({ ...r, actions: [...r.actions, blankAction('comment')] })}>
                  + Another action
                </button>
              </div>
            )}
          </div>
          <div className="muted small" style={{ marginTop: 6 }}>
            In texts you can use <span className="mono">{SMART}</span>
          </div>
        </fieldset>
      </div>
    </Modal>
  );
}

function PeoplePick({ team, value, onChange, label }: { team: [string, string][]; value: string[]; onChange: (v: string[]) => void; label: string }) {
  return (
    <div className="row small" style={{ gap: 6, flexWrap: 'wrap' }}>
      <span className="muted">{label}:</span>
      {team.map(([uid, n]) => (
        <label key={uid} className="row" style={{ gap: 3 }}>
          <input type="checkbox" checked={value.includes(uid)} onChange={(e) => onChange(e.target.checked ? [...value, uid] : value.filter((x) => x !== uid))} /> {n}
        </label>
      ))}
    </div>
  );
}

/* ───────────────────────── project templates ───────────────────────── */

export function TemplatesSection({ id, manage }: { id: string; manage: boolean }) {
  const { data, refetch } = useQuery({ queryKey: ['work-templates'], queryFn: () => get<Json[]>('/api/v1/work/templates') });
  const qc = useQueryClient();
  const [pick, setPick] = useState('');
  const [result, setResult] = useState<Json | null>(null);
  const run = useRun();
  if (!data || !manage) return null;
  const chosen = data.find((t) => t.id === pick);
  return (
    <section>
      <h3 className="section-label">Templates</h3>
      <p className="muted small" style={{ marginTop: 0 }}>
        Copy workflows, fields, components, boards, dashboards, saved queries and automation from a template — or save this project’s setup as one. Anything the project already has with the same name is kept.
      </p>
      <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
        <select value={pick} onChange={(e) => setPick(e.target.value)} aria-label="Template" style={{ minWidth: 240 }}>
          <option value="">Choose a template…</option>
          <optgroup label="Built in">
            {data
              .filter((t) => t.builtIn)
              .map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
          </optgroup>
          {data.some((t) => !t.builtIn) && (
            <optgroup label="This workspace">
              {data
                .filter((t) => !t.builtIn)
                .map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
            </optgroup>
          )}
        </select>
        <button
          className="btn small primary"
          disabled={!pick}
          onClick={async () => {
            if (!window.confirm(`Apply “${chosen?.name}” to this project?`)) return;
            const r = await run(() => post<Json>(`/api/v1/projects/${id}/work/templates/apply`, { templateId: pick }), 'Template applied');
            if (r) (setResult(r), qc.invalidateQueries({ queryKey: ['work', id] }));
          }}
        >
          Apply
        </button>
        <button
          className="btn small"
          onClick={async () => {
            const name = window.prompt('Name for the template (e.g. “Client delivery — Scrum”)');
            if (!name?.trim()) return;
            const r = await run(() => post(`/api/v1/projects/${id}/work/templates`, { name: name.trim() }), 'Saved as a template');
            if (r) refetch();
          }}
        >
          Save this setup as a template
        </button>
        {chosen && !chosen.builtIn && (
          <button className="link-btn small" onClick={async () => window.confirm(`Delete the template “${chosen.name}”?`) && (await run(() => del(`/api/v1/work/templates/${chosen.id}`), 'Deleted')) !== null && (setPick(''), refetch())}>
            Delete template
          </button>
        )}
      </div>
      {chosen?.description && <p className="small muted">{chosen.description}</p>}
      {chosen?.summary && (
        <p className="small muted">
          Brings: {Object.entries(chosen.summary as Record<string, number>).filter(([, n]) => n > 0).map(([k, n]) => `${n} ${k}`).join(', ')}
        </p>
      )}
      {result && (
        <div className="callout small" style={{ marginTop: 8 }}>
          Added: {Object.entries(result).filter(([k, n]) => k !== 'skipped' && Number(n) > 0).map(([k, n]) => `${n} ${k}`).join(', ') || 'nothing new'}
          {(result.skipped ?? []).length > 0 && <div className="muted">Kept the project’s own: {(result.skipped as string[]).join(', ')}</div>}
        </div>
      )}
    </section>
  );
}

/* ───────────────────────── email alerts (My account) ───────────────────────── */

const MODES: [string, string][] = [['instant', 'Right away'], ['digest', 'Daily digest'], ['off', 'Off']];

export function WorkAlertPrefs() {
  const { data, refetch } = useQuery({ queryKey: ['work-alert-prefs'], queryFn: () => get<Json>('/api/v1/work/alerts/prefs'), retry: false });
  const run = useRun();
  if (!data) return null;
  const save = async (x: Json) => (await run(() => put('/api/v1/work/alerts/prefs', x), 'Saved')) !== null && refetch();
  const row = (k: string, label: string, help: string, modes = MODES) => (
    <tr key={k}>
      <td>
        {label}
        <div className="muted small">{help}</div>
      </td>
      <td>
        <div className="seg small">
          {modes.map(([m, l]) => (
            <button key={m} className={data[k] === m ? 'on' : ''} onClick={() => save({ [k]: m })}>
              {l}
            </button>
          ))}
        </div>
      </td>
    </tr>
  );
  return (
    <section className="panel">
      <div className="panel-head">
        <h3 style={{ margin: 0 }}>Work item emails</h3>
      </div>
      <div className="panel-body stack">
        {!data.emailOn && (
          <div className="callout warn small">
            <SetUpKeysLink group="mail">Email sending is not set up yet — you get these in the app only.</SetUpKeysLink>
          </div>
        )}
        <table className="data compact">
          <tbody>
            {row('assigned', 'Assigned to me', 'An item is assigned to you')}
            {row('mentioned', 'Mentions', 'Someone @mentions you in a comment or description')}
            {row('watching', 'Items I watch', 'Comments and changes on items you watch or reported')}
            {row('due', 'Due and overdue', 'Your items due tomorrow or overdue', [['digest', 'Daily digest'], ['off', 'Off']])}
          </tbody>
        </table>
        <label className="field" style={{ maxWidth: 220 }}>
          Daily digest at (IST)
          <select value={data.digestHour} onChange={(e) => save({ digestHour: Number(e.target.value) })}>
            {Array.from({ length: 24 }, (_, h) => (
              <option key={h} value={h}>
                {String(h).padStart(2, '0')}:00
              </option>
            ))}
          </select>
        </label>
      </div>
    </section>
  );
}

/* ───────────────────────── GitHub App & the repository rule (workspace) ───────────────────────── */

export function GitHubAppSection() {
  const { data, refetch } = useQuery({ queryKey: ['github-app'], queryFn: () => get<Json>('/api/admin/work/github'), retry: false });
  const { data: policy, refetch: refetchPolicy } = useQuery({ queryKey: ['work-policy'], queryFn: () => get<Json>('/api/admin/work/policy'), retry: false });
  const run = useRun();
  if (!data && !policy) return null;
  return (
    <section>
      <h3 className="section-label">GitHub App (whole workspace)</h3>
      {data && !data.configured ? (
        <div className="callout small">
          <SetUpKeysLink group="github_app">The GitHub App is not set up yet (its app ID, slug, private key and webhook secret). Until then, link repositories by name and use the webhook connections below.</SetUpKeysLink>
        </div>
      ) : data ? (
        <div className="stack" style={{ gap: 6 }}>
          <p className="muted small" style={{ margin: 0 }}>
            Installed on your GitHub organisation, SanchalanOS lists its repositories to pick from, posts a “SanchalanOS work items” check on every pull request, can make that check required on the main branch, and creates branches from work items.
          </p>
          {(data.installations as Json[]).map((i) => (
            <div key={i.id} className="row small" style={{ gap: 8 }}>
              <span>
                <strong>{i.account}</strong> <span className="muted">({i.account_type ?? 'account'})</span>
              </span>
              {i.suspended_at ? <span className="chip warn">Suspended in GitHub</span> : <span className="chip good">Connected</span>}
              <button className="link-btn small" onClick={async () => window.confirm(`Disconnect ${i.account}?`) && (await run(() => del<Json>(`/api/admin/work/github/${i.id}`), 'Disconnected')) !== null && refetch()}>
                Disconnect
              </button>
            </div>
          ))}
          <div>
            <button className="btn small" onClick={async () => { const r = await run(() => post<Json>('/api/admin/work/github/install', {})); if (r?.url) window.location.href = r.url; }}>
              {(data.installations as Json[]).length ? 'Install on another organisation' : 'Install the GitHub App'}
            </button>
          </div>
        </div>
      ) : null}
      {policy && (
        <label className="row small" style={{ gap: 6, marginTop: 10, alignItems: 'flex-start' }}>
          <input type="checkbox" checked={!!policy.requireRepo} onChange={async (e) => (await run(() => put('/api/admin/work/policy', { requireRepo: e.target.checked }), 'Saved')) !== null && refetchPolicy()} />
          <span>
            <strong>Every project must have a repository.</strong> Work items can’t be created in an active project until its GitHub or Azure DevOps repository is linked. Projects marked “no code” (Work setup → General) are exempt.
          </span>
        </label>
      )}
    </section>
  );
}

/**
 * Every repository the GitHub App can see, as a searchable list to tick: the ones ticked are linked
 * together. Repositories already on this project show as linked; ones on another project can't be
 * picked (a repository belongs to one project).
 */
export function AppRepoPicker({ projectId, picked, onChange }: { projectId: string; picked: Json[]; onChange: (r: Json[]) => void }) {
  const { data, error, isLoading, refetch, isFetching } = useQuery({ queryKey: ['github-app-repo-list'], queryFn: () => get<Json>('/api/v1/work/github/repo-list'), retry: false, staleTime: 30_000 });
  const [q, setQ] = useState('');
  if (isLoading) return <span className="muted small">Loading repositories from GitHub…</span>;
  if (error) return <div className="callout warn small">GitHub didn’t list the repositories: {(error as Error).message}</div>;
  const repos = (data?.repos ?? []) as Json[];
  const insts = (data?.installations ?? []) as Json[];
  if (!insts.length) return <div className="callout small">Install the SanchalanOS GitHub App (Work setup → GitHub App) to pick repositories from a list — or type one below.</div>;
  const ql = q.trim().toLowerCase();
  const list = repos.filter((r) => !ql || r.fullName.toLowerCase().includes(ql));
  const isPicked = (r: Json) => picked.some((x) => x.fullName === r.fullName);
  const free = list.filter((r) => !r.linkedTo);
  const toggle = (r: Json) => onChange(isPicked(r) ? picked.filter((x) => x.fullName !== r.fullName) : [...picked, r]);
  return (
    <div className="field">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <span>
          Repositories on GitHub <span className="muted small">({repos.length})</span>
        </span>
        <button type="button" className="link-btn small" disabled={isFetching} onClick={() => refetch()}>
          {isFetching ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Search ${repos.length} repositories…`} />
      <div className="repo-pick" style={{ maxHeight: 280, overflowY: 'auto' }}>
        {free.length > 1 && (
          <label className="repo-opt row small" style={{ gap: 8 }}>
            <input type="checkbox" checked={free.every(isPicked)} onChange={(e) => onChange(e.target.checked ? [...picked.filter((x) => !free.some((f) => f.fullName === x.fullName)), ...free] : picked.filter((x) => !free.some((f) => f.fullName === x.fullName)))} />
            <b>All {ql ? 'shown' : 'not yet linked'} ({free.length})</b>
          </label>
        )}
        {list.map((r) => {
          const here = r.linkedTo?.projectId === projectId;
          return (
            <label key={r.fullName} className="repo-opt row small" style={{ gap: 8, opacity: r.linkedTo ? 0.65 : 1 }} title={r.linkedTo ? (here ? 'Already linked to this project' : `Linked to ${r.linkedTo.name}`) : ''}>
              <input type="checkbox" checked={here || isPicked(r)} disabled={!!r.linkedTo} onChange={() => toggle(r)} />
              <span className="mono">{r.fullName}</span>
              {r.private && <span className="chip">private</span>}
              {here ? <span className="chip good">linked</span> : r.linkedTo ? <span className="muted">· {r.linkedTo.name}</span> : null}
            </label>
          );
        })}
        {!list.length && <span className="muted small">No repository matches “{q}”.</span>}
      </div>
      {insts.map((i) => (
        <div key={i.installationId} className="small muted">
          {i.error ? <span style={{ color: 'var(--bad)' }}>{i.account}: {i.error}. </span> : `${i.account}: ${i.repos} repositor${i.repos === 1 ? 'y' : 'ies'}. `}
          Missing one?{' '}
          <a href={i.manageUrl} target="_blank" rel="noreferrer">
            Choose which repositories the app can see on GitHub
          </a>{' '}
          (“All repositories”, or add it to “Only select repositories”), then Refresh.
        </div>
      ))}
    </div>
  );
}

export function RequireCheckButton({ projectId, repo }: { projectId: string; repo: Json }) {
  const run = useRun();
  if (repo.provider !== 'github' || !repo.installation_id) return null;
  return (
    <button
      className="link-btn small"
      title="Make “SanchalanOS work items” a required status check on the main branch"
      onClick={async () => {
        if (!window.confirm(`Make the SanchalanOS check required on ${repo.repo} (${repo.default_branch})? Pull requests that don’t name a work item can’t be merged.`)) return;
        const r = await run(() => post<Json>(`/api/v1/projects/${projectId}/work/repos/${repo.id}/require-check`, {}));
        if (r) window.alert(r.already ? 'The check is already required.' : 'Done — the check is now required on the main branch.');
      }}
    >
      Require check
    </button>
  );
}

export function CreateBranch({ projectId, itemId, branchName }: { projectId: string; itemId: string; branchName: string }) {
  const { data } = useQuery({ queryKey: ['work', projectId, 'repos'], queryFn: () => get<Json>(`/api/v1/projects/${projectId}/work/repos`), staleTime: 60_000 });
  const repos = ((data?.repos ?? []) as Json[]).filter((r) => r.provider === 'github' && r.installation_id);
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ repoId: '', name: branchName });
  const qc = useQueryClient();
  const run = useRun();
  if (!repos.length) return null;
  return (
    <>
      <button className="btn small" onClick={() => (setF({ repoId: repos[0]!.id, name: branchName }), setOpen(true))}>
        Create branch in GitHub
      </button>
      {open && (
        <Modal
          title="Create a branch"
          onClose={() => setOpen(false)}
          footer={
            <button
              className="btn primary"
              disabled={!f.name.trim() || !f.repoId}
              onClick={async () => {
                const r = await run(() => post<Json>(`/api/v1/projects/${projectId}/work/items/${itemId}/branch`, f), 'Branch created');
                if (r) (setOpen(false), qc.invalidateQueries({ queryKey: ['work', projectId, 'item', itemId] }), window.open(r.url, '_blank', 'noopener'));
              }}
            >
              Create
            </button>
          }
        >
          <div className="modal-body stack">
            <label className="field">
              Repository
              <select value={f.repoId} onChange={(e) => setF({ ...f, repoId: e.target.value })}>
                {repos.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.repo}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              Branch name
              <input className="mono" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
            </label>
            <span className="muted small">Made from the head of the main branch; it is linked to this item straight away.</span>
          </div>
        </Modal>
      )}
    </>
  );
}

/* ───────────────────────── reports ───────────────────────── */

export function SprintReportView({ d, onOpen }: { d: Json; onOpen: (id: string) => void }) {
  if (!d.sprint) return <p className="muted small">No active or closed sprint yet.</p>;
  const t = d.totals;
  const items = d.items as Json[];
  const group = (label: string, f: (i: Json) => boolean) => {
    const xs = items.filter(f);
    if (!xs.length) return null;
    return (
      <>
        <tr>
          <th colSpan={3} className="section-label" style={{ paddingTop: 8 }}>
            {label} · {xs.length}
          </th>
        </tr>
        {xs.map((i) => (
          <tr key={i.id} className="click" onClick={() => onOpen(i.id)}>
            <td className="nowrap">
              {typeIcon(i.workType)} <span className="mono small">{i.key}</span>
            </td>
            <td style={{ whiteSpace: 'normal' }}>
              {i.name} {i.added && <span className="chip info">added</span>}
            </td>
            <td className="num small">{i.points ?? '—'}</td>
          </tr>
        ))}
      </>
    );
  };
  return (
    <div className="stack">
      <div className="muted small">
        {d.sprint.name} · {date(d.sprint.start)} – {date(d.sprint.end)} · {d.sprint.status}
      </div>
      <div className="row" style={{ gap: 16, flexWrap: 'wrap' }}>
        <Num label="Committed" v={t.committed} />
        <Num label="Added" v={t.added} />
        <Num label="Removed" v={t.removed} />
        <Num label="Completed" v={t.completed} />
        <Num label="Not completed" v={t.notCompleted} />
      </div>
      <Chart id="sprint-report" height={150} initial="bar" switcher={false} data={{ categories: ['Committed', 'Added', 'Removed', 'Completed', 'Not completed'], series: [{ label: 'Points', values: [t.committed, t.added, t.removed, t.completed, t.notCompleted] }] }} />
      <table className="data compact">
        <tbody>
          {group('Completed', (i) => i.done)}
          {group('Not completed', (i) => !i.done && !i.removed)}
          {group('Removed from the sprint', (i) => i.removed)}
        </tbody>
      </table>
    </div>
  );
}

function Num({ label, v }: { label: string; v: number }) {
  return (
    <div>
      <div className="muted small">{label}</div>
      <div style={{ fontSize: 18, fontWeight: 700 }}>{v} pts</div>
    </div>
  );
}

export function TimeInStatusView({ d, id }: { d: Json; id: string }) {
  const states = d.states as Json[];
  const [show, setShow] = useState(false);
  if (!states.length) return <p className="muted small">No state changes in the period.</p>;
  return (
    <div className="stack">
      <Chart id={id} height={200} initial="hbar" data={{ categories: states.map((s) => s.state), series: [{ label: 'Average days', values: states.map((s) => s.avgDays) }] }} />
      <table className="data compact">
        <thead>
          <tr>
            <th>State</th>
            <th className="num">Items</th>
            <th className="num">Average</th>
            <th className="num">Total</th>
          </tr>
        </thead>
        <tbody>
          {states.map((s) => (
            <tr key={s.state}>
              <td>{s.state}</td>
              <td className="num">{s.items}</td>
              <td className="num">{s.avgDays} d</td>
              <td className="num muted">{s.totalDays} d</td>
            </tr>
          ))}
        </tbody>
      </table>
      <button className="link-btn small" onClick={() => setShow(!show)}>
        {show ? 'Hide items' : 'Show items'}
      </button>
      {show && (
        <table className="data compact">
          <tbody>
            {(d.items as Json[]).map((i) => (
              <tr key={i.id}>
                <td className="mono small">{i.key}</td>
                <td style={{ whiteSpace: 'normal' }}>{i.name}</td>
                <td className="small">
                  {Object.entries(i.states as Record<string, number>)
                    .map(([s, v]) => `${s} ${v} d`)
                    .join(' · ')}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export function BurnupView({ d, id }: { d: Json; id: string }) {
  if (!d.release) return <p className="muted small">No release yet.</p>;
  if (!d.days.length) return <p className="muted small">Nothing planned in {d.release.name} yet.</p>;
  const n = d.scope.length;
  const done = d.done as number[];
  const scope = d.scope as number[];
  // the trend to the release date from the last 14 days' pace
  const k = Math.max(0, n - 15);
  const rate = n > 1 ? (done[n - 1]! - done[k]!) / Math.max(1, n - 1 - k) : 0;
  const left = (scope[n - 1] ?? 0) - (done[n - 1] ?? 0);
  const eta = rate > 0 ? new Date(Date.now() + Math.ceil(left / rate) * 86_400_000).toISOString().slice(0, 10) : null;
  return (
    <div className="stack">
      <div className="muted small">
        {d.release.name}
        {d.release.release_date && ` · due ${date(d.release.release_date)}`} · {done[n - 1] ?? 0} of {scope[n - 1] ?? 0} points done
        {left > 0 && (eta ? ` · at the current pace, done about ${date(eta)}` : ' · no progress in the last two weeks')}
      </div>
      <Chart
        id={id}
        height={230}
        initial="line"
        switcher={false}
        data={{ categories: (d.days as string[]).slice(0, n).map((x) => date(x)), series: [{ label: 'Scope', values: scope }, { label: 'Done', values: done }] }}
      />
    </div>
  );
}
