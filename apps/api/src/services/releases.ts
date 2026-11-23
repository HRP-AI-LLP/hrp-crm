/**
 * Releases, all the way out: a release has a kind (major, minor, patch, hotfix, pre-release,
 * maintenance), may deliver a milestone and gather sprints, and takes its version from the code —
 * the repository's version files (package.json, .csproj, pubspec.yaml, build.gradle, Info.plist,
 * pyproject.toml, Cargo.toml, VERSION …) and its tags — bumped by the kind of release.
 *
 * How it reaches people are its channels, one per platform and way:
 *   web          deployed to an environment (production, staging) at a URL
 *   windows/mac  an installer (.exe / .msi / .dmg) sent by mail, shared on Google Drive, OneDrive or
 *                SharePoint, or a download link
 *   android      Google Play (internal / closed / open testing, production)
 *   ios          TestFlight, then the App Store
 * each with its own checklist (the store's listing, screenshots, privacy policy, review…), status,
 * build number, links, files and who received it.
 */
import { z } from 'zod';
import type { Env } from '../env';
import { badRequest, notFound } from '../lib/errors';
import { projectAccess } from './projects';
import type { RecordCtx } from './records';

export const RELEASE_TYPES = ['major', 'minor', 'patch', 'hotfix', 'prerelease', 'maintenance'] as const;
export type ReleaseType = (typeof RELEASE_TYPES)[number];
export const PLATFORMS = ['web', 'windows', 'macos', 'linux', 'android', 'ios', 'api', 'other'] as const;
export const METHODS = ['deploy', 'email', 'google_drive', 'onedrive', 'sharepoint', 'download_link', 'play_store', 'app_store', 'testflight', 'microsoft_store', 'other'] as const;
export const CHANNEL_STATUSES = ['planned', 'in_progress', 'in_review', 'done', 'failed', 'rejected'] as const;

/* ───────────────────────── versions ───────────────────────── */

type SemVer = { major: number; minor: number; patch: number; pre: string | null };
export function parseSemver(v: string | null | undefined): SemVer | null {
  const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:\.(\d+))?(?:[-+]([0-9A-Za-z.-]+))?$/.exec(String(v ?? '').trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2] ?? 0), patch: Number(m[3] ?? 0), pre: m[5] ?? null };
}
const fmt = (s: SemVer) => `${s.major}.${s.minor}.${s.patch}${s.pre ? `-${s.pre}` : ''}`;
function cmp(a: SemVer, b: SemVer) {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch || (a.pre ? (b.pre ? a.pre.localeCompare(b.pre) : -1) : b.pre ? 1 : 0);
}

/** The next version after `current` for a kind of release (1.4.2 → major 2.0.0, minor 1.5.0, patch / hotfix 1.4.3, pre-release 1.5.0-beta.1). */
export function nextVersion(current: string | null | undefined, type: ReleaseType): string {
  const c = parseSemver(current) ?? { major: 0, minor: 0, patch: 0, pre: null };
  switch (type) {
    case 'major':
      return fmt({ major: c.major + 1, minor: 0, patch: 0, pre: null });
    case 'minor':
      return fmt({ major: c.major, minor: c.minor + 1, patch: 0, pre: null });
    case 'patch':
    case 'hotfix':
    case 'maintenance':
      // a pre-release goes final at its own number
      return c.pre ? fmt({ ...c, pre: null }) : fmt({ ...c, patch: c.patch + 1, pre: null });
    case 'prerelease': {
      if (c.pre) {
        const m = /^(.*?)(\d+)$/.exec(c.pre);
        return fmt({ ...c, pre: m ? `${m[1]}${Number(m[2]) + 1}` : `${c.pre}.1` });
      }
      return fmt({ major: c.major, minor: c.minor + 1, patch: 0, pre: 'beta.1' });
    }
  }
}

