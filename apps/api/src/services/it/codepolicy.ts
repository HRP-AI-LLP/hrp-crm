/**
 * Code policy: projects are linked to their repositories and every commit / pull request names a
 * work item (FLEET-12) or a change request (FLEET-CR-3). Unlinked code is recorded (warn), fails
 * the CI check and the commit hook (enforce), or gets an item created from its message
 * (auto_create: "fix: …" → bug, "feat: …" → story, "cr: …" → change request, "epic: …" → epic …).
 *
 * Two ways in, both idempotent per commit / PR (pm_code_events):
 *   - the GitHub / Azure DevOps webhook (devlinks.ts) for pushes and pull requests,
 *   - the CI check (/api/public/dev/check) that the generated workflow runs on every push and PR,
 *     whose failure blocks merging once branch protection requires it.
 */
import type { Env } from '../../env';
import { randomToken, sha256Hex, timingSafeEqual } from '../../lib/crypto';
import type { Db, Tx } from '../../lib/db';
import { badRequest, notFound } from '../../lib/errors';
import { projectAccess } from '../projects';
import type { RecordCtx } from '../records';
import { systemCtxFor } from '../system';
import type { WorkType } from '../work-types';
import { createItem, findByKey, workKey } from './work';

export type Policy = 'off' | 'warn' | 'enforce' | 'auto_create';
export interface Repo {
  id: string;
  tenant_id: string;
  project_id: string;
  provider: 'github' | 'azure_repos';
  repo: string;
  default_branch: string;
  policy: Policy;
  auto_sprint: boolean;
  public_token: string;
  secret_hash: string;
}

