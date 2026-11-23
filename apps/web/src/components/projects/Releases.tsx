/**
 * Releases: the kind (major, minor, patch, hotfix, pre-release, maintenance), the version read from
 * the code and bumped by the kind, the milestone it delivers and the sprints that feed it, release
 * notes — and how it reaches people: a web deployment, a Windows / macOS installer by mail, Google
 * Drive, OneDrive or SharePoint, Google Play, TestFlight and the App Store, each with its checklist.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { del, get, post, put, upload } from '../../lib/api';
import { date } from '../../lib/format';
import { Empty, Modal, Spinner, useToast } from '../ui';

type Json = Record<string, any>;

export const RELEASE_TYPES: [string, string, string][] = [
  ['major', 'Major', 'Big changes; may break what users or other systems rely on (1.4.2 → 2.0.0)'],
  ['minor', 'Minor', 'New features, nothing breaks (1.4.2 → 1.5.0)'],
  ['patch', 'Patch', 'Fixes and small improvements (1.4.2 → 1.4.3)'],
  ['hotfix', 'Hotfix', 'An urgent fix for what is live, out of the usual plan (1.4.2 → 1.4.3)'],
  ['prerelease', 'Pre-release (beta / RC)', 'For testers before the real release (1.5.0-beta.1)'],
  ['maintenance', 'Maintenance', 'Updates of libraries, security, performance — no new features'],
];
const TYPE_CHIP: Record<string, string> = { major: 'bad', minor: 'info', patch: '', hotfix: 'warn', prerelease: '', maintenance: '' };

export const PLATFORM: Record<string, string> = { web: 'Web', windows: 'Windows', macos: 'macOS', linux: 'Linux', android: 'Android', ios: 'iPhone / iPad', api: 'API / backend', other: 'Other' };
export const METHOD: Record<string, string> = {
  deploy: 'Deploy to a server',
  email: 'Send by email',
  google_drive: 'Share on Google Drive',
  onedrive: 'Share on OneDrive',
  sharepoint: 'Share on SharePoint',
  download_link: 'Download link',
  play_store: 'Google Play',
  app_store: 'App Store',
  testflight: 'TestFlight (iOS testers)',
  microsoft_store: 'Microsoft Store',
  other: 'Other',
};
const METHODS_FOR: Record<string, string[]> = {
  web: ['deploy', 'other'],
  api: ['deploy', 'other'],
  windows: ['email', 'onedrive', 'google_drive', 'sharepoint', 'download_link', 'microsoft_store', 'other'],
  macos: ['email', 'google_drive', 'onedrive', 'sharepoint', 'download_link', 'app_store', 'other'],
  linux: ['download_link', 'email', 'google_drive', 'onedrive', 'sharepoint', 'other'],
  android: ['play_store', 'download_link', 'email', 'google_drive', 'other'],
  ios: ['testflight', 'app_store', 'other'],
  other: Object.keys(METHOD),
};
const TARGET_LABEL: Record<string, [string, string]> = {
  deploy: ['Environment', 'e.g. Production — Cloudflare'],
  play_store: ['Track', 'Internal / Closed / Open testing / Production'],
  app_store: ['Release', 'e.g. Manual release after approval'],
  testflight: ['Testers', 'e.g. Internal + client group'],
  email: ['Sent to (group)', 'e.g. FCI Noida accounts team'],
  google_drive: ['Folder', 'e.g. Shared drive / Releases'],
  onedrive: ['Folder', 'e.g. Releases/CPF'],
  sharepoint: ['Site / library', 'e.g. FCI-Projects / Releases'],
  download_link: ['Who may download', 'e.g. Anyone with the link'],
  microsoft_store: ['Flight', 'e.g. Public'],
  other: ['Where', ''],
};
const URL_LABEL: Record<string, string> = { deploy: 'Site URL', play_store: 'Play listing / console link', app_store: 'App Store link', testflight: 'TestFlight link', email: 'Download link in the mail', download_link: 'Download link', microsoft_store: 'Store link' };
const BUILD_LABEL: Record<string, string> = { play_store: 'Version code', app_store: 'Build number', testflight: 'Build number', deploy: 'Commit / build', microsoft_store: 'Package version' };
const CH_STATUS: Record<string, [string, string]> = { planned: ['Planned', ''], in_progress: ['In progress', 'info'], in_review: ['In review', 'warn'], done: ['Done / live', 'good'], failed: ['Failed', 'bad'], rejected: ['Rejected', 'bad'] };
const ICON: Record<string, string> = { web: '🌐', windows: '🪟', macos: '🍎', linux: '🐧', android: '🤖', ios: '📱', api: '🔌', other: '📦' };

function useAct(keys: unknown[][]) {
  const qc = useQueryClient();
  const toast = useToast();
  return async <T,>(fn: () => Promise<T>, ok?: string): Promise<T | null> => {
    try {
      const r = await fn();
      if (ok) toast(ok);
      for (const k of keys) qc.invalidateQueries({ queryKey: k });
      return r;
    } catch (e) {
      toast((e as Error).message, true);
      return null;
    }
  };
}

export function ReleasesTab({ id, manage }: { id: string; manage: boolean }) {
  const key = ['agile', id];
  const { data: b } = useQuery({ queryKey: key, queryFn: () => get<Json>(`/api/v1/projects/${id}/agile`) });
  const { data: project } = useQuery({ queryKey: ['project', id], queryFn: () => get<Json>(`/api/v1/projects/${id}`) });
  const act = useAct([key]);
  const [edit, setEdit] = useState<Json | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  if (!b) return <Spinner />;
  const releases = b.releases as Json[];
  const milestones = (project?.milestones ?? []) as Json[];
  return (
    <div className="stack">
      {manage && (
        <div>
          <button className="btn primary" onClick={() => setEdit({})}>
            + New release
          </button>
        </div>
      )}
      {releases.length ? (
        <table className="data" data-export-title="Releases">
          <thead>
            <tr>
              <th>Release</th>
              <th>Kind</th>
              <th>Version</th>
              <th>Milestone</th>
              <th>Target</th>
              <th>Status</th>
              <th>Goes out to</th>
              <th className="num">Done</th>
            </tr>
          </thead>
          <tbody>
            {releases.map((r) => (
              <tr key={r.id} style={{ cursor: 'pointer' }} onClick={() => setOpen(r.id)}>
                <td>
                  <button type="button" className="link-btn" onClick={() => setOpen(r.id)}>
                    {r.name}
                  </button>
                </td>
                <td>
                  <span className={`chip ${TYPE_CHIP[r.release_type] ?? ''}`}>{RELEASE_TYPES.find((t) => t[0] === r.release_type)?.[1] ?? r.release_type}</span>
                </td>
                <td>{r.version ?? '—'}</td>
                <td className="small">{r.milestone ?? '—'}</td>
                <td>{r.released_at ? `Released ${date(r.released_at)}` : r.target_date ? date(r.target_date) : '—'}</td>
                <td>
                  <span className={`chip ${r.status === 'released' ? 'good' : r.status === 'in_progress' ? 'info' : ''}`}>{String(r.status).replace('_', ' ')}</span>
                </td>
                <td>
                  {((r.channels ?? []) as Json[]).map((c, i) => (
                    <span key={i} title={`${PLATFORM[c.platform]} — ${METHOD[c.method]} — ${CH_STATUS[c.status]?.[0]}`} style={{ marginRight: 4, opacity: c.status === 'done' ? 1 : 0.55 }}>
                      {ICON[c.platform]}
                    </span>
                  ))}
                  {!(r.channels ?? []).length && <span className="muted small">—</span>}
                </td>
                <td className="num">
                  {r.done_items}/{r.items}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <Empty title="No releases yet">Group finished stories and fixes into versions — major, minor, patch or hotfix — and track how each goes out: deployed, mailed, shared or published on the stores.</Empty>
      )}
      {edit && (
        <ReleaseForm
          projectId={id}
          r={edit}
          sprints={b.sprints as Json[]}
          milestones={milestones}
          onClose={() => setEdit(null)}
          onSave={async (body, remove) => {
            const res = remove
              ? await act(() => del(`/api/v1/projects/${id}/agile/releases/${edit.id}`), 'Deleted')
              : edit.id
                ? await act(() => put(`/api/v1/projects/${id}/agile/releases/${edit.id}`, body), 'Saved')
                : await act(() => post<Json>(`/api/v1/projects/${id}/agile/releases`, body), 'Release added');
            if (res) {
              setEdit(null);
              if (!edit.id && !remove && (res as Json).id) setOpen((res as Json).id);
            }
          }}
        />
      )}
      {open && <ReleaseDetail projectId={id} releaseId={open} manage={manage} onClose={() => setOpen(null)} onEdit={(r) => (setOpen(null), setEdit(r))} />}
    </div>
  );
}

/* ───────────────────────── create / edit ───────────────────────── */