/** A version written in one of the usual files; null when the file says none. */
export function versionInFile(path: string, text: string): string | null {
  const name = path.split('/').pop()!.toLowerCase();
  const pick = (re: RegExp) => re.exec(text)?.[1]?.trim() ?? null;
  if (name === 'package.json' || name === 'app.json' || name === 'manifest.json' || name === 'tauri.conf.json') {
    try {
      const j = JSON.parse(text);
      return j.version ?? j.expo?.version ?? j.package?.version ?? null;
    } catch {
      return pick(/"version"\s*:\s*"([^"]+)"/);
    }
  }
  if (name.endsWith('.csproj') || name === 'directory.build.props' || name.endsWith('.vbproj') || name.endsWith('.fsproj')) return pick(/<(?:Version|VersionPrefix|ApplicationDisplayVersion|AssemblyVersion|FileVersion)>\s*([^<\s]+)\s*</);
  if (name === 'assemblyinfo.cs') return pick(/Assembly(?:Informational|File)?Version\(\s*"([^"*]+)"/);
  if (name === 'pubspec.yaml') return pick(/^version:\s*([^\s+#]+)/m);
  if (name === 'build.gradle' || name === 'build.gradle.kts') return pick(/versionName\s*=?\s*["']([^"']+)["']/);
  if (name === 'info.plist') return pick(/<key>CFBundleShortVersionString<\/key>\s*<string>([^<$]+)<\/string>/);
  if (name.endsWith('.pbxproj')) return pick(/MARKETING_VERSION = ([^;\s]+);/);
  if (name === 'pyproject.toml' || name === 'cargo.toml') return pick(/^version\s*=\s*["']([^"']+)["']/m);
  if (name === 'setup.py') return pick(/version\s*=\s*["']([^"']+)["']/);
  if (name === 'pom.xml') return pick(/<artifactId>[^<]+<\/artifactId>\s*<version>([^<$]+)<\/version>/);
  if (name === 'version' || name === 'version.txt') return pick(/^\s*v?([0-9][^\s]*)/);
  if (name === 'appxmanifest.xml' || name === 'package.appxmanifest') return pick(/<Identity[^>]*Version="([^"]+)"/);
  return null;
}

const VERSION_FILES = /(^|\/)(package\.json|app\.json|tauri\.conf\.json|[^/]+\.csproj|Directory\.Build\.props|AssemblyInfo\.cs|pubspec\.yaml|build\.gradle(\.kts)?|Info\.plist|project\.pbxproj|pyproject\.toml|Cargo\.toml|setup\.py|pom\.xml|VERSION|version\.txt|Package\.appxmanifest)$/i;
const SKIP = /(^|\/)(node_modules|vendor|bin|obj|dist|build|\.git|Pods|test|tests|example|examples|samples?)\//i;

/**
 * The version in the project's repository (through the GitHub App): its version files, shallowest
 * first, and its newest version tag — and the next one for each kind of release.
 */
export async function repoVersion(ctx: RecordCtx, env: Env, projectId: string) {
  await projectAccess(ctx, projectId, 'view');
  const repo = await ctx.tx.one<{ repo: string; default_branch: string; installation_id: string | null; provider: string }>(
    `select repo, default_branch, installation_id::text, provider from project_repos where tenant_id = $1 and project_id = $2 order by created_at limit 1`,
    [ctx.tenantId, projectId],
  );
  const lastRelease = await ctx.tx.one<{ version: string }>(
    `select version from project_releases where tenant_id = $1 and project_id = $2 and status = 'released' and version is not null order by released_at desc nulls last, created_at desc limit 1`,
    [ctx.tenantId, projectId],
  );
  const found: { source: string; version: string }[] = [];
  let tag: string | null = null;
  let note: string | null = null;
  if (!repo) note = 'No repository is linked to this project (Work setup → Code repositories)';
  else if (repo.provider !== 'github' || !repo.installation_id) note = 'Link the repository through the GitHub App to read its version (Work setup → Code repositories)';
  else if (!env.GITHUB_APP_ID) note = 'The GitHub App is not set up on this server';
  else {
    try {
      const { installationToken } = await import('./github-app');
      const token = await installationToken(env, repo.installation_id);
      const api = async <T>(path: string): Promise<T | null> => {
        const r = await fetch(`https://api.github.com${path}`, { headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'hrp-synapse' }, signal: AbortSignal.timeout(20_000) });
        return r.ok ? ((await r.json()) as T) : null;
      };
      const tags = (await api<{ name: string }[]>(`/repos/${repo.repo}/tags?per_page=50`)) ?? [];
      const semverTags = tags.map((t) => ({ t: t.name, v: parseSemver(t.name) })).filter((x): x is { t: string; v: SemVer } => !!x.v);
      semverTags.sort((a, b) => cmp(b.v, a.v));
      tag = semverTags[0]?.t ?? null;
      const tree = await api<{ tree: { path: string; type: string }[] }>(`/repos/${repo.repo}/git/trees/${encodeURIComponent(repo.default_branch)}?recursive=1`);
      const files = (tree?.tree ?? [])
        .filter((f) => f.type === 'blob' && VERSION_FILES.test(f.path) && !SKIP.test(`${f.path}`))
        .sort((a, b) => a.path.split('/').length - b.path.split('/').length || a.path.localeCompare(b.path))
        .slice(0, 8);
      for (const f of files) {
        const c = await api<{ content?: string; encoding?: string }>(`/repos/${repo.repo}/contents/${f.path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(repo.default_branch)}`);
        if (!c?.content) continue;
        const text = new TextDecoder().decode(Uint8Array.from(atob(c.content.replace(/\s/g, '')), (ch) => ch.charCodeAt(0)));
        const v = versionInFile(f.path, text);
        if (v && parseSemver(v)) found.push({ source: f.path, version: v });
      }
    } catch (e) {
      note = `Could not read the repository: ${(e as Error).message.slice(0, 200)}`;
    }
  }
  // the highest of the code, the tags and the last release is where the next one starts
  const candidates = [...found.map((f) => f.version), tag, lastRelease?.version].filter((v): v is string => !!parseSemver(v));
  const current = candidates.sort((a, b) => cmp(parseSemver(b)!, parseSemver(a)!))[0] ?? null;
  const source = current ? (found.find((f) => f.version === current)?.source ?? (current === tag ? `tag ${tag}` : 'the last release')) : null;
  return {
    repo: repo?.repo ?? null,
    branch: repo?.default_branch ?? null,
    files: found,
    tag,
    lastRelease: lastRelease?.version ?? null,
    current,
    source,
    next: Object.fromEntries(RELEASE_TYPES.map((t) => [t, nextVersion(current, t)])) as Record<ReleaseType, string>,
    note,
  };
}