export const normRepo = (s: string) =>
  s
    .trim()
    .replace(/^https?:\/\/(www\.)?github\.com\//i, '')
    .replace(/^https?:\/\/dev\.azure\.com\/[^/]+\//i, '')
    .replace(/\/_git\//, '/')
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '')
    .toLowerCase();

/* ───────────────────────── linking repositories ───────────────────────── */

export async function listRepos(ctx: RecordCtx, projectId: string) {
  const { level } = await projectAccess(ctx, projectId, 'view');
  const rows = await ctx.tx.query<Record<string, any>>(
    `select r.id, r.provider, r.repo, r.default_branch, r.policy, r.auto_sprint, r.last_check_at, r.created_at, r.installation_id::text as installation_id,
            count(e.id) filter (where e.at > now() - interval '30 days')::int as events,
            count(e.id) filter (where e.status = 'linked' and e.at > now() - interval '30 days')::int as linked,
            count(e.id) filter (where e.status = 'created' and e.at > now() - interval '30 days')::int as created,
            count(e.id) filter (where e.status = 'missing' and e.at > now() - interval '30 days')::int as missing
       from project_repos r left join pm_code_events e on e.tenant_id = r.tenant_id and e.repo_id = r.id
      where r.tenant_id = $1 and r.project_id = $2 group by r.id order by r.created_at`,
    [ctx.tenantId, projectId],
  );
  const missing = await ctx.tx.query(
    `select e.id, e.kind, e.title, e.author, e.author_email, e.url, e.branch, e.at, r.repo from pm_code_events e join project_repos r on r.tenant_id = e.tenant_id and r.id = e.repo_id
      where e.tenant_id = $1 and e.project_id = $2 and e.status = 'missing' order by e.at desc limit 100`,
    [ctx.tenantId, projectId],
  );
  return { repos: rows, missing, canManage: level === 'manage' };
}

export async function addRepo(ctx: RecordCtx, projectId: string, input: { provider: 'github' | 'azure_repos'; repo: string; defaultBranch?: string; policy?: Policy; autoSprint?: boolean; installationId?: string | null }) {
  if (input.installationId && !(await ctx.tx.one(`select 1 from github_installations where tenant_id = $1 and installation_id = $2::bigint`, [ctx.tenantId, input.installationId]))) throw badRequest('That GitHub installation is not connected to this workspace');
  await projectAccess(ctx, projectId, 'manage');
  const repo = normRepo(input.repo);
  if (!/^[a-z0-9._-]+(\/[a-z0-9._ -]+){1,2}$/.test(repo)) throw badRequest(input.provider === 'github' ? 'Give the repository as owner/name, e.g. acme/fleet-portal' : 'Give the repository as project/repo, e.g. Fleet/fleet-api');
  const taken = await ctx.tx.one<{ project_id: string; name: string }>(`select r.project_id, p.name from project_repos r join projects p on p.tenant_id = r.tenant_id and p.id = r.project_id where r.tenant_id = $1 and r.provider = $2 and r.repo = $3`, [ctx.tenantId, input.provider, repo]);
  if (taken) throw badRequest(`${repo} is already linked to ${taken.name}`);
  // one project, one repository: the coding agent and the code checks always know where the work goes
  const own = await ctx.tx.one<{ repo: string }>(`select repo from project_repos where tenant_id = $1 and project_id = $2 limit 1`, [ctx.tenantId, projectId]);
  if (own) throw badRequest(`This project is linked to ${own.repo}. A project has one repository: unlink it first, or make a project for the other repository`);
  const secret = randomToken(24);
  const r = await ctx.tx.one<{ id: string; public_token: string }>(
    `insert into project_repos (tenant_id, project_id, provider, repo, default_branch, policy, auto_sprint, secret_hash, installation_id) values ($1,$2,$3,$4,$5,$6,$7,$8,$9::bigint) returning id, public_token`,
    [ctx.tenantId, projectId, input.provider, repo, input.defaultBranch?.trim() || 'main', input.policy ?? 'enforce', input.autoSprint ?? true, await sha256Hex(secret), input.provider === 'github' ? (input.installationId ?? null) : null],
  );
  return { id: r!.id, token: `${r!.public_token}.${secret}` };
}

export async function updateRepo(ctx: RecordCtx, projectId: string, id: string, input: { policy?: Policy; defaultBranch?: string; autoSprint?: boolean }) {
  await projectAccess(ctx, projectId, 'manage');
  const r = await ctx.tx.one(`update project_repos set policy = coalesce($4, policy), default_branch = coalesce($5, default_branch), auto_sprint = coalesce($6, auto_sprint) where tenant_id = $1 and id = $2 and project_id = $3 returning id`, [
    ctx.tenantId, id, projectId, input.policy ?? null, input.defaultBranch?.trim() || null, input.autoSprint ?? null,
  ]);
  if (!r) throw notFound('Repository not found');
  return { ok: true };
}

export async function rotateRepoToken(ctx: RecordCtx, projectId: string, id: string) {
  await projectAccess(ctx, projectId, 'manage');
  const secret = randomToken(24);
  const r = await ctx.tx.one<{ public_token: string }>(`update project_repos set public_token = encode(gen_random_bytes(16), 'hex'), secret_hash = $4 where tenant_id = $1 and id = $2 and project_id = $3 returning public_token`, [
    ctx.tenantId, id, projectId, await sha256Hex(secret),
  ]);
  if (!r) throw notFound('Repository not found');
  return { token: `${r.public_token}.${secret}` };
}

export async function removeRepo(ctx: RecordCtx, projectId: string, id: string) {
  await projectAccess(ctx, projectId, 'manage');
  await ctx.tx.query(`delete from project_repos where tenant_id = $1 and id = $2 and project_id = $3`, [ctx.tenantId, id, projectId]);
  return { ok: true };
}

/** Projects with no repository linked (for the projects list and the project banner). */
export async function projectsWithoutRepo(tx: Tx, tenantId: string, ids: string[]) {
  const rows = await tx.query<{ id: string }>(`select id from projects p where tenant_id = $1 and id = any($2::uuid[]) and not exists (select 1 from project_repos r where r.tenant_id = p.tenant_id and r.project_id = p.id)`, [tenantId, ids]);
  return rows.map((r) => r.id);
}

/* ───────────────────────── setup files ───────────────────────── */

export async function setupFiles(ctx: RecordCtx, projectId: string, id: string, base: string) {
  const { project } = await projectAccess(ctx, projectId, 'member');
  const r = await ctx.tx.one<Repo>(`select * from project_repos where tenant_id = $1 and id = $2 and project_id = $3`, [ctx.tenantId, id, projectId]);
  if (!r) throw notFound('Repository not found');
  const key = await workKey(ctx.tx, ctx.tenantId, project);
  const url = `${base}/api/public/dev/check`;
  const allowNoKey = r.policy === 'auto_create' || r.policy === 'warn' || r.policy === 'off';
  const githubWorkflow = `# .github/workflows/synapse-work-items.yml — every push and pull request must name a ${key} work item
# Add the repository secret SYNAPSE_TOKEN (Settings → Secrets and variables → Actions), then require
# the "SanchalanOS work items / work-item" check in the branch protection rule for ${r.default_branch}.
name: SanchalanOS work items
on:
  push:
  pull_request:
    types: [opened, edited, reopened, synchronize, ready_for_review]
jobs:
  work-item:
    runs-on: ubuntu-latest
    steps:
      - name: Every commit and PR names a work item (e.g. ${key}-12)
        env:
          SYNAPSE_TOKEN: \${{ secrets.SYNAPSE_TOKEN }}
        run: |
          payload=$(jq -c --arg ev "$GITHUB_EVENT_NAME" --arg ref "$GITHUB_REF_NAME" '{
            event: $ev,
            branch: (.pull_request.head.ref // $ref),
            title: (.pull_request.title // ""),
            body: (.pull_request.body // ""),
            pr: (.pull_request.number // null),
            url: (.pull_request.html_url // .compare // ""),
            author: (.pull_request.user.login // .pusher.name // ""),
            commits: [(.commits // [])[] | {sha: .id, message: .message, author: .author.name, email: .author.email, url: .url}]
          }' "$GITHUB_EVENT_PATH")
          out=$(curl -sS -X POST "${url}" -H "authorization: Bearer $SYNAPSE_TOKEN" -H 'content-type: application/json' --data "$payload")
          echo "$out" | jq -r '.lines[]? // .error.message? // .'
          test "$(echo "$out" | jq -r '.ok')" = "true"
`;
  const azurePipeline = `# azure-pipelines-synapse.yml — every push and pull request must name a ${key} work item.
# Add the secret pipeline variable SYNAPSE_TOKEN, and add this pipeline as a required Build validation
# in the branch policy of ${r.default_branch}.
trigger:
  branches:
    include: ['*']
pr:
  branches:
    include: ['*']
pool:
  vmImage: ubuntu-latest
steps:
  - checkout: self
    fetchDepth: 50
  - bash: |
      set -e
      case "$PR_ID" in ''|'$('*) PR_ID='' ;; esac
      if [ -n "$PR_ID" ]; then
        target="\${TARGET#refs/heads/}"
        git fetch -q origin "$target" || true
        range="origin/$target..HEAD"
        branch="\${SOURCE#refs/heads/}"
      else
        range="-1"
        branch="\${BUILD_BRANCH#refs/heads/}"
      fi
      commits=$(git log --format='%H%x1f%an%x1f%ae%x1f%B%x1e' $range | jq -Rs 'split("\\u001e") | map(select(length > 1) | split("\\u001f") | {sha: (.[0] | gsub("[[:space:]]"; "")), author: .[1], email: .[2], message: .[3]})')
      payload=$(jq -nc --arg b "$branch" --argjson c "$commits" '{event: "push", branch: $b, commits: $c}')
      out=$(curl -sS -X POST "${url}" -H "authorization: Bearer $SYNAPSE_TOKEN" -H 'content-type: application/json' --data "$payload")
      echo "$out" | jq -r '.lines[]? // .error.message? // .'
      test "$(echo "$out" | jq -r '.ok')" = "true"
    displayName: Every commit names a SanchalanOS work item
    env:
      SYNAPSE_TOKEN: $(SYNAPSE_TOKEN)
      PR_ID: $(System.PullRequest.PullRequestId)
      TARGET: $(System.PullRequest.TargetBranch)
      SOURCE: $(System.PullRequest.SourceBranch)
      BUILD_BRANCH: $(Build.SourceBranch)
`;
  const commitMsgHook = `#!/bin/sh
# SanchalanOS commit-msg hook for ${r.repo}: every commit names a work item, e.g. "${key}-12 fix map tiles".
# Install: save as .git/hooks/commit-msg and run  chmod +x .git/hooks/commit-msg
# (or for the whole team: git config core.hooksPath .githooks and commit it in .githooks/commit-msg)
msg_file="$1"
pattern='[A-Z][A-Z0-9]{1,9}-(CR-)?[0-9]+'
# merge and revert messages pass
head -1 "$msg_file" | grep -qE '^(Merge|Revert) ' && exit 0
grep -qE "$pattern" "$msg_file" && exit 0
# take the key from the branch name (feature/${key}-12-map-tiles)
branch=$(git symbolic-ref --short HEAD 2>/dev/null || git rev-parse --abbrev-ref HEAD 2>/dev/null)
key=$(printf '%s' "$branch" | grep -oE "$pattern" | head -1)
if [ -n "$key" ]; then
  printf '\\n%s\\n' "$key" >> "$msg_file"
  exit 0
fi
${allowNoKey
  ? `echo "SanchalanOS: no work item named — ${r.policy === 'auto_create' ? 'one will be created from this message (start it with feat:, fix:, cr:, chore: … to pick the type)' : 'the commit will be flagged'}."
exit 0`
  : `echo "✗ SanchalanOS: name a work item in the commit message, e.g. \\"${key}-12 fix map tiles\\" or \\"${key}-CR-3 …\\","
echo "  or commit on a branch named like feature/${key}-12-short-title."
exit 1`}
`;
  return {
    key,
    policy: r.policy,
    repo: r.repo,
    provider: r.provider,
    checkUrl: url,
    githubWorkflow,
    azurePipeline,
    commitMsgHook,
    branchExample: `feature/${key}-12-short-title`,
  };
}

/* ───────────────────────── classifying and creating ───────────────────────── */

const CR_RE = /\b([A-Z][A-Z0-9]{1,9})-CR-(\d{1,7})\b/g;
const ITEM_RE = /\b([A-Z][A-Z0-9]{1,9})-(\d{1,7})\b/g;

/** Keys in texts: work items and change requests (KEY-CR-n), case-insensitive. */
export function codeKeys(texts: string[]) {
  const items = new Map<string, { key: string; number: number }>();
  const crs = new Map<string, { key: string; number: number }>();
  for (const raw of texts) {
    let t = String(raw ?? '').toUpperCase();
    for (const m of t.matchAll(CR_RE)) crs.set(`${m[1]}-CR-${m[2]}`, { key: m[1]!, number: Number(m[2]) });
    t = t.replace(CR_RE, ' ');
    for (const m of t.matchAll(ITEM_RE)) items.set(`${m[1]}-${m[2]}`, { key: m[1]!, number: Number(m[2]) });
  }
  return { items: [...items.values()].slice(0, 20), crs: [...crs.values()].slice(0, 10) };
}

const TYPE_OF: Record<string, WorkType | 'cr'> = {
  feat: 'story', feature: 'story', story: 'story', add: 'story',
  fix: 'bug', bug: 'bug', bugfix: 'bug', hotfix: 'bug',
  epic: 'epic',
  cr: 'cr', change: 'cr', changerequest: 'cr',
  spike: 'spike', research: 'spike',
  chore: 'chore', ci: 'chore', build: 'chore', deps: 'chore',
  docs: 'task', doc: 'task', refactor: 'task', test: 'task', tests: 'task', perf: 'task', style: 'task', task: 'task',
};

/** "fix(maps)!: tiles vanish at zoom 3" → { type: bug, scope: maps, title: "Tiles vanish at zoom 3" }. */
export function classify(message: string): { type: WorkType | 'cr'; scope: string | null; title: string; body: string } {
  const [first = '', ...rest] = message.replace(/\r/g, '').split('\n');
  const body = rest.join('\n').trim();
  const m = /^\s*([a-z-]+)(?:\(([^)]{1,40})\))?!?\s*:\s*(.+)$/i.exec(first);
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  if (m) {
    const t = TYPE_OF[m[1]!.toLowerCase().replace(/-/g, '')];
    if (t) return { type: t, scope: m[2]?.trim() ?? null, title: cap(m[3]!.trim()).slice(0, 300), body };
  }
  // no prefix: guess from the words
  const l = first.toLowerCase();
  const type: WorkType = /\b(fix|fixed|fixes|bug|crash|error|broken|issue)\b/.test(l) ? 'bug' : /\b(add|adds|added|new|implement|support|feature)\b/.test(l) ? 'story' : /\b(bump|upgrade|deps?|ci|lint|format)\b/.test(l) ? 'chore' : 'task';
  return { type, scope: null, title: cap(first.trim() || 'Change from code').slice(0, 300), body };
}

export interface CodeRef {
  kind: 'commit' | 'pr';
  externalId: string;
  title: string;
  message: string; // full message / PR title + body
  texts: string[];
  author: string | null;
  authorEmail: string | null;
  url: string | null;
  branch: string | null;
  at: string | null;
  status?: string | null; // PR / link status
}

export interface CodeResult {
  ref: string;
  title: string;
  status: 'linked' | 'created' | 'missing' | 'skipped';
  keys: string[];
  created: string | null;
}

/** Links (or creates and links) one commit / PR in a repository's project. Idempotent per external id. */
export async function processCode(env: Env, tx: Tx, repo: Repo, ref: CodeRef, source: 'webhook' | 'check'): Promise<CodeResult> {
  const ctx = await systemCtxFor(env, tx, repo.tenant_id);
  if (!ctx) throw notFound();
  const project = (await tx.one<Record<string, any>>(`select * from projects where tenant_id = $1 and id = $2`, [repo.tenant_id, repo.project_id]))!;
  const key = await workKey(tx, repo.tenant_id, project);
  const short = ref.kind === 'commit' ? ref.externalId.split(':').pop()!.slice(0, 7) : ref.title.slice(0, 40);
  // claim the row first: a second delivery of the same commit waits here, then sees the first result
  const claimed = await tx.one<{ id: string }>(
    `insert into pm_code_events (tenant_id, repo_id, project_id, kind, external_id, title, author, author_email, url, branch, status, source, at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending',$11,coalesce($12::timestamptz, now())) on conflict (tenant_id, repo_id, external_id) do nothing returning id`,
    [repo.tenant_id, repo.id, repo.project_id, ref.kind, ref.externalId.slice(0, 300), ref.title.slice(0, 300) || null, ref.author?.slice(0, 200) ?? null, ref.authorEmail?.slice(0, 320) ?? null, ref.url?.slice(0, 1000) ?? null, ref.branch?.slice(0, 200) ?? null, source, ref.at],
  );
  const prev = claimed ? null : await tx.one<{ id: string; status: string; item_ids: string[]; cr_ids: string[]; created_item_id: string | null; created_cr_id: string | null }>(`select * from pm_code_events where tenant_id = $1 and repo_id = $2 and external_id = $3`, [repo.tenant_id, repo.id, ref.externalId.slice(0, 300)]);
  const eventId = claimed?.id ?? prev!.id;

  // merge commits ride on their pull request
  if (ref.kind === 'commit' && /^(Merge (pull request|branch|remote-tracking)|Merged PR \d+)/i.test(ref.message)) {
    await tx.query(`update pm_code_events set status = 'skipped' where tenant_id = $1 and id = $2 and status = 'pending'`, [repo.tenant_id, eventId]);
    return { ref: short, title: ref.title, status: 'skipped', keys: [], created: null };
  }

  const found = codeKeys(ref.texts);
  const itemIds: string[] = [];
  const crIds: string[] = [];
  const keys: string[] = [];
  for (const k of found.items) {
    const t = await tx.one<{ id: string }>(
      `select t.id from project_tasks t join projects p on p.tenant_id = t.tenant_id and p.id = t.project_id where t.tenant_id = $1 and p.work_key = $2 and t.task_number = $3 and p.deleted_at is null`,
      [repo.tenant_id, k.key, k.number],
    );
    if (t) (itemIds.push(t.id), keys.push(`${k.key}-${k.number}`));
  }
  for (const k of found.crs) {
    const c = await tx.one<{ id: string }>(
      `select c.id from change_requests c join projects p on p.tenant_id = c.tenant_id and p.id = c.project_id where c.tenant_id = $1 and p.work_key = $2 and c.cr_number = $3`,
      [repo.tenant_id, k.key, k.number],
    );
    if (c) (crIds.push(c.id), keys.push(`${k.key}-CR-${k.number}`));
  }
  // a pull request without a key of its own carries the items its branch's commits were linked to
  if (ref.kind === 'pr' && !itemIds.length && !crIds.length && ref.branch) {
    const viaCommits = await tx.query<{ item_ids: string[]; cr_ids: string[] }>(`select item_ids, cr_ids from pm_code_events where tenant_id = $1 and repo_id = $2 and kind = 'commit' and branch = $3 and status in ('linked','created')`, [repo.tenant_id, repo.id, ref.branch]);
    for (const v of viaCommits) (itemIds.push(...v.item_ids), crIds.push(...v.cr_ids));
  }
  let status: CodeResult['status'] = itemIds.length || crIds.length ? 'linked' : 'missing';
  let created: string | null = null;
  let createdItem: string | null = prev?.created_item_id ?? null;
  let createdCr: string | null = prev?.created_cr_id ?? null;
  if (status === 'missing' && (createdItem || createdCr)) {
    // already created for this commit on an earlier delivery
    if (createdItem) itemIds.push(createdItem);
    if (createdCr) crIds.push(createdCr);
    status = 'linked';
  } else if (status === 'missing' && repo.policy === 'auto_create') {
    const c = classify(ref.message || ref.title);
    const person = ref.authorEmail ? await tx.one<{ id: string }>(`select id from users where tenant_id = $1 and lower(email) = lower($2) and status = 'active'`, [repo.tenant_id, ref.authorEmail]) : null;
    const member = person ? await tx.one(`select 1 from project_members where tenant_id = $1 and project_id = $2 and user_id = $3 and role <> 'viewer'`, [repo.tenant_id, repo.project_id, person.id]) || (project.owner_id === person.id ? {} : null) : null;
    const origin = `Created automatically from ${ref.kind === 'commit' ? `commit ${short}` : 'pull request'} in ${repo.repo}${ref.author ? ` by ${ref.author}` : ''}${ref.url ? `\n${ref.url}` : ''}`;
    if (c.type === 'cr') {
      await tx.query(`select 1 from projects where tenant_id = $1 and id = $2 for update`, [repo.tenant_id, repo.project_id]);
      const cr = await tx.one<{ id: string; cr_number: number }>(
        `insert into change_requests (tenant_id, project_id, cr_number, title, description, requested_by, raised_by)
         values ($1,$2,(select coalesce(max(cr_number), 0) + 1 from change_requests where tenant_id = $1 and project_id = $2),$3,$4,$5,$6) returning id, cr_number`,
        [repo.tenant_id, repo.project_id, c.title, [c.body, origin].filter(Boolean).join('\n\n').slice(0, 20000), (ref.author ?? 'Code').slice(0, 200), person?.id ?? null],
      );
      createdCr = cr!.id;
      crIds.push(cr!.id);
      created = `${key}-CR-${cr!.cr_number}`;
    } else {
      const comp = c.scope ? await tx.one<{ id: string }>(`select id from project_components where tenant_id = $1 and project_id = $2 and lower(name) = lower($3)`, [repo.tenant_id, repo.project_id, c.scope]) : null;
      const sprint = repo.auto_sprint && c.type !== 'epic' ? await tx.one<{ id: string }>(`select id from project_sprints where tenant_id = $1 and project_id = $2 and status = 'active'`, [repo.tenant_id, repo.project_id]) : null;
      const it = await createItem(
        ctx,
        repo.project_id,
        {
          name: c.title,
          workType: c.type === 'subtask' ? 'task' : c.type,
          description: [c.body, origin].filter(Boolean).join('\n\n').slice(0, 20000),
          assignees: member && person ? [person.id] : [],
          reporterId: person?.id ?? null,
          componentIds: comp ? [comp.id] : [],
          sprintId: sprint?.id ?? null,
          tags: ['from-git'],
          priority: c.type === 'bug' ? 'high' : 'medium',
        },
        { skipRequired: true },
      );
      // created and finished in one go when the commit already landed on the default branch
      createdItem = it.id;
      itemIds.push(it.id);
      created = it.key;
    }
    keys.push(created);
    status = 'created';
  }

  // the code links on the items / change requests
  const kind = ref.kind === 'commit' ? 'commit' : 'pr';
  const src = repo.provider === 'github' ? 'github' : 'azure';
  if (ref.url && /^https?:\/\//.test(ref.url)) {
    for (const tid of itemIds)
      await tx.query(
        `insert into project_task_links (tenant_id, task_id, kind, url, title, status, source, external_id, author, repo, occurred_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,coalesce($11::timestamptz, now()))
         on conflict (tenant_id, task_id, external_id) where external_id is not null do update set status = coalesce(excluded.status, project_task_links.status), title = excluded.title`,
        [repo.tenant_id, tid, kind, ref.url, ref.title.slice(0, 300) || null, ref.status ?? null, src, ref.externalId.slice(0, 300), ref.author?.slice(0, 200) ?? null, repo.repo, ref.at],
      );
    for (const cid of crIds)
      await tx.query(
        `insert into project_task_links (tenant_id, change_request_id, kind, url, title, status, source, external_id, author, repo, occurred_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,coalesce($11::timestamptz, now()))
         on conflict (tenant_id, change_request_id, external_id) where external_id is not null and change_request_id is not null do update set status = coalesce(excluded.status, project_task_links.status), title = excluded.title`,
        [repo.tenant_id, cid, kind, ref.url, ref.title.slice(0, 300) || null, ref.status ?? null, src, ref.externalId.slice(0, 300), ref.author?.slice(0, 200) ?? null, repo.repo, ref.at],
      );
  }
  // the keys of everything it is linked to
  const named = await tx.query<{ k: string }>(
    `select p.work_key || '-' || t.task_number as k from project_tasks t join projects p on p.tenant_id = t.tenant_id and p.id = t.project_id where t.tenant_id = $1 and t.id = any($2::uuid[])
     union all select p.work_key || '-CR-' || c.cr_number from change_requests c join projects p on p.tenant_id = c.tenant_id and p.id = c.project_id where c.tenant_id = $1 and c.id = any($3::uuid[])`,
    [repo.tenant_id, [...new Set(itemIds)], [...new Set(crIds)]],
  );
  keys.splice(0, keys.length, ...named.map((n) => n.k));
  await tx.query(
    `update pm_code_events set status = case when $3 = 'linked' and created_item_id is not null or $3 = 'linked' and created_cr_id is not null then 'created' else $3 end, item_ids = $4, cr_ids = $5, created_item_id = $6, created_cr_id = $7, title = coalesce($8, title), url = coalesce($9, url) where tenant_id = $1 and id = $2`,
    [repo.tenant_id, eventId, status, [...new Set(itemIds)], [...new Set(crIds)], createdItem, createdCr, ref.title.slice(0, 300) || null, ref.url?.slice(0, 1000) ?? null],
  );
  return { ref: short, title: ref.title, status, keys: [...new Set(keys)], created };
}

/** A commit / PR recorded without a work item: link it to one by key, or create one from it. */
export async function resolveMissing(ctx: RecordCtx, env: Env, projectId: string, eventId: string, input: { key?: string | null; create?: boolean }) {
  await projectAccess(ctx, projectId, 'member');
  const e = await ctx.tx.one<Record<string, any>>(`select e.*, r.provider, r.repo from pm_code_events e join project_repos r on r.tenant_id = e.tenant_id and r.id = e.repo_id where e.tenant_id = $1 and e.id = $2 and e.project_id = $3`, [ctx.tenantId, eventId, projectId]);
  if (!e) throw notFound('Not found');
  const repo = (await ctx.tx.one<Repo>(`select * from project_repos where tenant_id = $1 and id = $2`, [ctx.tenantId, e.repo_id]))!;
  if (input.key) {
    const f = await findByKey(ctx, input.key, projectId);
    const cr = !f && /-CR-\d+$/i.test(input.key) ? codeKeys([input.key]).crs[0] : null;
    if (!f && !cr) throw badRequest(`No work item ${input.key}`);
  }
  // reprocess with the key added to the texts (or as auto-create)
  await ctx.tx.query(`update pm_code_events set status = 'pending' where tenant_id = $1 and id = $2`, [ctx.tenantId, eventId]);
  const r = await processCode(env, ctx.tx, input.create ? { ...repo, policy: 'auto_create' } : repo, {
    kind: e.kind, externalId: e.external_id, title: e.title ?? '', message: e.title ?? '', texts: [e.title ?? '', input.key ?? ''], author: e.author, authorEmail: e.author_email, url: e.url, branch: e.branch, at: e.at,
  }, 'check');
  if (r.status === 'missing') throw badRequest('Could not link it');
  return r;
}

/* ───────────────────────── the CI check ───────────────────────── */

export interface CheckBody {
  event?: string;
  branch?: string | null;
  title?: string | null;
  body?: string | null;
  pr?: number | null;
  url?: string | null;
  author?: string | null;
  commits?: { sha: string; message: string; author?: string | null; email?: string | null; url?: string | null }[];
}

export async function repoByToken(db: Db, route: { tenant_id: string; target_id: string }, secret: string) {
  const r = await db.tx({ tenantId: route.tenant_id, readOnly: true }, (tx) => tx.one<Repo>(`select * from project_repos where tenant_id = $1 and id = $2`, [route.tenant_id, route.target_id]));
  if (!r || !timingSafeEqual(r.secret_hash, await sha256Hex(secret))) return null;
  return r;
}

/** Runs the policy over a push (its commits) or a pull request (title, body, branch). */
export async function runCheck(env: Env, db: Db, repo: Repo, b: CheckBody) {
  const refs: CodeRef[] = [];
  const web = (path: string) => (repo.provider === 'github' ? `https://github.com/${repo.repo}/${path}` : null);
  if (b.pr) {
    refs.push({
      kind: 'pr', externalId: `${repo.provider === 'github' ? 'gh' : 'az'}:pr:${repo.repo}#${b.pr}`, title: (b.title ?? '').slice(0, 300), message: [b.title ?? '', b.body ?? ''].join('\n'),
      texts: [b.title ?? '', b.body ?? '', b.branch ?? ''], author: b.author ?? null, authorEmail: null, url: b.url || web(`pull/${b.pr}`), branch: b.branch ?? null, at: null, status: 'open',
    });
  }
  for (const c of (b.commits ?? []).slice(0, 100)) {
    if (!/^[0-9a-f]{7,64}$/i.test(c.sha)) continue;
    refs.push({
      kind: 'commit', externalId: `${repo.provider === 'github' ? 'gh' : 'az'}:commit:${c.sha.toLowerCase()}`, title: (c.message ?? '').split('\n')[0]!.slice(0, 300), message: c.message ?? '',
      texts: [c.message ?? '', b.branch ?? ''], author: c.author ?? null, authorEmail: c.email ?? null, url: c.url || web(`commit/${c.sha}`), branch: b.branch ?? null, at: null,
    });
  }
  if (repo.policy === 'off') return { ok: true, policy: repo.policy, results: [], lines: ['SanchalanOS: the work item policy is off for this repository.'] };
  const results = await db.tx({ tenantId: repo.tenant_id }, async (tx) => {
    const out: CodeResult[] = [];
    for (const r of refs) out.push(await processCode(env, tx, repo, r, 'check'));
    await tx.query(`update project_repos set last_check_at = now() where tenant_id = $1 and id = $2`, [repo.tenant_id, repo.id]);
    return out;
  });
  const missing = results.filter((r) => r.status === 'missing');
  const ok = repo.policy !== 'enforce' || !missing.length;
  const key = await db.tx({ tenantId: repo.tenant_id, readOnly: true }, async (tx) => (await tx.one<{ work_key: string | null }>(`select work_key from projects where tenant_id = $1 and id = $2`, [repo.tenant_id, repo.project_id]))?.work_key ?? 'KEY');
  const lines = [
    ...results.map((r) => `${r.status === 'linked' ? '✓' : r.status === 'created' ? '＋' : r.status === 'skipped' ? '·' : '✗'} ${r.ref} ${r.title}${r.keys.length ? `  → ${r.keys.join(', ')}` : ''}${r.status === 'created' ? ' (created)' : ''}`),
    ...(missing.length
      ? [repo.policy === 'enforce' ? `✗ ${missing.length} without a work item. Name one in the message (e.g. "${key}-12 …" or "${key}-CR-3 …"), or use a branch like feature/${key}-12-…, then amend or push again.` : `! ${missing.length} without a work item (recorded in SanchalanOS).`]
      : ['✓ Every commit and pull request is linked to a SanchalanOS work item.']),
  ];
  return { ok, policy: repo.policy, results, lines };
}