function ReleaseForm({ projectId, r, sprints, milestones, onClose, onSave }: { projectId: string; r: Json; sprints: Json[]; milestones: Json[]; onClose: () => void; onSave: (b: Json, remove?: boolean) => void }) {
  const [f, setF] = useState({
    name: r.name ?? '',
    releaseType: r.release_type ?? 'minor',
    version: r.version ?? '',
    versionSource: r.version_source ?? '',
    targetDate: r.target_date ?? '',
    status: r.status ?? 'planned',
    milestoneId: r.milestone_id ?? '',
    sprintIds: (r.sprint_ids ?? []) as string[],
  });
  const [scan, setScan] = useState<Json | null>(null);
  const [scanning, setScanning] = useState(false);
  // a version that came from the code follows the kind of release until it is typed over
  const [auto, setAuto] = useState(false);
  const read = async (type = f.releaseType) => {
    setScanning(true);
    try {
      const v = scan ?? (await get<Json>(`/api/v1/projects/${projectId}/agile/release-version`));
      setScan(v);
      setF((x) => ({ ...x, version: v.next[type], versionSource: v.source ? `${v.source} (${v.current}) → ${type}` : `first ${type} release` }));
      setAuto(true);
    } finally {
      setScanning(false);
    }
  };
  const help = RELEASE_TYPES.find((t) => t[0] === f.releaseType)?.[2];
  return (
    <Modal
      title={r.id ? `Edit ${r.name}` : 'New release'}
      onClose={onClose}
      wide
      footer={
        <>
          {r.id && (
            <button className="btn danger" onClick={() => window.confirm('Delete this release?') && onSave({}, true)}>
              Delete
            </button>
          )}
          <button
            className="btn primary"
            disabled={!f.name.trim()}
            onClick={() =>
              onSave({
                name: f.name.trim(),
                releaseType: f.releaseType,
                version: f.version.trim() || null,
                versionSource: f.versionSource || null,
                targetDate: f.targetDate || null,
                status: f.status === 'released' ? undefined : f.status,
                milestoneId: f.milestoneId || null,
                sprintIds: f.sprintIds,
              })
            }
          >
            Save
          </button>
        </>
      }
    >
      <div className="modal-body stack">
        <div className="grid2">
          <label className="field">
            Name
            <input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="e.g. Multiplayer, November fixes" autoFocus />
          </label>
          <label className="field">
            Kind of release
            <select
              value={f.releaseType}
              onChange={(e) => {
                const t = e.target.value;
                setF({ ...f, releaseType: t, ...(auto && scan ? { version: scan.next[t], versionSource: scan.source ? `${scan.source} (${scan.current}) → ${t}` : `first ${t} release` } : {}) });
              }}
            >
              {RELEASE_TYPES.map(([k, l]) => (
                <option key={k} value={k}>
                  {l}
                </option>
              ))}
            </select>
            <small className="muted">{help}</small>
          </label>
          <label className="field">
            Version
            <div className="row" style={{ gap: 6 }}>
              <input style={{ flex: 1 }} value={f.version} onChange={(e) => (setAuto(false), setF({ ...f, version: e.target.value, versionSource: '' }))} placeholder="e.g. 1.4.0" />
              <button type="button" className="btn sm" disabled={scanning} onClick={() => read()} title="Reads package.json, .csproj, pubspec.yaml, build.gradle, Info.plist… and the tags of the linked repository">
                {scanning ? 'Reading…' : 'Read from the code'}
              </button>
            </div>
            {scan && (
              <small className="muted">
                {scan.current ? (
                  <>
                    Now {scan.current} (from {scan.source}
                    {scan.repo ? `, ${scan.repo}` : ''}) → next {f.releaseType}: <b>{scan.next[f.releaseType]}</b>
                    {scan.files?.length > 1 ? ` · also ${scan.files.filter((x: Json) => x.source !== scan.source).map((x: Json) => `${x.source} ${x.version}`).join(', ')}` : ''}
                  </>
                ) : (
                  'No version found yet — starting from 0.0.0.'
                )}
                {scan.note ? ` ${scan.note}.` : ''}
              </small>
            )}
          </label>
          <label className="field">
            Target date
            <input type="date" value={f.targetDate} onChange={(e) => setF({ ...f, targetDate: e.target.value })} />
          </label>
          <label className="field">
            Milestone it delivers
            <select value={f.milestoneId} onChange={(e) => setF({ ...f, milestoneId: e.target.value })}>
              <option value="">— none —</option>
              {milestones.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                  {m.due_date ? ` (due ${date(m.due_date)})` : ''}
                </option>
              ))}
            </select>
          </label>
          {r.status !== 'released' && (
            <label className="field">
              Status
              <select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}>
                <option value="planned">Planned</option>
                <option value="in_progress">In progress</option>
                <option value="cancelled">Cancelled</option>
              </select>
            </label>
          )}
        </div>
        <div className="field">
          Sprints that feed it
          {!sprints.length ? (
            <small className="muted">No sprints yet (Backlog & sprints).</small>
          ) : (
            <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
              {sprints.map((s) => (
                <label key={s.id} className="row small" style={{ gap: 4 }} title={s.release_id && s.release_id !== r.id ? 'Feeds another release now; ticking moves it here' : undefined}>
                  <input type="checkbox" checked={f.sprintIds.includes(s.id)} onChange={(e) => setF({ ...f, sprintIds: e.target.checked ? [...f.sprintIds, s.id] : f.sprintIds.filter((x) => x !== s.id) })} />
                  {s.name} <span className="muted">({date(s.start_date)} – {date(s.end_date)})</span>
                  {s.release_id && s.release_id !== r.id ? <span className="muted">· in another release</span> : null}
                </label>
              ))}
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}

/* ───────────────────────── one release ───────────────────────── */

function ReleaseDetail({ projectId, releaseId, manage, onClose, onEdit }: { projectId: string; releaseId: string; manage: boolean; onClose: () => void; onEdit: (r: Json) => void }) {
  const key = ['release', releaseId];
  const { data: r, refetch } = useQuery({ queryKey: key, queryFn: () => get<Json>(`/api/v1/projects/${projectId}/agile/releases/${releaseId}`) });
  const { data: board } = useQuery({ queryKey: ['agile', projectId], queryFn: () => get<Json>(`/api/v1/projects/${projectId}/agile`) });
  const act = useAct([key, ['agile', projectId]]);
  const [notes, setNotes] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  if (!r) return null;
  const listed = (board?.releases as Json[] | undefined)?.find((x) => x.id === releaseId);
  const done = (r.items as Json[]).filter((i) => i.status === 'done').length;
  return (
    <Modal
      title={`${r.name}${r.version ? ` — ${r.version}` : ''}`}
      onClose={onClose}
      xl
      footer={
        <>
          <button
            className="btn"
            onClick={async () => {
              const n = r.notes ? { notes: r.notes } : await get<Json>(`/api/v1/projects/${projectId}/agile/releases/${r.id}/notes`);
              setNotes(n.notes);
            }}
          >
            Release notes
          </button>
          {manage && r.status !== 'released' && (
            <button className="btn" onClick={() => onEdit({ ...r, sprint_ids: listed?.sprint_ids ?? (r.sprints as Json[]).map((s) => s.id) })}>
              Edit
            </button>
          )}
          {manage && r.status !== 'released' && (
            <button
              className="btn primary"
              onClick={async () => {
                if (!confirm(`Mark ${r.name}${r.version ? ` ${r.version}` : ''} released today? Unfinished work leaves the release.`)) return;
                if (await act(() => post(`/api/v1/projects/${projectId}/agile/releases/${r.id}/release`, {}), 'Released')) refetch();
              }}
            >
              Mark released
            </button>
          )}
        </>
      }
    >
      <div className="modal-body stack">
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <span className={`chip ${TYPE_CHIP[r.release_type] ?? ''}`}>{RELEASE_TYPES.find((t) => t[0] === r.release_type)?.[1]}</span>
          <span className={`chip ${r.status === 'released' ? 'good' : r.status === 'in_progress' ? 'info' : ''}`}>{r.status === 'released' ? `Released ${date(r.released_at)}` : String(r.status).replace('_', ' ')}</span>
          {r.target_date && r.status !== 'released' && <span className="chip">Target {date(r.target_date)}</span>}
          {r.milestone && <span className="chip">Milestone: {r.milestone}</span>}
          {(r.sprints as Json[]).map((s) => (
            <span key={s.id} className="chip">
              {s.name}
            </span>
          ))}
          {r.version_source && <span className="small muted">Version from {r.version_source}</span>}
        </div>

        <section>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <h4 style={{ margin: '0 0 6px' }}>How it reaches people</h4>
            {manage && (
              <button className="btn sm primary" onClick={() => setAdding(true)}>
                + Add a channel
              </button>
            )}
          </div>
          {!(r.channels as Json[]).length ? (
            <p className="small muted" style={{ margin: 0 }}>
              Add each way it goes out: deployed to the website, an installer mailed or shared on Google Drive / OneDrive / SharePoint, Google Play, TestFlight and the App Store. Each comes with a checklist of what it needs.
            </p>
          ) : (
            <div className="stack" style={{ gap: 8 }}>
              {(r.channels as Json[]).map((c) => (
                <Channel key={c.id} projectId={projectId} release={r} c={c} manage={manage} onChanged={() => refetch()} />
              ))}
            </div>
          )}
        </section>

        <section>
          <h4 style={{ margin: '0 0 6px' }}>
            Work in it ({done}/{(r.items as Json[]).length} done)
          </h4>
          {!(r.items as Json[]).length ? (
            <p className="small muted" style={{ margin: 0 }}>Nothing yet — set the release on stories, bugs and tasks in Backlog & sprints.</p>
          ) : (
            <ul className="small" style={{ margin: 0, paddingLeft: 18, columns: 2 }}>
              {(r.items as Json[]).map((i) => (
                <li key={i.id} style={{ textDecoration: i.status === 'cancelled' ? 'line-through' : undefined }}>
                  {i.status === 'done' ? '✓ ' : ''}
                  {i.work_key ? `${i.work_key}-${i.task_number}` : `#${i.task_number}`} {i.name} <span className="muted">({i.work_type})</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
      {adding && <ChannelForm projectId={projectId} release={r} onClose={() => setAdding(false)} onSaved={() => (setAdding(false), refetch())} />}
      {notes !== null && (
        <Modal
          title={`Release notes — ${r.name}`}
          onClose={() => setNotes(null)}
          wide
          footer={
            <>
              <button className="btn" onClick={() => navigator.clipboard?.writeText(notes)}>
                Copy
              </button>
              {manage && r.status !== 'released' && (
                <button className="btn primary" onClick={async () => (await act(() => put(`/api/v1/projects/${projectId}/agile/releases/${r.id}`, { name: r.name, version: r.version, targetDate: r.target_date, notes }), 'Notes saved')) && setNotes(null)}>
                  Save notes
                </button>
              )}
            </>
          }
        >
          <div className="modal-body" style={{ display: 'block' }}>
            <textarea style={{ width: '100%', minHeight: 320, fontFamily: 'ui-monospace, monospace' }} readOnly={!manage || r.status === 'released'} value={notes} onChange={(e) => setNotes(e.target.value)} />
            <p className="small muted">Written from the finished stories (New), bugs (Fixed) and tasks (Improved) in the release. Use them in the store listing’s “What’s new” and in the mail to users.</p>
          </div>
        </Modal>
      )}
    </Modal>
  );
}

function Channel({ projectId, release, c, manage, onChanged }: { projectId: string; release: Json; c: Json; manage: boolean; onChanged: () => void }) {
  const act = useAct([['agile', projectId]]);
  const [edit, setEdit] = useState(false);
  const [st, cls] = CH_STATUS[c.status] ?? ['', ''];
  const list = (c.checklist ?? []) as { label: string; done: boolean }[];
  const ticked = list.filter((x) => x.done).length;
  const save = (p: Json) =>
    act(
      () =>
        put(`/api/v1/projects/${projectId}/agile/releases/${release.id}/channels/${c.id}`, {
          platform: c.platform,
          method: c.method,
          target: c.target,
          url: c.url,
          buildRef: c.build_ref,
          recipients: c.recipients,
          notes: c.notes,
          ...p,
        }),
    ).then((r) => r !== null && onChanged());
  const mail = c.method === 'email' && c.recipients
    ? `mailto:${encodeURIComponent(String(c.recipients).replace(/\s*[;\n]\s*/g, ','))}?subject=${encodeURIComponent(`${release.name}${release.version ? ` ${release.version}` : ''} — new version`)}&body=${encodeURIComponent(
        `Hello,\n\nThe new version ${release.version ?? ''} is ready.${c.url ? `\n\nDownload: ${c.url}` : '\n\n(The installer is attached.)'}\n\nInstall: close the old version, run the installer, and open the app.\n\nRegards`,
      )}`
    : null;
  return (
    <div className="panel" style={{ padding: 10 }}>
      <div className="row" style={{ justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 20 }}>{ICON[c.platform]}</span>
          <b>
            {PLATFORM[c.platform]} — {METHOD[c.method]}
          </b>
          {c.target && <span className="small muted">{c.target}</span>}
          {c.build_ref && <span className="chip">{c.build_ref}</span>}
          <span className={`chip ${cls}`}>{st}</span>
          {list.length > 0 && (
            <span className="small muted">
              {ticked}/{list.length} steps
            </span>
          )}
        </div>
        {manage && (
          <div className="row" style={{ gap: 6 }}>
            <select value={c.status} onChange={(e) => save({ status: e.target.value })} aria-label="Status">
              {Object.entries(CH_STATUS).map(([k, [l]]) => (
                <option key={k} value={k}>
                  {l}
                </option>
              ))}
            </select>
            <button className="btn sm ghost" onClick={() => setEdit(true)}>
              Edit
            </button>
          </div>
        )}
      </div>
      <div className="row small" style={{ gap: 12, flexWrap: 'wrap', marginTop: 6 }}>
        {c.url && (
          <a href={c.url} target="_blank" rel="noreferrer">
            {URL_LABEL[c.method] ?? 'Link'} ↗
          </a>
        )}
        {(c.files as Json[]).map((f) => (
          <a key={f.id} href={f.url}>
            📎 {f.name}
          </a>
        ))}
        {c.recipients && <span className="muted">To: {c.recipients}</span>}
        {mail && (
          <a className="btn sm" href={mail}>
            Write the mail
          </a>
        )}
        {c.done_at && <span className="muted">Done {date(c.done_at)}</span>}
      </div>
      {list.length > 0 && (
        <ul style={{ listStyle: 'none', margin: '8px 0 0', padding: 0, display: 'grid', gap: 2 }} className="small">
          {list.map((x, i) => (
            <li key={i}>
              <label className="row" style={{ gap: 6 }}>
                <input type="checkbox" disabled={!manage} checked={x.done} onChange={(e) => save({ checklist: list.map((y, j) => (j === i ? { ...y, done: e.target.checked } : y)) })} />
                <span style={{ textDecoration: x.done ? 'line-through' : undefined, opacity: x.done ? 0.7 : 1 }}>{x.label}</span>
              </label>
            </li>
          ))}
        </ul>
      )}
      {c.notes && <div className="small muted" style={{ marginTop: 6, whiteSpace: 'pre-wrap' }}>{c.notes}</div>}
      {edit && <ChannelForm projectId={projectId} release={release} c={c} onClose={() => setEdit(false)} onSaved={() => (setEdit(false), onChanged())} />}
    </div>
  );
}

function ChannelForm({ projectId, release, c, onClose, onSaved }: { projectId: string; release: Json; c?: Json; onClose: () => void; onSaved: () => void }) {
  const act = useAct([['agile', projectId]]);
  const toast = useToast();
  const [f, setF] = useState({
    platform: c?.platform ?? 'web',
    method: c?.method ?? 'deploy',
    target: c?.target ?? '',
    url: c?.url ?? '',
    buildRef: c?.build_ref ?? '',
    recipients: c?.recipients ?? '',
    notes: c?.notes ?? '',
    status: c?.status ?? 'planned',
    files: ((c?.files ?? []) as Json[]).map((x) => ({ id: x.id, name: x.name })),
  });
  const [busy, setBusy] = useState(false);
  const methods = METHODS_FOR[f.platform] ?? Object.keys(METHOD);
  const [tl, tp] = TARGET_LABEL[f.method] ?? TARGET_LABEL.other!;
  const shares = ['email', 'google_drive', 'onedrive', 'sharepoint', 'download_link', 'testflight'].includes(f.method);
  const files = ['email', 'google_drive', 'onedrive', 'sharepoint', 'download_link', 'play_store', 'app_store', 'microsoft_store', 'other'].includes(f.method);
  const remove = async () => {
    if (!c || !confirm('Remove this channel?')) return;
    if (await act(() => del(`/api/v1/projects/${projectId}/agile/releases/${release.id}/channels/${c.id}`), 'Removed')) onSaved();
  };
  return (
    <Modal
      title={c ? `${PLATFORM[c.platform]} — ${METHOD[c.method]}` : 'How does it go out?'}
      onClose={onClose}
      wide
      footer={
        <>
          {c && (
            <button className="btn danger" onClick={remove}>
              Remove
            </button>
          )}
          <button
            className="btn primary"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              const body = { platform: f.platform, method: f.method, target: f.target.trim() || null, url: f.url.trim() || null, buildRef: f.buildRef.trim() || null, recipients: f.recipients.trim() || null, notes: f.notes.trim() || null, status: f.status, fileIds: f.files.map((x) => x.id) };
              const r = await act(() => (c ? put(`/api/v1/projects/${projectId}/agile/releases/${release.id}/channels/${c.id}`, body) : post(`/api/v1/projects/${projectId}/agile/releases/${release.id}/channels`, body)), c ? 'Saved' : 'Channel added');
              setBusy(false);
              if (r) onSaved();
            }}
          >
            Save
          </button>
        </>
      }
    >
      <div className="modal-body stack">
        <div className="grid2">
          <label className="field">
            Platform
            <select value={f.platform} onChange={(e) => setF({ ...f, platform: e.target.value, method: (METHODS_FOR[e.target.value] ?? ['other'])[0]! })}>
              {Object.entries(PLATFORM).map(([k, l]) => (
                <option key={k} value={k}>
                  {ICON[k]} {l}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            How
            <select value={f.method} onChange={(e) => setF({ ...f, method: e.target.value })}>
              {methods.map((m) => (
                <option key={m} value={m}>
                  {METHOD[m]}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            {tl}
            <input value={f.target} placeholder={tp} onChange={(e) => setF({ ...f, target: e.target.value })} />
          </label>
          <label className="field">
            {URL_LABEL[f.method] ?? 'Shared link'}
            <input value={f.url} placeholder="https://…" onChange={(e) => setF({ ...f, url: e.target.value })} />
          </label>
          <label className="field">
            {BUILD_LABEL[f.method] ?? 'Build / file version'}
            <input value={f.buildRef} placeholder={release.version ?? ''} onChange={(e) => setF({ ...f, buildRef: e.target.value })} />
          </label>
          <label className="field">
            Status
            <select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}>
              {Object.entries(CH_STATUS).map(([k, [l]]) => (
                <option key={k} value={k}>
                  {l}
                </option>
              ))}
            </select>
          </label>
        </div>
        {shares && (
          <label className="field">
            {f.method === 'testflight' ? 'Testers (emails)' : 'Sent / shared to (emails, one per line)'}
            <textarea rows={2} value={f.recipients} onChange={(e) => setF({ ...f, recipients: e.target.value })} placeholder="deepak@fci.gov.in" />
          </label>
        )}
        {files && (
          <div className="field">
            {f.method === 'play_store' ? 'App bundle (.aab) / APK' : f.method === 'app_store' ? 'Build (.ipa), if kept here' : 'Installer and files (.exe, .msi, .dmg, .apk, .zip…)'}
            <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
              {f.files.map((x) => (
                <span key={x.id} className="chip">
                  📎 {x.name}{' '}
                  <button type="button" className="link-btn small" onClick={() => setF({ ...f, files: f.files.filter((y) => y.id !== x.id) })}>
                    ×
                  </button>
                </span>
              ))}
              <label className="btn sm">
                {busy ? 'Uploading…' : 'Attach a file'}
                <input
                  type="file"
                  hidden
                  onChange={async (e) => {
                    const file = e.target.files?.[0];
                    e.target.value = '';
                    if (!file) return;
                    if (file.size > 25 * 1024 * 1024) return toast('Files up to 25 MB — share bigger installers on Drive / OneDrive / SharePoint and paste the link', true);
                    setBusy(true);
                    try {
                      const up = await upload<{ id: string; name: string }>(`/api/v1/files?object=project&id=${projectId}&name=${encodeURIComponent(file.name)}&description=${encodeURIComponent(`Release ${release.name} ${release.version ?? ''}`.trim())}`, file);
                      setF((x) => ({ ...x, files: [...x.files, { id: up.id, name: up.name ?? file.name }] }));
                    } catch (err) {
                      toast((err as Error).message, true);
                    } finally {
                      setBusy(false);
                    }
                  }}
                />
              </label>
            </div>
            <small className="muted">Up to 25 MB each. Bigger installers: share them on Google Drive / OneDrive / SharePoint and paste the link above.</small>
          </div>
        )}
        <label className="field">
          Notes
          <textarea rows={2} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} placeholder={f.method === 'play_store' ? 'e.g. Rolled out to 20% first' : ''} />
        </label>
        {!c && <p className="small muted" style={{ margin: 0 }}>It starts with a checklist of what this way usually needs — tick the steps as they are done.</p>}
      </div>
    </Modal>
  );
}