/* ───────────────────────── channels ───────────────────────── */

/** What a channel usually needs, by platform and way — the starting checklist. */
export function defaultChecklist(platform: string, method: string): { label: string; done: boolean }[] {
  const L = (xs: string[]) => xs.map((label) => ({ label, done: false }));
  if (method === 'play_store')
    return L(['Version code raised, release build signed (AAB)', 'Store listing: description, screenshots, feature graphic', 'Data safety form and privacy policy URL', 'Content rating and target audience', 'Uploaded to the track (internal / closed / open / production)', 'Release notes for this version', 'Sent for review', 'Live on Google Play']);
  if (method === 'app_store' || method === 'testflight')
    return L(['Build number raised, archived and uploaded (Xcode / Transporter)', 'TestFlight testers invited and build tested', 'App Store listing: description, keywords, screenshots for each device size', 'App Privacy details and privacy policy URL', 'Age rating, export compliance', 'Submitted for App Review', 'Approved and released on the App Store']);
  if (method === 'microsoft_store') return L(['MSIX package signed', 'Store listing and screenshots', 'Submitted for certification', 'Live in the Microsoft Store']);
  if (method === 'deploy')
    return L(['Tests pass on the release branch', 'Database migrations applied', 'Environment settings / secrets updated', 'Deployed', 'Smoke-tested after deploying', 'Rollback plan known']);
  if (['email', 'google_drive', 'onedrive', 'sharepoint', 'download_link'].includes(method))
    return L([
      platform === 'windows' ? 'Installer built (.exe / .msi) and code-signed' : platform === 'macos' ? 'App signed and notarised (.dmg / .pkg)' : 'Build packaged',
      'Installed and tested on a clean machine',
      'Installer attached here',
      method === 'email' ? 'Mailed to the recipients with install steps' : method === 'download_link' ? 'Download link shared with the recipients' : 'Uploaded and shared with the recipients (view / download access)',
      'Recipients confirmed it installs and runs',
    ]);
  return L(['Built', 'Tested', 'Delivered']);
}

export const channelSchema = z.object({
  platform: z.enum(PLATFORMS),
  method: z.enum(METHODS),
  target: z.string().trim().max(300).nullish(),
  url: z.string().trim().max(1000).nullish(),
  buildRef: z.string().trim().max(120).nullish(),
  recipients: z.string().max(4000).nullish(),
  fileIds: z.array(z.string().uuid()).max(20).optional(),
  checklist: z.array(z.object({ label: z.string().trim().min(1).max(200), done: z.boolean() })).max(40).optional(),
  status: z.enum(CHANNEL_STATUSES).optional(),
  notes: z.string().max(4000).nullish(),
});

async function releaseOf(ctx: RecordCtx, projectId: string, releaseId: string) {
  const r = await ctx.tx.one<{ id: string; status: string }>(`select id, status from project_releases where tenant_id = $1 and id = $2 and project_id = $3`, [ctx.tenantId, releaseId, projectId]);
  if (!r) throw notFound('Release not found');
  return r;
}

async function checkFiles(ctx: RecordCtx, projectId: string, fileIds: string[] | undefined) {
  if (!fileIds?.length) return;
  const n = await ctx.tx.one<{ n: number }>(`select count(*)::int as n from files where tenant_id = $1 and id = any($2::uuid[]) and object_key = 'project' and record_id = $3 and deleted_at is null`, [ctx.tenantId, fileIds, projectId]);
  if ((n?.n ?? 0) !== new Set(fileIds).size) throw badRequest('Attach files uploaded to this project');
}

export async function saveChannel(ctx: RecordCtx, projectId: string, releaseId: string, channelId: string | null, input: z.infer<typeof channelSchema>) {
  await projectAccess(ctx, projectId, 'member');
  await releaseOf(ctx, projectId, releaseId);
  await checkFiles(ctx, projectId, input.fileIds);
  const checklist = input.checklist ?? (channelId ? undefined : defaultChecklist(input.platform, input.method));
  if (channelId) {
    const r = await ctx.tx.one<{ id: string }>(
      `update project_release_channels set platform = $4, method = $5, target = $6, url = $7, build_ref = $8, recipients = $9, file_ids = coalesce($10::uuid[], file_ids),
              checklist = coalesce($11::jsonb, checklist), status = coalesce($12, status), notes = $13,
              done_at = case when $12 = 'done' and status <> 'done' then now() when $12 is not null and $12 <> 'done' then null else done_at end, updated_at = now()
        where tenant_id = $1 and id = $2 and release_id = $3 returning id`,
      [ctx.tenantId, channelId, releaseId, input.platform, input.method, input.target ?? null, input.url ?? null, input.buildRef ?? null, input.recipients ?? null, input.fileIds ?? null, checklist ? JSON.stringify(checklist) : null, input.status ?? null, input.notes ?? null],
    );
    if (!r) throw notFound('Channel not found');
    return { id: channelId };
  }
  const r = await ctx.tx.one<{ id: string }>(
    `insert into project_release_channels (tenant_id, project_id, release_id, platform, method, target, url, build_ref, recipients, file_ids, checklist, status, notes, done_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, case when $12 = 'done' then now() end) returning id`,
    [ctx.tenantId, projectId, releaseId, input.platform, input.method, input.target ?? null, input.url ?? null, input.buildRef ?? null, input.recipients ?? null, input.fileIds ?? [], JSON.stringify(checklist ?? []), input.status ?? 'planned', input.notes ?? null],
  );
  return { id: r!.id };
}

export async function deleteChannel(ctx: RecordCtx, projectId: string, releaseId: string, channelId: string) {
  await projectAccess(ctx, projectId, 'member');
  const r = await ctx.tx.one(`delete from project_release_channels where tenant_id = $1 and id = $2 and release_id = $3 and project_id = $4 returning id`, [ctx.tenantId, channelId, releaseId, projectId]);
  if (!r) throw notFound('Channel not found');
  return { ok: true };
}

/** A release in full: its work, milestone, sprints and channels (with links to their files). */
export async function releaseDetail(ctx: RecordCtx, env: Env, projectId: string, releaseId: string) {
  await projectAccess(ctx, projectId, 'view');
  const r = await ctx.tx.one<Record<string, any>>(
    `select r.id, r.name, r.version, r.release_type, r.target_date::text, r.status, r.released_at::text, r.notes, r.milestone_id, r.version_source, m.name as milestone, m.status as milestone_status
       from project_releases r left join project_milestones m on m.tenant_id = r.tenant_id and m.id = r.milestone_id where r.tenant_id = $1 and r.id = $2 and r.project_id = $3`,
    [ctx.tenantId, releaseId, projectId],
  );
  if (!r) throw notFound('Release not found');
  const sprints = await ctx.tx.query(`select id, name, status, start_date::text, end_date::text from project_sprints where tenant_id = $1 and release_id = $2 order by start_date`, [ctx.tenantId, releaseId]);
  const items = await ctx.tx.query(
    `select t.id, t.task_number, t.name, t.status, t.work_type, t.story_points::float8 as story_points, p.work_key from project_tasks t join projects p on p.tenant_id = t.tenant_id and p.id = t.project_id
      where t.tenant_id = $1 and t.release_id = $2 and t.work_type <> 'epic' order by t.status = 'done', t.task_number limit 500`,
    [ctx.tenantId, releaseId],
  );
  const channels = await ctx.tx.query<Record<string, any>>(`select * from project_release_channels where tenant_id = $1 and release_id = $2 order by created_at`, [ctx.tenantId, releaseId]);
  const fileIds = [...new Set(channels.flatMap((c) => c.file_ids as string[]))];
  const files = fileIds.length
    ? await ctx.tx.query<{ id: string; name: string; size_bytes: string; content_type: string }>(`select id, name, size_bytes, content_type from files where tenant_id = $1 and id = any($2::uuid[]) and deleted_at is null`, [ctx.tenantId, fileIds])
    : [];
  const { signedFileUrl } = await import('./files');
  const fileMap = new Map<string, Record<string, unknown>>();
  for (const f of files) fileMap.set(f.id, { id: f.id, name: f.name, size: Number(f.size_bytes), type: f.content_type, url: await signedFileUrl(env, ctx.tenantId, f.id, false) });
  return { ...r, sprints, items, channels: channels.map((c) => ({ ...c, files: (c.file_ids as string[]).map((id) => fileMap.get(id)).filter(Boolean) })) };
}

/** Sprints that feed a release (a sprint feeds one release). */
export async function setReleaseSprints(ctx: RecordCtx, projectId: string, releaseId: string, sprintIds: string[]) {
  await ctx.tx.query(`update project_sprints set release_id = null where tenant_id = $1 and project_id = $2 and release_id = $3 and not (id = any($4::uuid[]))`, [ctx.tenantId, projectId, releaseId, sprintIds]);
  if (!sprintIds.length) return;
  const n = await ctx.tx.query(`update project_sprints set release_id = $3 where tenant_id = $1 and project_id = $2 and id = any($4::uuid[]) returning id`, [ctx.tenantId, projectId, releaseId, sprintIds]);
  if (n.length !== new Set(sprintIds).size) throw badRequest('A sprint is not in this project');
}
